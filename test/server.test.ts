import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { MockRunner } from '../src/apify/mock.js';
import type { ActorRunner, RunResult } from '../src/apify/runner.js';
import type { CallerAuth } from '../src/auth.js';
import { CHECK_KEYS, loadConfig, type CheckKey, type Config } from '../src/config.js';
import { createHttpApp } from '../src/http.js';
import { ClientLimiter } from '../src/lib/rateLimit.js';
import { CheckReportSchema, FullAuditSchema } from '../src/report.js';
import { createServer } from '../src/server.js';

const EXPECTED_TOOLS = [
  'audit_tracking_consent', 'scan_speed_and_revenue', 'audit_accessibility_wcag', 'check_domain_email_health',
  'check_ai_search_readiness', 'full_website_audit', 'get_audit_results',
  // toolset "web" also carries these data tools (default toolset):
  'detect_tech_stack', 'fetch_clean_markdown', 'monitor_website_changes', 'get_run_results',
].sort();
/** Tools that save a private snapshot/state in the caller's Apify storage (readOnlyHint false, destructiveHint false). */
const STATEFUL_TOOLS = new Set(['monitor_website_changes', 'sec_filing_watch', 'reviews_monitor', 'seo_rank_check']);

function cfg(env: Record<string, string> = {}): Config {
  return loadConfig({ SITEVERDICT_APIFY_USERNAME: 'tester', SITEVERDICT_MOCK_DELAY_MS: '0', SITEVERDICT_DNS_CHECK: 'false', ...env });
}

function mock(config: Config): MockRunner {
  return new MockRunner(0, (id) => CHECK_KEYS.find((k) => config.actorIds[k] === id));
}

/** A "real" runner stand-in that records calls and returns fixture data as if from Apify. */
class RecordingRunner implements ActorRunner {
  readonly dryRun = false;
  calls: { actorId: string; input: Record<string, unknown>; token: string; maxTotalChargeUsd?: number }[] = [];
  constructor(private readonly config: Config, private readonly failCheck?: CheckKey) {}
  async run(req: Parameters<ActorRunner['run']>[0]): Promise<RunResult> {
    this.calls.push({ actorId: req.actorId, input: req.input, token: req.token, maxTotalChargeUsd: req.maxTotalChargeUsd });
    const check = CHECK_KEYS.find((k) => this.config.actorIds[k] === req.actorId)!;
    if (check === this.failCheck) throw new Error('boom (internal detail that must not leak)');
    req.onProgress?.(50, 100, 'half');
    const r = await mock(this.config).run(req);
    return { ...r, dryRun: false, runId: `run_${check}`, usageTotalUsd: 0.05, status: 'SUCCEEDED' };
  }
  async fetchRun(): Promise<RunResult> {
    return { actorId: 'x', runId: 'abcde12345', status: 'RUNNING', items: [], dryRun: false };
  }
}

async function connect(config: Config, auth: CallerAuth, runner?: ActorRunner, limiter = new ClientLimiter(100, 10)) {
  const server = createServer({ config, auth, limiter, runner: runner ?? mock(config), mockRunner: mock(config) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(ct);
  return client;
}

const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

test('lists all tools with titles, annotations, input + output schemas', async () => {
  const client = await connect(cfg({ SITEVERDICT_DRY_RUN: '1' }), { clientKey: 't', source: 'none' });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
  for (const t of tools) {
    assert.ok(t.title, `${t.name} title`);
    assert.ok((t.description ?? '').length > 80, `${t.name} description`);
    assert.equal(t.annotations?.readOnlyHint, !STATEFUL_TOOLS.has(t.name), `${t.name} readOnlyHint`);
    assert.equal(t.annotations?.destructiveHint, false);
    assert.equal(t.annotations?.openWorldHint, true);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.outputSchema, `${t.name} outputSchema`);
  }
  const consent = tools.find((t) => t.name === 'audit_tracking_consent')!;
  const props = consent.inputSchema.properties as Record<string, { default?: unknown }>;
  assert.equal(props.scanMode?.default, 'full');
  assert.deepEqual(consent.inputSchema.required, ['url']);
});

test('every single-check tool works in dry-run and returns valid structured content', async () => {
  const client = await connect(cfg({ SITEVERDICT_DRY_RUN: '1' }), { clientKey: 't', source: 'none' });
  const calls: [string, Record<string, unknown>][] = [
    ['audit_tracking_consent', { url: 'example.com' }],
    ['scan_speed_and_revenue', { url: 'https://example.com', monthlyVisitors: 20000, averageOrderValue: 60 }],
    ['audit_accessibility_wcag', { url: 'https://example.com', wcagLevel: 'AA' }],
    ['check_domain_email_health', { domain: 'example.com' }],
    ['check_ai_search_readiness', { url: 'https://example.com' }],
  ];
  for (const [name, args] of calls) {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    assert.notEqual(r.isError, true, `${name}: ${text(r)}`);
    const parsed = CheckReportSchema.parse(r.structuredContent);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.status, 'complete');
    assert.ok(parsed.score !== null && parsed.findings.length > 0);
    assert.match(text(r), /DRY RUN/);
  }
});

test('full_website_audit merges sections into a ranked fix plan', async () => {
  const client = await connect(cfg({ SITEVERDICT_DRY_RUN: '1' }), { clientKey: 't', source: 'none' });
  const r = (await client.callTool({ name: 'full_website_audit', arguments: { url: 'https://www.example.com' } })) as CallToolResult;
  assert.notEqual(r.isError, true, text(r));
  const out = FullAuditSchema.parse(r.structuredContent);
  assert.equal(out.sections.length, 5);
  assert.equal(out.domain, 'example.com');
  assert.ok(out.overallScore !== null);
  assert.ok(out.fixPlan.length >= 10);
  for (let i = 1; i < out.fixPlan.length; i++) assert.ok(out.fixPlan[i - 1]!.priorityScore >= out.fixPlan[i]!.priorityScore);
  assert.equal(out.fixPlan[0]!.severity, 'critical');
  assert.match(out.executiveSummary, /Overall \d+\/100/);
});

test('real mode: no token → clear setup error, no run started', async () => {
  const config = cfg();
  const runner = new RecordingRunner(config);
  const client = await connect(config, { clientKey: 't', source: 'none' }, runner);
  const r = (await client.callTool({ name: 'check_ai_search_readiness', arguments: { url: 'https://example.com' } })) as CallToolResult;
  assert.equal(r.isError, true);
  assert.match(text(r), /APIFY_TOKEN/);
  assert.equal(runner.calls.length, 0);
});

test('real mode: passes the user token, Actor ID, mapped input and spend cap; partial failure handled', async () => {
  const config = cfg();
  const runner = new RecordingRunner(config, 'accessibility');
  const client = await connect(config, { token: 'apify_api_USER', clientKey: 'k', source: 'env' }, runner);
  const r = (await client.callTool({ name: 'full_website_audit', arguments: { url: 'https://shop.example.com', maxCostUsd: 5, maxPages: 2 } })) as CallToolResult;
  assert.notEqual(r.isError, true, text(r));
  const out = FullAuditSchema.parse(r.structuredContent);
  assert.equal(runner.calls.length, 5);
  assert.ok(runner.calls.every((c) => c.token === 'apify_api_USER' && c.maxTotalChargeUsd === 1));
  const consent = runner.calls.find((c) => c.actorId === 'tester/siteverdict-tracking-consent-auditor')!;
  assert.deepEqual(consent.input, { startUrls: [{ url: 'https://shop.example.com/' }], scanMode: 'full', maxInternalPages: 1, locale: 'en-GB', timezoneId: 'Europe/London', saveScreenshots: true });
  const dom = runner.calls.find((c) => c.actorId === 'tester/siteverdict-domain-email-health')!;
  assert.deepEqual(dom.input, { domains: ['shop.example.com'] });
  const failed = out.sections.find((s) => s.check === 'accessibility')!;
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(failed.error ?? '', /boom/);
  assert.equal(out.dryRun, false);
  assert.equal(out.totalCostUsd, 0.2);
});

test('rejects SSRF targets before any run', async () => {
  const config = cfg();
  const runner = new RecordingRunner(config);
  const client = await connect(config, { token: 'apify_api_USER', clientKey: 'k', source: 'env' }, runner);
  for (const url of ['http://169.254.169.254/', 'http://localhost:8080', 'http://10.0.0.1']) {
    const r = (await client.callTool({ name: 'scan_speed_and_revenue', arguments: { url } })) as CallToolResult;
    assert.equal(r.isError, true, url);
  }
  assert.equal(runner.calls.length, 0);
});

test('schema validation rejects out-of-range input', async () => {
  const client = await connect(cfg({ SITEVERDICT_DRY_RUN: '1' }), { clientKey: 't', source: 'none' });
  const r = (await client.callTool({ name: 'audit_accessibility_wcag', arguments: { url: 'https://example.com', maxPages: 5000 } })) as CallToolResult;
  assert.equal(r.isError, true);
  assert.match(text(r), /maxPages/);
});

test('rate limit per client', async () => {
  const client = await connect(cfg({ SITEVERDICT_DRY_RUN: '1' }), { clientKey: 'rl', source: 'none' }, undefined, new ClientLimiter(2, 10));
  const call = () => client.callTool({ name: 'check_domain_email_health', arguments: { domain: 'example.com' } }) as Promise<CallToolResult>;
  assert.notEqual((await call()).isError, true);
  assert.notEqual((await call()).isError, true);
  const third = await call();
  assert.equal(third.isError, true);
  assert.match(text(third), /Rate limit/);
});

test('get_audit_results reports a still-running run', async () => {
  const config = cfg();
  const client = await connect(config, { token: 'apify_api_USER', clientKey: 'k', source: 'env' }, new RecordingRunner(config));
  const r = (await client.callTool({ name: 'get_audit_results', arguments: { runId: 'abcde12345', check: 'speed_revenue' } })) as CallToolResult;
  const out = CheckReportSchema.parse(r.structuredContent);
  assert.equal(out.status, 'running');
  assert.match(out.summary, /get_audit_results/);
});

test('prompts and resources are listed and readable', async () => {
  const client = await connect(cfg({ SITEVERDICT_DRY_RUN: '1' }), { clientKey: 't', source: 'none' });
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ['cookie_consent_check', 'prelaunch_check', 'website_fix_plan']);
  const p = await client.getPrompt({ name: 'website_fix_plan', arguments: { url: 'https://example.com' } });
  assert.match(JSON.stringify(p.messages), /full_website_audit/);
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), ['siteverdict://checks', 'siteverdict://guide/scoring', 'siteverdict://tools', 'ui://siteverdict/score-card-v1.html']);
  const checks = await client.readResource({ uri: 'siteverdict://checks' });
  assert.match(JSON.stringify(checks.contents), /tester\/siteverdict-accessibility-auditor/);
});

/* ------------------------------------------------------------- HTTP surface */

function httpApp(env: Record<string, string> = {}) {
  const config = cfg(env);
  return createHttpApp({ config, limiter: new ClientLimiter(100, 10), runner: new RecordingRunner(config), mockRunner: mock(config) });
}

test('HTTP: Streamable HTTP client end-to-end (no network port opened)', async () => {
  const app = httpApp({ SITEVERDICT_DRY_RUN: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3333/mcp'), {
    fetch: (input, init) => app.fetch(new Request(input as string | URL, init)),
  });
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, EXPECTED_TOOLS.length);
  const r = (await client.callTool({ name: 'check_domain_email_health', arguments: { domain: 'example.com' } })) as CallToolResult;
  assert.equal(CheckReportSchema.parse(r.structuredContent).dryRun, true);
  await client.close();
  await app.close();
});

test('HTTP: rejects foreign Host (DNS rebinding) and bad Origin; health endpoint works', async () => {
  const app = httpApp();
  const evilHost = await app.fetch(new Request('http://evil.example.com/mcp', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
  assert.equal(evilHost.status, 403);
  const evilOrigin = await app.fetch(new Request('http://127.0.0.1:3333/mcp', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' } }));
  assert.equal(evilOrigin.status, 403);
  const health = await app.fetch(new Request('http://127.0.0.1:3333/healthz'));
  assert.equal(health.status, 200);
  const nf = await app.fetch(new Request('http://127.0.0.1:3333/other'));
  assert.equal(nf.status, 404);
  await app.close();
});

test('HTTP: hosted mode stays disabled unless explicitly enabled', async () => {
  const app = httpApp({ SITEVERDICT_MODE: 'hosted' });
  const res = await app.fetch(new Request('http://127.0.0.1:3333/mcp', { method: 'POST', body: '{}', headers: { authorization: 'Bearer customer-key', 'content-type': 'application/json' } }));
  assert.equal(res.status, 401);
  assert.match(await res.text(), /disabled/);
  await app.close();
});

test('HTTP: X-Apify-Token header is used as the caller token (BYOK)', async () => {
  const config = cfg();
  const runner = new RecordingRunner(config);
  const app = createHttpApp({ config, limiter: new ClientLimiter(100, 10), runner, mockRunner: mock(config) });
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3333/mcp'), {
    fetch: (input, init) => app.fetch(new Request(input as string | URL, init)),
    requestInit: { headers: { 'X-Apify-Token': 'apify_api_FROMHEADER' } },
  });
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  await client.connect(transport);
  const r = (await client.callTool({ name: 'check_ai_search_readiness', arguments: { url: 'https://example.com' } })) as CallToolResult;
  assert.notEqual(r.isError, true, text(r));
  assert.equal(runner.calls[0]?.token, 'apify_api_FROMHEADER');
  await client.close();
  await app.close();
});

test('progress notifications are emitted when the client sends a progressToken', async () => {
  const client = await connect(cfg({ SITEVERDICT_DRY_RUN: '1' }), { clientKey: 'p', source: 'none' });
  const seen: number[] = [];
  await client.callTool({ name: 'audit_tracking_consent', arguments: { url: 'https://example.com' } }, { onprogress: (p: { progress: number }) => seen.push(p.progress) });
  assert.ok(seen.length >= 3, `got ${seen.length} progress events`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]! > seen[i - 1]!);
});
