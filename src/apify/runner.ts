import { ApifyError, AuthError, CancelledError, redact } from '../lib/errors.js';

export interface ProgressFn {
  (progress: number, total: number | undefined, message: string): void;
}

export interface RunRequest {
  actorId: string;
  input: Record<string, unknown>;
  token: string;
  /** How long this call waits before returning status RUNNING (the run itself keeps going). */
  waitSecs: number;
  /** Apify-side hard timeout for the run. */
  runTimeoutSecs: number;
  memoryMbytes?: number;
  /** Pay-per-event spend cap forwarded to Apify (maxTotalChargeUsd). */
  maxTotalChargeUsd?: number;
  signal: AbortSignal;
  onProgress?: ProgressFn;
  /** SiteVerdict API backend only: tool id + request body + how to read the result. */
  api?: { tool: string; body: Record<string, unknown>; kind: 'check' | 'data' };
  /** SiteVerdict API key (API backend only). */
  apiKey?: string;
}

export interface RunResult {
  actorId: string;
  runId?: string;
  status: string;
  items: unknown[];
  datasetId?: string;
  keyValueStoreId?: string;
  reportUrl?: string;
  datasetUrl?: string;
  consoleUrl?: string;
  startedAt?: string;
  finishedAt?: string;
  usageTotalUsd?: number;
  dryRun: boolean;
  statusMessage?: string;
}

export interface FetchResultsRequest {
  runId: string;
  token: string;
  signal: AbortSignal;
  apiKey?: string;
  kind?: 'check' | 'data';
}

export interface ActorRunner {
  readonly dryRun: boolean;
  run(req: RunRequest): Promise<RunResult>;
  /** Fetches the current state + items of an existing run (used by get_audit_results). */
  fetchRun(req: FetchResultsRequest): Promise<RunResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const MAX_ITEMS = 1000;

interface ApifyRun {
  id: string;
  actId?: string;
  status: string;
  statusMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  defaultDatasetId?: string;
  defaultKeyValueStoreId?: string;
  usageTotalUsd?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError('Cancelled'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError('Cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Talks to the Apify REST API v2 with the caller's token (Authorization: Bearer).
 * Flow: POST /v2/acts/{id}/runs  →  GET /v2/actor-runs/{runId}?waitForFinish=N (long-poll)
 *       →  GET /v2/datasets/{id}/items. Client cancellation aborts the run so the user stops paying.
 * The wait deadline does NOT abort the run: the caller gets status RUNNING + runId and can
 * collect results later with get_audit_results.
 */
export class ApifyHttpRunner implements ActorRunner {
  readonly dryRun = false;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly pollSecs = 20,
    private readonly userAgent = 'siteverdict-mcp',
  ) {}

  private async call<T>(method: string, path: string, token: string, signal: AbortSignal, body?: unknown, attempt = 0, raw = false): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (signal.aborted) throw new CancelledError('Cancelled');
      if (attempt < 2 && method === 'GET') {
        await sleep(500 * 2 ** attempt, signal);
        return this.call(method, path, token, signal, body, attempt + 1, raw);
      }
      throw new ApifyError(`Could not reach the Apify API: ${redact(String((err as Error).message ?? err))}`, undefined, true);
    }
    if (res.ok) {
      const json = (await res.json()) as unknown;
      return (raw ? json : (json as { data: T }).data) as T;
    }
    let message = `Apify API error ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string; type?: string } };
      if (j.error?.message) message = `${message}: ${j.error.message}`;
    } catch {
      /* ignore */
    }
    message = redact(message);
    if ((res.status === 429 || res.status >= 500) && attempt < 2 && method === 'GET') {
      await sleep(1000 * 2 ** attempt, signal);
      return this.call(method, path, token, signal, body, attempt + 1, raw);
    }
    if (res.status === 401) throw new AuthError('Apify rejected the token (401). Check APIFY_TOKEN at https://console.apify.com/settings/integrations');
    if (res.status === 402) throw new ApifyError(`${message}. Your Apify account needs credit or a paid plan for this run.`, 402);
    if (res.status === 403) throw new ApifyError(`${message}. The token is not allowed to run this Actor (check token scopes / Actor permissions).`, 403);
    if (res.status === 404) throw new ApifyError(`${message}. Actor or run not found. If the Actor is not published yet, set SITEVERDICT_ACTOR_* env vars or use SITEVERDICT_DRY_RUN=1.`, 404);
    if (res.status === 429) throw new ApifyError(`${message}. Apify rate limit; retry shortly.`, 429, true);
    throw new ApifyError(message, res.status, res.status >= 500);
  }

  private toResult(actorId: string, run: ApifyRun, items: unknown[]): RunResult {
    return {
      actorId,
      runId: run.id,
      status: run.status,
      statusMessage: run.statusMessage,
      items,
      datasetId: run.defaultDatasetId,
      keyValueStoreId: run.defaultKeyValueStoreId,
      reportUrl: run.defaultKeyValueStoreId ? `${this.baseUrl}/v2/key-value-stores/${run.defaultKeyValueStoreId}/records/OUTPUT` : undefined,
      datasetUrl: run.defaultDatasetId ? `${this.baseUrl}/v2/datasets/${run.defaultDatasetId}/items?clean=true&format=json` : undefined,
      consoleUrl: `https://console.apify.com/view/runs/${run.id}`,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      usageTotalUsd: run.usageTotalUsd,
      dryRun: false,
    };
  }

  private async items(run: ApifyRun, token: string, signal: AbortSignal): Promise<unknown[]> {
    if (!run.defaultDatasetId || run.status !== 'SUCCEEDED') return [];
    // The dataset items endpoint returns a bare JSON array (no {data} envelope).
    const arr = await this.call<unknown>('GET', `/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&format=json&limit=${MAX_ITEMS}`, token, signal, undefined, 0, true);
    return Array.isArray(arr) ? arr : [];
  }

  async run(req: RunRequest): Promise<RunResult> {
    const { actorId, token, signal } = req;
    const qs = new URLSearchParams({ timeout: String(Math.round(req.runTimeoutSecs)) });
    if (req.memoryMbytes) qs.set('memory', String(req.memoryMbytes));
    if (req.maxTotalChargeUsd !== undefined) qs.set('maxTotalChargeUsd', String(req.maxTotalChargeUsd));
    const actorPath = encodeURIComponent(actorId.replace('/', '~'));
    req.onProgress?.(0, 100, `Starting Apify Actor ${actorId}`);
    let run = await this.call<ApifyRun>('POST', `/v2/acts/${actorPath}/runs?${qs.toString()}`, token, signal, req.input);
    const deadline = Date.now() + req.waitSecs * 1000;
    let tick = 0;
    try {
      while (!TERMINAL.has(run.status)) {
        const remaining = Math.floor((deadline - Date.now()) / 1000);
        if (remaining <= 0) break;
        tick++;
        const pct = Math.min(95, Math.round(((req.waitSecs - remaining) / req.waitSecs) * 100));
        req.onProgress?.(pct, 100, `Actor run ${run.id} ${run.status.toLowerCase()}${run.statusMessage ? `: ${run.statusMessage}` : ''}`);
        const wait = Math.max(1, Math.min(this.pollSecs, remaining));
        run = await this.call<ApifyRun>('GET', `/v2/actor-runs/${encodeURIComponent(run.id)}?waitForFinish=${wait}`, token, signal);
        if (tick > 10_000) break;
      }
    } catch (err) {
      if (err instanceof CancelledError || signal.aborted) {
        await this.abort(run.id, token);
        throw new CancelledError(`Cancelled; Apify run ${run.id} was aborted so it stops charging.`);
      }
      throw err;
    }
    const items = await this.items(run, token, signal);
    req.onProgress?.(100, 100, `Actor run ${run.id} ${run.status}`);
    return this.toResult(actorId, run, items);
  }

  async fetchRun(req: FetchResultsRequest): Promise<RunResult> {
    const run = await this.call<ApifyRun>('GET', `/v2/actor-runs/${encodeURIComponent(req.runId)}`, req.token, req.signal);
    const items = await this.items(run, req.token, req.signal);
    return this.toResult(run.actId ?? 'unknown', run, items);
  }

  private async abort(runId: string, token: string): Promise<void> {
    try {
      await this.call('POST', `/v2/actor-runs/${encodeURIComponent(runId)}/abort`, token, AbortSignal.timeout(10_000));
    } catch {
      /* best effort */
    }
  }
}
