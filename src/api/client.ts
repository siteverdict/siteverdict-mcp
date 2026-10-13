import { randomUUID } from 'node:crypto';
import type { ActorRunner, FetchLike, FetchResultsRequest, RunRequest, RunResult } from '../apify/runner.js';
import { ApifyError, AuthError, CancelledError, UserInputError, redact } from '../lib/errors.js';
import { sanitiseApiBody } from './bodies.js';

/**
 * SiteVerdict API backend (API-CONTRACT.md v1.1, products/siteverdict-api/openapi.yaml).
 *   POST /v1/scan/{tool}   -> 200 result, or 202 {job_id} when the scan outlives the sync window
 *   POST /v1/jobs/{tool}   -> 202 {job_id} (batch with urls[])
 *   GET  /v1/jobs/{job_id} -> {status: queued|running|succeeded|failed|cancelled, result?, error?}
 * Auth: X-API-Key: sv_live_... / sv_test_... (the caller's own key). Errors: {"error":{"code","message"}}.
 * Used instead of Apify when SITEVERDICT_BACKEND=api (or auto + caller has an sv_ key) and the tool has an API id.
 */
export interface ApiFinding {
  id?: string;
  severity?: string;
  title?: string;
  detail?: string;
  fix?: string;
  category?: string;
  evidence?: string[];
  [k: string]: unknown;
}

export interface ApiScanResult {
  tool?: string;
  url?: string;
  final_url?: string | null;
  score?: number | null;
  grade?: string | null;
  summary?: string;
  findings?: ApiFinding[];
  data?: unknown;
  disclaimer?: string;
  credits_used?: number;
  request_id?: string;
  cached?: boolean;
  backend?: string;
  duration_ms?: number;
  scanned_at?: string;
  test_mode?: boolean;
}

export interface ApiBatchResult {
  tool?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  items?: { url?: string; ok?: boolean; result?: ApiScanResult; error?: { code?: string; message?: string } }[];
}

export type ApiJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ApiJob {
  job_id: string;
  status: ApiJobStatus;
  tool?: string;
  url?: string;
  targets?: string[];
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  credits_reserved?: number;
  credits_used?: number;
  poll_url?: string;
  result?: ApiScanResult | ApiBatchResult;
  error?: { code?: string; message?: string };
}

type Obj = Record<string, unknown>;

/** Max targets per batch job (API default SV_BATCH_MAX). */
export const API_BATCH_MAX = 50;
const SYNC_WINDOW_SECS = 55;
const MAX_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 20_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError('Cancelled'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new CancelledError('Cancelled')); }, { once: true });
  });

/** Strip trailing slashes and a trailing /v1 so both "https://api.webrevenuescan.com" and ".../v1" work. */
export function normaliseApiBase(base: string): string {
  return base.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Scalar-only metrics from the tool-specific `data` (top level + one nested level), bounded so results stay small. */
export function flattenMetrics(data: unknown, max = 40): Obj {
  const out: Obj = {};
  if (!isObj(data)) return out;
  const put = (k: string, v: unknown) => {
    if (Object.keys(out).length >= max) return;
    if (typeof v === 'string' && v.length > 200) return;
    out[k] = v;
  };
  for (const [k, v] of Object.entries(data)) if (isScalar(v)) put(k, v);
  for (const [k, v] of Object.entries(data)) {
    if (!isObj(v)) continue;
    for (const [k2, v2] of Object.entries(v)) if (isScalar(v2)) put(`${k}.${k2}`, v2);
  }
  return out;
}

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function hostOf(u: unknown): string | undefined {
  try {
    return new URL(String(u)).hostname;
  } catch {
    return undefined;
  }
}

/** Converts one API result of a data tool (tech-stack, web-to-markdown) into the camelCase Actor-like item the tool's shape() reads. */
export function apiResultToDataItem(r: ApiScanResult): Obj {
  const d = isObj(r.data) ? r.data : {};
  const item: Obj = {};
  for (const [k, v] of Object.entries(d)) item[camel(k)] = v;
  const url = r.final_url || r.url;
  item.url = url;
  item.domain = hostOf(url);
  item.status = 'ok';
  if (r.scanned_at) item.checkedAt = r.scanned_at;
  if (r.summary) item.summary = r.summary;
  if (r.tool === 'web-to-markdown') {
    item.citation = {
      title: d.title ?? null,
      url: d.canonical_url || url,
      siteName: d.site_name ?? hostOf(url) ?? null,
      author: d.author ?? null,
      publishedAt: d.published_at ?? null,
      accessedAt: r.scanned_at ?? new Date().toISOString(),
    };
  }
  if (r.test_mode) item.isSampleData = true;
  return item;
}

function failedItem(url: string | undefined, err: { code?: string; message?: string } | undefined): Obj {
  const code = err?.code ?? 'error';
  const blocked = ['target_blocked', 'robots_disallowed'].includes(code);
  return {
    url,
    domain: hostOf(url),
    status: blocked ? 'blocked' : 'error',
    ...(blocked ? { blockedReason: err?.message ?? code } : {}),
    error: `${code}: ${err?.message ?? 'scan failed'}`,
  };
}

const isBatch = (r: unknown): r is ApiBatchResult => isObj(r) && Array.isArray((r as ApiBatchResult).items) && typeof (r as ApiBatchResult).total === 'number';

/** Converts an API result (single or batch) into Actor-like dataset items so the same report/normalisation code applies. */
export function apiResultToItems(r: ApiScanResult | ApiBatchResult, kind: 'check' | 'data'): unknown[] {
  if (isBatch(r)) {
    return (r.items ?? []).flatMap((i) => (i.ok && i.result ? apiResultToItems(i.result, kind) : kind === 'data' ? [failedItem(i.url, i.error)] : []));
  }
  const s = r as ApiScanResult;
  if (kind === 'data') return [apiResultToDataItem(s)];
  const summary = {
    type: 'summary',
    url: s.final_url || s.url,
    score: s.score ?? undefined,
    grade: s.grade ?? undefined,
    summary: s.summary,
    metrics: flattenMetrics(s.data),
    ...(s.test_mode ? { isSampleData: true } : {}),
  };
  const findings = (s.findings ?? []).map((f) => ({
    type: 'finding',
    id: f.id,
    severity: f.severity,
    title: f.title,
    detail: f.detail,
    fix: f.fix,
    category: f.category,
    ...(Array.isArray(f.evidence) && f.evidence.length ? { evidence: f.evidence.slice(0, 5) } : {}),
  }));
  return [summary, ...findings];
}

/** Turns an API error response into a user-facing error. 422 / 504 / 503 scans are never charged. */
export function apiError(status: number, body: unknown): ApifyError | UserInputError | AuthError {
  const e = isObj(body) && isObj(body.error) ? (body.error as { code?: string; message?: string }) : {};
  const code = e.code ?? `http_${status}`;
  const msg = redact(e.message ?? `HTTP ${status}`);
  switch (status) {
    case 400:
    case 413:
    case 415:
      return new UserInputError(`The SiteVerdict API rejected the request (${status} ${code}): ${msg}`);
    case 401:
      return new AuthError(`The SiteVerdict API rejected the API key (401): ${msg}`);
    case 402:
      return new ApifyError(`SiteVerdict API: out of credits (402): ${msg}`, 402);
    case 403:
      return new AuthError(`The SiteVerdict API refused this request (403 ${code}): ${msg}`);
    case 404:
      return new ApifyError(`SiteVerdict API: not found (${code}): ${msg}`, 404);
    case 409:
      return new ApifyError(`SiteVerdict API: duplicate request (${code}): ${msg}`, 409, code === 'idempotency_in_progress');
    case 422:
      return new ApifyError(`The site could not be scanned (${code}): ${msg}. Nothing was charged.`, 422);
    case 429:
      return new ApifyError(`SiteVerdict API rate limit (429 ${code}): ${msg}. Retry shortly.`, 429, true);
    case 503:
      return new ApifyError(`SiteVerdict API is busy (503 ${code}): ${msg}. Retry in a minute; nothing was charged.`, 503, true);
    case 504:
      return new ApifyError(`The scan timed out (504 ${code}): ${msg}. Nothing was charged.`, 504);
    default:
      return new ApifyError(`SiteVerdict API error ${status} (${code}): ${msg}`, status, status >= 500);
  }
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  const ra = Number(raw);
  if (raw !== null && Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, MAX_RETRY_WAIT_MS);
  const reset = Number(res.headers.get('x-ratelimit-reset')); // Unix epoch seconds
  if (res.status === 429 && Number.isFinite(reset) && reset > 0) {
    const ms = reset * 1000 - Date.now();
    if (ms > 0) return Math.min(ms, MAX_RETRY_WAIT_MS);
  }
  return undefined;
}

/** Legacy run ids were "job_" + job_id ("job_job_..."); the API job id itself starts with "job_". */
export function jobIdFromRunId(runId: string): string {
  if (runId.startsWith('job_job_')) return runId.slice(4);
  return runId.startsWith('job_') ? runId : `job_${runId}`;
}

type RetryableErr = Error & { retryAfterMs?: number };

export class SiteVerdictApiRunner implements ActorRunner {
  readonly dryRun = false;
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly userAgent = 'siteverdict-mcp',
    private readonly pollMs = 3000,
  ) {
    this.baseUrl = normaliseApiBase(baseUrl);
  }

  /** One HTTP call; returns status + parsed JSON or throws a mapped error. Network errors become retryable ApifyErrors. */
  private async once<T>(method: string, path: string, key: string, signal: AbortSignal, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: T }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal,
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': this.userAgent, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (signal.aborted) throw new CancelledError('Cancelled');
      throw new ApifyError(`Could not reach the SiteVerdict API: ${redact(String((err as Error).message ?? err))}`, undefined, true);
    }
    let json: unknown = null;
    try { json = await res.json(); } catch { /* empty body */ }
    if (res.ok) return { status: res.status, json: json as T };
    const err: RetryableErr = apiError(res.status, json);
    err.retryAfterMs = retryAfterMs(res);
    throw err;
  }

  /** POST with one Idempotency-Key reused across retries (never charged twice); retries 429/503/409-in-progress/network within the deadline. */
  private async post<T>(path: string, key: string, body: Obj, signal: AbortSignal, deadline: number): Promise<{ status: number; json: T }> {
    const headers = { 'Idempotency-Key': `mcp-${randomUUID()}` };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>('POST', path, key, signal, body, headers);
      } catch (err) {
        if (!(err instanceof ApifyError) || !err.retryable) throw err;
        const wait = (err as RetryableErr).retryAfterMs ?? Math.min(1000 * 2 ** attempt, MAX_RETRY_WAIT_MS);
        if (attempt >= MAX_ATTEMPTS - 1 || Date.now() + wait > deadline) throw err;
        await sleep(wait, signal);
      }
    }
  }

  async run(req: RunRequest): Promise<RunResult> {
    if (!req.api) throw new ApifyError('This tool is not available on the SiteVerdict API backend.');
    const { tool, kind } = req.api;
    const key = req.apiKey ?? '';
    const started = new Date().toISOString();
    const deadline = Date.now() + Math.max(1, req.waitSecs) * 1000;
    const { urls: rawUrls, ...rest } = req.api.body;
    const urls = Array.isArray(rawUrls) ? rawUrls.map(String) : [];
    req.onProgress?.(0, 100, `SiteVerdict API: ${tool}`);

    if (urls.length > 1) {
      if (urls.length > API_BATCH_MAX) throw new UserInputError(`The SiteVerdict API takes at most ${API_BATCH_MAX} URLs per call (got ${urls.length}). Split the list.`);
      const { url: _single, ...options } = rest;
      void _single;
      const body = sanitiseApiBody(tool, { ...options, urls }, { batch: true });
      const { json } = await this.post<ApiJob>(`/v1/jobs/${encodeURIComponent(tool)}`, key, body, req.signal, deadline);
      return this.pollJob(json.job_id, key, req, kind, started, deadline);
    }

    const single: Obj = { ...rest };
    if (single.url === undefined && single.domain === undefined && urls[0]) single.url = urls[0];
    const remainingSecs = Math.floor((deadline - Date.now()) / 1000);
    const body = sanitiseApiBody(tool, { ...single, timeout_secs: Math.max(1, Math.min(SYNC_WINDOW_SECS, remainingSecs - 2)) });
    const { status, json } = await this.post<ApiScanResult & { job_id?: string }>(`/v1/scan/${encodeURIComponent(tool)}`, key, body, req.signal, deadline);
    if (status === 202 && json?.job_id) return this.pollJob(json.job_id, key, req, kind, started, deadline);
    req.onProgress?.(100, 100, 'SiteVerdict API: done');
    return { actorId: `siteverdict-api/${tool}`, runId: json?.request_id, status: 'SUCCEEDED', items: apiResultToItems(json ?? {}, kind), startedAt: started, finishedAt: new Date().toISOString(), dryRun: false };
  }

  private jobToRun(job: ApiJob, tool: string, kind: 'check' | 'data', started?: string): RunResult | null {
    const base = { actorId: `siteverdict-api/${job.tool ?? tool}`, runId: job.job_id, startedAt: job.started_at ?? started, dryRun: false };
    if (job.status === 'succeeded') {
      return { ...base, status: 'SUCCEEDED', items: apiResultToItems(job.result ?? {}, kind), finishedAt: job.finished_at ?? new Date().toISOString() };
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      const why = job.error ? `${job.error.code ?? 'failed'}${job.error.message ? `: ${redact(job.error.message)}` : ''}` : `job ${job.status}`;
      return { ...base, status: job.status === 'failed' ? 'FAILED' : 'ABORTED', items: [], statusMessage: `${why} (failed scans are not charged)`, finishedAt: job.finished_at ?? undefined };
    }
    return null;
  }

  private async pollJob(jobId: string, key: string, req: RunRequest, kind: 'check' | 'data', started: string, deadline: number): Promise<RunResult> {
    const tool = req.api!.tool;
    let lastStatus = 'queued';
    while (Date.now() < deadline) {
      await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())), req.signal);
      let job: ApiJob;
      try {
        job = (await this.once<ApiJob>('GET', `/v1/jobs/${encodeURIComponent(jobId)}`, key, req.signal)).json;
      } catch (err) {
        if (err instanceof ApifyError && err.retryable) continue; // transient while polling: keep trying until the deadline
        throw err;
      }
      lastStatus = job.status;
      const done = this.jobToRun(job, tool, kind, started);
      if (done) {
        req.onProgress?.(100, 100, `SiteVerdict API job ${jobId}: ${job.status}`);
        return done;
      }
      req.onProgress?.(50, 100, `SiteVerdict API job ${jobId}: ${job.status}`);
    }
    return { actorId: `siteverdict-api/${tool}`, runId: jobId, status: 'RUNNING', items: [], startedAt: started, statusMessage: `job ${lastStatus}`, dryRun: false };
  }

  async fetchRun(req: FetchResultsRequest): Promise<RunResult> {
    const jobId = jobIdFromRunId(req.runId);
    const { json } = await this.once<ApiJob>('GET', `/v1/jobs/${encodeURIComponent(jobId)}`, req.apiKey ?? '', req.signal);
    const tool = json.tool ?? 'unknown';
    return this.jobToRun(json, tool, req.kind ?? 'data') ?? { actorId: `siteverdict-api/${tool}`, runId: json.job_id ?? jobId, status: 'RUNNING', items: [], dryRun: false };
  }
}
