import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { apiBodyForCheck, API_ALLOWED_FIELDS, API_COMMON_FIELDS, sanitiseApiBody } from '../src/api/bodies.js';
import { apiResultToItems, jobIdFromRunId, normaliseApiBase, SiteVerdictApiRunner } from '../src/api/client.js';
import { MockRunner } from '../src/apify/mock.js';
import type { RunRequest } from '../src/apify/runner.js';
import { ACTORS } from '../src/actors.js';
import { CHECK_KEYS, loadConfig, type CheckKey } from '../src/config.js';
import { ClientLimiter } from '../src/lib/rateLimit.js';
import { CheckReportSchema } from '../src/report.js';
import { createServer } from '../src/server.js';
import { DATA_TOOL_BY_NAME } from '../src/tools/catalog/index.js';
import { DataResultSchema } from '../src/tools/types.js';

/* Fake SiteVerdict API v1.1 (openapi.yaml): records requests, answers from a per-test handler. */
type Call = { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };
function fakeApi(handler: (c: Call, n: number) => { status: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const u = new URL(input);
    const c: Call = { method: init?.method ?? 'GET', path: u.pathname, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = handler(c, calls.length);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  };
  return { calls, fetchImpl };
}

const scanResult = (tool: string, extra: Record<string, unknown> = {}) => ({
  tool, url: 'https://example.com/', final_url: 'https://example.com/', score: 80, grade: 'B', summary: `${tool} ok`,
  findings: [{ id: 'region', severity: 'medium', title: 'Content not in landmarks', detail: 'd', fix: 'f', category: 'best-practice', evidence: ['main'] }],
  data: { violations: 1, nested: { a: 1, deep: { x: 1 } }, list: [1, 2, 3] }, credits_used: 1, request_id: 'req_1', cached: false, backend: 'inprocess', duration_ms: 10, scanned_at: '2026-10-11T00:00:00Z', ...extra,
});
const jobAccepted = (id = 'job_AAAAAAAAAAAAAAAAAAAA', status = 'running') => ({ job_id: id, status, tool: 'accessibility', url: 'https://example.com/', credits_reserved: 1, credits_used: 0, poll_url: `/v1/jobs/${id}` });

function req(over: Partial<RunRequest> & { api: RunRequest['api'] }): RunRequest {
  return { actorId: 'x', input: {}, token: '', apiKey: 'sv_test_abcdefgh12345', waitSecs: 30, runTimeoutSecs: 60, signal: new AbortController().signal, ...over };
}

test('apiBodyForCheck maps MCP args to spec fields only, per check', () => {
  const toolFor: Record<CheckKey, string> = { tracking_consent: 'consent-tracking', speed_revenue: 'speed', accessibility: 'accessibility', domain_email: 'domain-health', ai_search: 'ai-readiness' };
  const full: Record<CheckKey, Record<string, unknown>> = {
    tracking_consent: { url: 'https://example.com', scanMode: 'quick', internalPages: 9, locale: 'de-DE', timezoneId: 'Europe/Berlin', maxCostUsd: 1, waitSecs: 60 },
    speed_revenue: { url: 'https://example.com', device: 'desktop', maxPages: 5, monthlyVisitors: 1000, averageOrderValue: 50, conversionRatePct: 2, currency: 'GBP' },
    accessibility: { url: 'https://example.com', maxPages: 5, wcagLevel: 'AAA', includeBestPractices: true },
    domain_email: { domain: 'example.com', dkimSelectors: ['google'] },
    ai_search: { url: 'https://example.com', maxPages: 5 },
  };
  for (const k of CHECK_KEYS) {
    const target = k === 'domain_email' ? 'example.com' : 'https://example.com/';
    const parsed = ACTORS[k].inputSchema.parse(full[k]) as Record<string, unknown>;
    const body = apiBodyForCheck(k, target, parsed);
    const allowed = new Set([...API_ALLOWED_FIELDS[toolFor[k]]!, ...API_COMMON_FIELDS]);
    for (const f of Object.keys(body)) assert.ok(allowed.has(f), `${k}: unexpected field ${f}`);
  }
  assert.deepEqual(apiBodyForCheck('tracking_consent', 'https://example.com/', full.tracking_consent), { url: 'https://example.com/', scan_mode: 'quick', internal_pages: 3, locale: 'de-DE', timezone: 'Europe/Berlin' });
  assert.deepEqual(apiBodyForCheck('speed_revenue', 'https://example.com/', full.speed_revenue), { url: 'https://example.com/', devices: 'desktop', monthly_visitors: 1000, average_order_value: 50, conversion_rate_pct: 2, currency: 'GBP' });
  assert.deepEqual(apiBodyForCheck('domain_email', 'example.com', full.domain_email), { domain: 'example.com', dkim_selectors: ['google'] });
  assert.deepEqual(apiBodyForCheck('ai_search', 'https://example.com/', full.ai_search), { url: 'https://example.com/' });
  assert.deepEqual(sanitiseApiBody('speed', { url: 'u', maxPages: 3, devices: 'mobile', timeout_secs: 5 }), { url: 'u', devices: 'mobile', timeout_secs: 5 });
  assert.deepEqual(sanitiseApiBody('tech-stack', { urls: ['a', 'b'], check_dns: true, timeout_secs: 5, mode: 'http' }, { batch: true }), { urls: ['a', 'b'], check_dns: true });
});

test('data tool apiBody sends spec fields; web-to-markdown crawl is refused clearly', () => {
  const ts = DATA_TOOL_BY_NAME.detect_tech_stack!;
  const b = ts.apiBody!(ts.inputSchema.parse({ urls: ['https://example.com/'] }) as Record<string, unknown>);
  for (const k of Object.keys(b)) assert.ok(['url', 'urls', 'check_dns', 'check_tls', 'min_confidence', 'include_evidence'].includes(k), k);
  const md = DATA_TOOL_BY_NAME.fetch_clean_markdown!;
  const mb = md.apiBody!(md.inputSchema.parse({ urls: ['https://example.com/'] }) as Record<string, unknown>);
  for (const k of Object.keys(mb)) assert.ok(['url', 'urls', 'rendering', 'include_links', 'include_images', 'chunking', 'chunk_size'].includes(k), k);
  assert.throws(() => md.apiBody!({ urls: ['https://example.com/'], mode: 'crawl' }), /not available on the SiteVerdict API backend/);
});

test('base URL is normalised (trailing slash and /v1) and paths use /v1', async () => {
  assert.equal(normaliseApiBase('https://api.webrevenuescan.com/v1/'), 'https://api.webrevenuescan.com');
  const api = fakeApi(() => ({ status: 200, body: scanResult('ai-readiness') }));
  await new SiteVerdictApiRunner('http://127.0.0.1:1/v1', api.fetchImpl).run(req({ api: { tool: 'ai-readiness', body: { url: 'https://example.com/' }, kind: 'check' } }));
  assert.equal(api.calls[0]!.path, '/v1/scan/ai-readiness');
});

test('check result: summary metrics are scalar-only, findings keep spec fields', () => {
  const items = apiResultToItems(scanResult('accessibility'), 'check') as Record<string, unknown>[];
  assert.equal(items[0]!.type, 'summary');
  assert.deepEqual(items[0]!.metrics, { violations: 1, 'nested.a': 1 });
  assert.deepEqual(items[1], { type: 'finding', id: 'region', severity: 'medium', title: 'Content not in landmarks', detail: 'd', fix: 'f', category: 'best-practice', evidence: ['main'] });
});

test('202 -> polls GET /v1/jobs/{id} until succeeded', async () => {
  const api = fakeApi((c, n) => (c.method === 'POST' ? { status: 202, body: jobAccepted() } : n < 3 ? { status: 200, body: jobAccepted() } : { status: 200, body: { ...jobAccepted('job_AAAAAAAAAAAAAAAAAAAA', 'succeeded'), result: scanResult('accessibility') } }));
  const run = await new SiteVerdictApiRunner('http://x', api.fetchImpl, 'ua', 5).run(req({ api: { tool: 'accessibility', body: { url: 'https://example.com/' }, kind: 'check' } }));
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.runId, 'job_AAAAAAAAAAAAAAAAAAAA');
  assert.equal(api.calls.filter((c) => c.method === 'GET').length, 2);
  assert.equal(api.calls[1]!.path, '/v1/jobs/job_AAAAAAAAAAAAAAAAAAAA');
  assert.ok((run.items as { type: string }[]).some((i) => i.type === 'finding'));
  const sent = api.calls[0]!.body!;
  assert.ok(typeof sent.timeout_secs === 'number' && sent.timeout_secs <= 55);
});

test('failed job -> FAILED with the job error as statusMessage', async () => {
  const api = fakeApi((c) => (c.method === 'POST' ? { status: 202, body: jobAccepted() } : { status: 200, body: { ...jobAccepted('job_AAAAAAAAAAAAAAAAAAAA', 'failed'), error: { code: 'target_unreachable', message: 'DNS failed' } } }));
  const run = await new SiteVerdictApiRunner('http://x', api.fetchImpl, 'ua', 5).run(req({ api: { tool: 'accessibility', body: { url: 'https://example.com/' }, kind: 'check' } }));
  assert.equal(run.status, 'FAILED');
  assert.match(run.statusMessage!, /target_unreachable: DNS failed/);
});

test('deadline -> RUNNING with the API job id; fetchRun accepts job_ and legacy job_job_ ids', async () => {
  let done = false;
  const api = fakeApi((c) => (c.method === 'POST' ? { status: 202, body: jobAccepted() } : { status: 200, body: done ? { ...jobAccepted('job_AAAAAAAAAAAAAAAAAAAA', 'succeeded'), result: scanResult('accessibility') } : jobAccepted() }));
  const runner = new SiteVerdictApiRunner('http://x', api.fetchImpl, 'ua', 50);
  const run = await runner.run(req({ waitSecs: 1, api: { tool: 'accessibility', body: { url: 'https://example.com/' }, kind: 'check' } }));
  assert.equal(run.status, 'RUNNING');
  assert.equal(run.runId, 'job_AAAAAAAAAAAAAAAAAAAA');
  done = true;
  for (const id of ['job_AAAAAAAAAAAAAAAAAAAA', 'job_job_AAAAAAAAAAAAAAAAAAAA']) {
    const r = await runner.fetchRun({ runId: id, token: '', apiKey: 'sv_test_abcdefgh12345', signal: new AbortController().signal, kind: 'check' });
    assert.equal(r.status, 'SUCCEEDED');
  }
  assert.equal(jobIdFromRunId('job_job_X'), 'job_X');
  assert.ok(api.calls.slice(-2).every((c) => c.path === '/v1/jobs/job_AAAAAAAAAAAAAAAAAAAA'));
});

test('retries 503 (Retry-After) reusing the same Idempotency-Key', async () => {
  const api = fakeApi((_c, n) => (n === 1 ? { status: 503, body: { error: { code: 'server_busy', message: 'busy' } }, headers: { 'retry-after': '0' } } : { status: 200, body: scanResult('seo-basics') }));
  const run = await new SiteVerdictApiRunner('http://x', api.fetchImpl).run(req({ api: { tool: 'seo-basics', body: { url: 'https://example.com/' }, kind: 'check' } }));
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(api.calls.length, 2);
  const k1 = api.calls[0]!.headers['Idempotency-Key'];
  assert.ok(k1 && /^[A-Za-z0-9_.:-]{1,128}$/.test(k1));
  assert.equal(api.calls[1]!.headers['Idempotency-Key'], k1);
});

test('422 is not retried and explains that nothing was charged; 400 is a user error', async () => {
  const api = fakeApi(() => ({ status: 422, body: { error: { code: 'robots_disallowed', message: 'robots.txt disallows SiteVerdictBot' } } }));
  const runner = new SiteVerdictApiRunner('http://x', api.fetchImpl);
  await assert.rejects(runner.run(req({ api: { tool: 'speed', body: { url: 'https://example.com/' }, kind: 'check' } })), /could not be scanned \(robots_disallowed\).*Nothing was charged/);
  assert.equal(api.calls.length, 1);
  const bad = fakeApi(() => ({ status: 400, body: { error: { code: 'invalid_request', message: 'Unknown field(s): foo' } } }));
  await assert.rejects(new SiteVerdictApiRunner('http://x', bad.fetchImpl).run(req({ api: { tool: 'speed', body: { url: 'u' }, kind: 'check' } })), (e: Error) => e.name === 'UserInputError' && /Unknown field/.test(e.message));
  const slow = fakeApi(() => ({ status: 504, body: { error: { code: 'scan_timeout', message: 'too slow' } } }));
  await assert.rejects(new SiteVerdictApiRunner('http://x', slow.fetchImpl).run(req({ api: { tool: 'speed', body: { url: 'u' }, kind: 'check' } })), /timed out.*Nothing was charged/);
  assert.equal(slow.calls.length, 1);
});

test('several URLs run as one batch job via POST /v1/jobs/{tool}; failed items become error/blocked records', async () => {
  const batch = {
    tool: 'tech-stack', total: 2, succeeded: 1, failed: 1,
    items: [
      { url: 'https://a.example/', ok: true, result: { tool: 'tech-stack', url: 'https://a.example/', final_url: 'https://a.example/', score: null, grade: null, summary: 's', findings: [], data: { tech_names: ['Shopify'], technology_count: 1, email_providers: [] } } },
      { url: 'https://b.example/', ok: false, error: { code: 'target_blocked', message: 'bot protection' } },
    ],
  };
  const api = fakeApi((c) => (c.method === 'POST' ? { status: 202, body: { ...jobAccepted('job_BBBBBBBBBBBBBBBBBBBB', 'queued'), tool: 'tech-stack' } } : { status: 200, body: { ...jobAccepted('job_BBBBBBBBBBBBBBBBBBBB', 'succeeded'), tool: 'tech-stack', result: batch } }));
  const run = await new SiteVerdictApiRunner('http://x', api.fetchImpl, 'ua', 5).run(req({ api: { tool: 'tech-stack', body: { url: 'https://a.example/', urls: ['https://a.example/', 'https://b.example/'], check_dns: true }, kind: 'data' } }));
  assert.equal(api.calls[0]!.path, '/v1/jobs/tech-stack');
  assert.deepEqual(api.calls[0]!.body, { urls: ['https://a.example/', 'https://b.example/'], check_dns: true });
  const items = run.items as Record<string, unknown>[];
  assert.deepEqual(items[0]!.techNames, ['Shopify']);
  assert.equal(items[0]!.domain, 'a.example');
  assert.equal(items[1]!.status, 'blocked');
});

test('MCP: audit returns running with the API job id, get_audit_results fetches it', async () => {
  let ready = false;
  const api = fakeApi((c) => {
    if (c.method === 'POST') return { status: 202, body: jobAccepted('job_CCCCCCCCCCCCCCCCCCCC') };
    return { status: 200, body: ready ? { ...jobAccepted('job_CCCCCCCCCCCCCCCCCCCC', 'succeeded'), result: scanResult('ai-readiness') } : jobAccepted('job_CCCCCCCCCCCCCCCCCCCC') };
  });
  const config = loadConfig({ SITEVERDICT_APIFY_USERNAME: 'tester', SITEVERDICT_MOCK_DELAY_MS: '0', SITEVERDICT_DNS_CHECK: 'false', SITEVERDICT_BACKEND: 'api', SITEVERDICT_API_BASE: 'http://x', SITEVERDICT_TOOLSETS: 'web' });
  const mock = new MockRunner(0, (id) => CHECK_KEYS.find((k) => config.actorIds[k] === id));
  const server = createServer({ config, auth: { clientKey: 'k', source: 'header', apiKey: 'sv_test_abcdefgh12345' }, limiter: new ClientLimiter(1000, 50), runner: mock, mockRunner: mock, apiRunner: new SiteVerdictApiRunner('http://x', api.fetchImpl, 'ua', 1000) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  const first = (await client.callTool({ name: 'check_ai_search_readiness', arguments: { url: 'https://example.com', waitSecs: 10, maxPages: 3 } })) as CallToolResult;
  assert.ok(!first.isError);
  assert.deepEqual(api.calls[0]!.body && Object.keys(api.calls[0]!.body).sort(), ['timeout_secs', 'url']);
  const rep = CheckReportSchema.parse(first.structuredContent);
  assert.equal(rep.status, 'running');
  assert.equal(rep.run.runId, 'job_CCCCCCCCCCCCCCCCCCCC');
  ready = true;
  const later = (await client.callTool({ name: 'get_audit_results', arguments: { runId: rep.run.runId!, check: 'ai_search' } })) as CallToolResult;
  assert.ok(!later.isError, JSON.stringify(later.content));
  assert.equal(CheckReportSchema.parse(later.structuredContent).score, 80);
  const data = (await client.callTool({ name: 'get_run_results', arguments: { runId: 'job_CCCCCCCCCCCCCCCCCCCC', tool: 'detect_tech_stack' } })) as CallToolResult;
  assert.ok(!data.isError);
  assert.equal(DataResultSchema.parse(data.structuredContent).status, 'complete');
});
