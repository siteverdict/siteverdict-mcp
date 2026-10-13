import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { SiteVerdictApiRunner } from '../src/api/client.js';
import { MockRunner } from '../src/apify/mock.js';
import type { ActorRunner, RunRequest, RunResult } from '../src/apify/runner.js';
import type { CallerAuth } from '../src/auth.js';
import { CHECK_KEYS, loadConfig, type Config } from '../src/config.js';
import { ClientLimiter } from '../src/lib/rateLimit.js';
import { CheckReportSchema, FullAuditSchema } from '../src/report.js';
import { createServer } from '../src/server.js';
import { DATA_TOOLS } from '../src/tools/catalog/index.js';
import { EXAMPLE_ARGS, NEGATIVE_ARGS } from '../src/tools/examples.js';
import { buildDataResult } from '../src/tools/register.js';
import { DataResultSchema } from '../src/tools/types.js';
import { WIDGET_MIME, WIDGET_URI } from '../src/apps/widget.js';

const AUDIT_TOOLS = ['audit_tracking_consent', 'scan_speed_and_revenue', 'audit_accessibility_wcag', 'check_domain_email_health', 'check_ai_search_readiness', 'full_website_audit', 'get_audit_results'];

function cfg(env: Record<string, string> = {}): Config {
  return loadConfig({ SITEVERDICT_APIFY_USERNAME: 'tester', SITEVERDICT_MOCK_DELAY_MS: '0', SITEVERDICT_DNS_CHECK: 'false', ...env });
}
const mock = (config: Config) => new MockRunner(0, (id) => CHECK_KEYS.find((k) => config.actorIds[k] === id));

/** Fake Apify runner for data tools: records the Actor input, returns canned items. */
class FakeRunner implements ActorRunner {
  readonly dryRun = false;
  calls: RunRequest[] = [];
  constructor(private readonly items: (req: RunRequest) => unknown[] = () => [{ recordType: 'result', ok: true }]) {}
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    return { actorId: req.actorId, runId: 'run_fake1', status: 'SUCCEEDED', items: this.items(req), usageTotalUsd: 0.01, dryRun: false };
  }
  async fetchRun(): Promise<RunResult> {
    return { actorId: 'x', runId: 'run_fake1', status: 'RUNNING', items: [], dryRun: false };
  }
}

async function connect(config: Config, auth: CallerAuth, extra: { runner?: ActorRunner; apiRunner?: ActorRunner } = {}) {
  const server = createServer({ config, auth, limiter: new ClientLimiter(1000, 50), runner: extra.runner ?? mock(config), mockRunner: mock(config), apiRunner: extra.apiRunner });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(ct);
  return client;
}
const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

test('catalog: 21 data tools from 18 finished Actors, unique names <= 64 chars, example args for each', () => {
  assert.equal(DATA_TOOLS.length, 21);
  assert.equal(new Set(DATA_TOOLS.map((t) => t.folder)).size, 18);
  const names = [...DATA_TOOLS.map((t) => t.name), ...AUDIT_TOOLS, 'get_run_results'];
  assert.equal(new Set(names).size, names.length);
  for (const n of names) {
    assert.ok(/^[a-z][a-z0-9_]{2,63}$/.test(n), n);
    if (n !== 'get_audit_results' && n !== 'get_run_results') assert.ok(EXAMPLE_ARGS[n], `example args for ${n}`);
  }
  for (const t of DATA_TOOLS) {
    assert.ok(t.inputSchema.safeParse(EXAMPLE_ARGS[t.name]).success, `example args parse for ${t.name}`);
    assert.ok(t.toolsets.length > 0);
    assert.ok(t.actor.startsWith('siteverdict-'));
  }
});

test('toolset "all": 29 tools, every one with title, all 4 annotations explicit, output schema and securitySchemes', async () => {
  const client = await connect(cfg({ SITEVERDICT_DRY_RUN: '1', SITEVERDICT_TOOLSETS: 'all' }), { clientKey: 't', source: 'none' });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 29);
  for (const t of tools) {
    assert.ok(t.title && t.annotations?.title, `${t.name} title`);
    for (const h of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) assert.equal(typeof t.annotations?.[h], 'boolean', `${t.name} ${h}`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} must not be destructive`);
    assert.ok(t.outputSchema, `${t.name} outputSchema`);
    assert.ok(Array.isArray((t._meta as Record<string, unknown>)?.securitySchemes), `${t.name} securitySchemes`);
    assert.ok((t.description ?? '').length > 80);
    assert.ok(!/ignore (all|previous) instructions/i.test(t.description ?? ''));
  }
  for (const n of AUDIT_TOOLS) {
    const meta = tools.find((t) => t.name === n)!._meta as Record<string, unknown>;
    assert.equal((meta.ui as { resourceUri: string }).resourceUri, WIDGET_URI);
    assert.equal(meta['openai/outputTemplate'], WIDGET_URI);
    assert.ok(String(meta['openai/toolInvocation/invoking']).length <= 64);
  }
});

test('toolsets narrow the list: travel only, leads+compliance, explicit allow-list', async () => {
  const travel = await connect(cfg({ SITEVERDICT_DRY_RUN: '1', SITEVERDICT_TOOLSETS: 'travel' }), { clientKey: 't', source: 'none' });
  assert.deepEqual((await travel.listTools()).tools.map((t) => t.name).sort(), ['check_flight_compensation', 'flight_deal_alerts', 'flight_fare_estimate', 'flight_fare_scan', 'get_run_results', 'visa_entry_check']);
  const resources = (await travel.listResources()).resources.map((r) => r.uri);
  assert.ok(!resources.includes(WIDGET_URI), 'no widget without audit tools');
  const lc = await connect(cfg({ SITEVERDICT_DRY_RUN: '1', SITEVERDICT_TOOLSETS: 'leads,compliance' }), { clientKey: 't', source: 'none' });
  const names = (await lc.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('sanctions_screen') && names.includes('find_public_tenders') && names.includes('company_registry_lookup'));
  assert.ok(!names.includes('full_website_audit'));
  const allow = await connect(cfg({ SITEVERDICT_DRY_RUN: '1', SITEVERDICT_TOOLS: 'sanctions_screen,full_website_audit' }), { clientKey: 't', source: 'none' });
  assert.deepEqual((await allow.listTools()).tools.map((t) => t.name).sort(), ['full_website_audit', 'get_audit_results', 'get_run_results', 'sanctions_screen']);
  assert.throws(() => cfg({ SITEVERDICT_TOOLSETS: 'webb' }), /Unknown toolset/);
});

test('every tool returns valid structured SAMPLE content in dry-run (no network)', async () => {
  const client = await connect(cfg({ SITEVERDICT_DRY_RUN: '1', SITEVERDICT_TOOLSETS: 'all' }), { clientKey: 't', source: 'none' });
  for (const [name, args] of Object.entries(EXAMPLE_ARGS)) {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    assert.ok(!r.isError, `${name}: ${text(r)}`);
    if (name === 'full_website_audit') assert.equal(FullAuditSchema.parse(r.structuredContent).dryRun, true);
    else if (AUDIT_TOOLS.includes(name)) assert.equal(CheckReportSchema.parse(r.structuredContent).dryRun, true);
    else {
      const out = DataResultSchema.parse(r.structuredContent);
      assert.equal(out.dryRun, true, name);
      assert.equal(out.sampleData, true, name);
      assert.ok(out.items.length > 0, `${name} items`);
      assert.match(text(r), /SAMPLE/);
    }
  }
});

test('negative cases are refused with actionable errors', async () => {
  const client = await connect(cfg({ SITEVERDICT_DRY_RUN: '1', SITEVERDICT_TOOLSETS: 'all' }), { clientKey: 't', source: 'none' });
  for (const n of NEGATIVE_ARGS) {
    const r = (await client.callTool({ name: n.tool, arguments: n.args })) as CallToolResult;
    assert.equal(r.isError, true, `${n.tool}: ${n.why}`);
    assert.ok(text(r).length > 20 && !/Internal error/.test(text(r)), `${n.tool}: ${text(r)}`);
  }
});

test('live path: Actor id, input mapping, per-user state namespace, secrets injected but never echoed', async () => {
  const runner = new FakeRunner((req) => [{ recordType: 'rank', keyword: 'shoes', domain: 'example.com', position: 4, status: 'up', echo: JSON.stringify(req.input).length }]);
  const secrets = { SERPAPI_API_KEY: 'serp-secret-1234567890' };
  const client = await connect(cfg({ SITEVERDICT_TOOLSETS: 'all' }), { token: 'apify_api_TESTTOKEN0000000000001', clientKey: 'k_abc', source: 'header', secrets }, { runner });
  const r = (await client.callTool({ name: 'seo_rank_check', arguments: { ...EXAMPLE_ARGS.seo_rank_check, provider: 'serpapi', projectName: 'acme' } })) as CallToolResult;
  assert.ok(!r.isError, text(r));
  const call = runner.calls[0]!;
  assert.equal(call.actorId, 'tester/siteverdict-seo-rank-tracker');
  assert.equal(call.token, 'apify_api_TESTTOKEN0000000000001');
  assert.equal(call.input.serpapiApiKey, 'serp-secret-1234567890');
  assert.match(String(call.input.projectName), /^mcp-[0-9a-f]{10}-acme$/);
  assert.equal(call.input.executionMode, 'auto');
  assert.ok(!JSON.stringify(r).includes('serp-secret-1234567890'), 'secret must not appear in the result');
  assert.equal(DataResultSchema.parse(r.structuredContent).run.usageTotalUsd, 0.01);

  // No key for the chosen provider -> Actor dry-run (sample) + note.
  const r2 = (await client.callTool({ name: 'seo_rank_check', arguments: { ...EXAMPLE_ARGS.seo_rank_check, provider: 'dataforseo' } })) as CallToolResult;
  assert.equal(runner.calls[1]!.input.executionMode, 'dryRun');
  assert.match(text(r2), /SAMPLE data/);
});

test('input mappings follow each MCP-TOOL.md', async () => {
  const runner = new FakeRunner();
  const client = await connect(cfg({ SITEVERDICT_TOOLSETS: 'all' }), { token: 'apify_api_TESTTOKEN0000000000001', clientKey: 'stdio', source: 'env', secrets: {} }, { runner });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    assert.ok(!r.isError, `${name}: ${text(r)}`);
    return runner.calls.at(-1)!.input;
  };
  const md = await call('fetch_clean_markdown', EXAMPLE_ARGS.fetch_clean_markdown!);
  assert.deepEqual(md.startUrls, [{ url: 'https://example.com/docs' }]);
  assert.equal(md.renderingMode, 'http');
  assert.equal(md.enableChunking, false);
  assert.equal(md.includeJsonLd, false);
  const pdf = await call('extract_pdf_invoice', EXAMPLE_ARGS.extract_pdf_invoice!);
  assert.deepEqual(pdf.pdfUrls, [{ url: 'https://example.com/invoice-0001.pdf' }]);
  const tenders = await call('find_public_tenders', EXAMPLE_ARGS.find_public_tenders!);
  assert.equal(tenders.includeContactDetails, false);
  assert.equal(tenders.maxDescriptionChars, 600);
  const deals = await call('flight_deal_alerts', { ...EXAMPLE_ARGS.flight_deal_alerts, includeSecretFlying: true });
  assert.ok((deals.sources as string[]).includes('secretflying'));
  assert.equal(deals.mode, 'latest');
  const fare = await call('flight_fare_scan', EXAMPLE_ARGS.flight_fare_scan!);
  assert.equal(fare.executionMode, 'sample'); // no user Travelpayouts/Duffel token
  assert.equal(fare.saveHistory, false);
  const est = await call('flight_fare_estimate', EXAMPLE_ARGS.flight_fare_estimate!);
  assert.equal(est.executionMode, 'estimate');
  const watch = await call('sec_filing_watch', EXAMPLE_ARGS.sec_filing_watch!);
  assert.equal(watch.mode, 'monitor');
  assert.equal(watch.monitorStateName, 'mcp-apple-8k');
  assert.equal(watch.secContactEmail, 'aman.thakran@bharatfare.com');
  const fts = await call('sec_full_text_search', EXAMPLE_ARGS.sec_full_text_search!);
  assert.equal(fts.fullTextQuery, '"going concern" aviation');
  const prop = await call('uk_property_data', { ...EXAMPLE_ARGS.uk_property_data, includeEpc: true, epcPurpose: 'energy-efficiency-research' });
  assert.equal(prop.outputTransactions, false);
  assert.equal(prop.includeEpc, false); // no EPC token configured
  const leads = await call('find_local_businesses', { ...EXAMPLE_ARGS.find_local_businesses, source: 'google' });
  assert.equal(leads.googleDryRun, true);
  assert.equal(leads.includeEmails, false);
  const gsc = await call('search_traffic_diagnose', EXAMPLE_ARGS.search_traffic_diagnose!);
  assert.equal(gsc.authMethod, 'sample');
  const rev = await call('reviews_monitor', EXAMPLE_ARGS.reviews_monitor!);
  assert.equal(rev.executionMode, 'sample');
  assert.equal(rev.alertWebhookUrl, undefined);
  const ads = await call('google_ads_transparency', EXAMPLE_ARGS.google_ads_transparency!);
  assert.equal(ads.sampleMode, true);
  const sanc = await call('sanctions_screen', EXAMPLE_ARGS.sanctions_screen!);
  assert.equal(sanc.mode, 'screen');
  assert.equal(sanc.includeRecordDetails, false);
  const visa = await call('visa_entry_check', EXAMPLE_ARGS.visa_entry_check!);
  assert.equal(visa.mode, 'check');
  const ts = await call('detect_tech_stack', EXAMPLE_ARGS.detect_tech_stack!);
  assert.deepEqual(ts.urls, ['https://example.com/', 'https://example.org/']);
  assert.equal(ts.monitor, false);
  const mon = await call('monitor_website_changes', EXAMPLE_ARGS.monitor_website_changes!);
  assert.equal(mon.stateStoreName, 'mcp-pricing-watch');
  assert.equal(mon.webhookUrl, undefined);
});

test('no Apify token and no dry-run: data tools explain how to add one', async () => {
  const client = await connect(cfg({ SITEVERDICT_TOOLSETS: 'all' }), { clientKey: 't', source: 'none' });
  const r = (await client.callTool({ name: 'sanctions_screen', arguments: EXAMPLE_ARGS.sanctions_screen! })) as CallToolResult;
  assert.equal(r.isError, true);
  assert.match(text(r), /APIFY_TOKEN/);
});

test('get_run_results fetches a still-running run', async () => {
  const runner = new FakeRunner();
  const client = await connect(cfg({ SITEVERDICT_TOOLSETS: 'travel' }), { token: 'apify_api_TESTTOKEN0000000000001', clientKey: 'k', source: 'header' }, { runner });
  const r = (await client.callTool({ name: 'get_run_results', arguments: { runId: 'run_fake1', tool: 'visa_entry_check' } })) as CallToolResult;
  const out = DataResultSchema.parse(r.structuredContent);
  assert.equal(out.status, 'running');
  assert.match(out.summary, /get_run_results/);
});

test('results are capped for client limits (items, long strings, total size)', () => {
  const spec = DATA_TOOLS.find((t) => t.name === 'find_public_tenders')!;
  const items = Array.from({ length: 300 }, (_, i) => ({ uid: `n${i}`, title: `Tender ${i}`, description: 'x'.repeat(5000), noticeUrl: 'https://example.com' }));
  const r = buildDataResult(spec, {}, { actorId: 'a', status: 'SUCCEEDED', items, dryRun: false }, [], 20_000);
  assert.ok(JSON.stringify(r).length <= 20_000);
  assert.equal(r.truncated, true);
  assert.equal(r.itemsTotal, 300);
  assert.ok(String(r.items[0]!.description).length < 700);
});

test('widget resource is an MCP Apps HTML resource with CSP/domain metadata', async () => {
  const client = await connect(cfg({ SITEVERDICT_DRY_RUN: '1' }), { clientKey: 't', source: 'none' });
  const res = await client.readResource({ uri: WIDGET_URI });
  const c = res.contents[0] as { mimeType: string; text: string; _meta?: Record<string, unknown> };
  assert.equal(c.mimeType, WIDGET_MIME);
  assert.match(c.text, /ui\/notifications\/tool-result/);
  assert.match(c.text, /window\.openai/);
  assert.ok(!/<script[^>]+src=/.test(c.text), 'no external scripts');
  assert.ok((c._meta?.ui as { csp?: unknown })?.csp);
  assert.ok(c._meta?.['openai/widgetDescription']);
});

test('SiteVerdict API backend: data + audit tools call /v1/scan with the caller key', async () => {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fakeFetch = async (input: string, init?: RequestInit) => {
    calls.push({ url: input, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body ?? '{}')) });
    const tool = input.split('/').pop();
    const body = tool === 'tech-stack'
      ? { tool, url: 'https://example.com/', final_url: 'https://example.com/', score: null, grade: null, summary: '1 technology', findings: [], data: { title: 'Example', technology_count: 1, tech_names: ['WordPress'], cms: ['WordPress'], http_status: 200 }, credits_used: 1, request_id: 'r1' }
      : { tool, url: 'https://example.com/', final_url: 'https://example.com/', score: 71, grade: 'C', summary: 'API summary', findings: [{ id: 'image-alt', severity: 'high', title: 'Missing alt text', detail: 'd', fix: 'Add alt', category: 'wcag-A' }], data: { violations: 1, score_by_device: { desktop: 71 }, top_fixes: [{ x: 1 }] }, credits_used: 1, request_id: 'r2' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const config = cfg({ SITEVERDICT_BACKEND: 'api', SITEVERDICT_API_BASE: 'https://api.example.test', SITEVERDICT_TOOLSETS: 'web' });
  const apiRunner = new SiteVerdictApiRunner('https://api.example.test', fakeFetch);
  const client = await connect(config, { clientKey: 'k', source: 'header', apiKey: 'sv_test_abcdefgh12345' }, { apiRunner });
  const ts = (await client.callTool({ name: 'detect_tech_stack', arguments: { urls: ['example.com'] } })) as CallToolResult;
  assert.ok(!ts.isError, text(ts));
  const tsItem = DataResultSchema.parse(ts.structuredContent).items[0]!;
  assert.equal(tsItem.domain, 'example.com');
  assert.deepEqual(tsItem.techNames, ['WordPress']);
  const a11y = (await client.callTool({ name: 'audit_accessibility_wcag', arguments: { url: 'https://example.com' } })) as CallToolResult;
  assert.ok(!a11y.isError, text(a11y));
  const rep = CheckReportSchema.parse(a11y.structuredContent);
  assert.equal(rep.score, 71);
  assert.equal(rep.findings[0]!.title, 'Missing alt text');
  assert.equal(calls[0]!.url, 'https://api.example.test/v1/scan/tech-stack');
  assert.equal(calls[1]!.url, 'https://api.example.test/v1/scan/accessibility');
  assert.equal(calls[0]!.headers['X-API-Key'], 'sv_test_abcdefgh12345');
  assert.deepEqual(Object.keys(calls[1]!.body as object).sort(), ['include_best_practices', 'timeout_secs', 'url', 'wcag_level']);
  assert.equal(rep.metrics['score_by_device.desktop'], 71);
  assert.ok(!('top_fixes' in rep.metrics));
  assert.ok(!JSON.stringify(a11y).includes('request_id'));
});
