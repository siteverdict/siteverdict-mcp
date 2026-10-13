// MCP Inspector-style smoke test of the BUILT package, driven by the official SDK client, exactly as MCP clients
// launch it:  (1) stdio  (2) Streamable HTTP on 127.0.0.1 with API-key auth  (3) Streamable HTTP with OAuth 2.1
// (DCR + PKCE + consent form + token exchange) — calling EVERY tool in dry-run/sample mode. No external network.
// Child processes are always killed at the end (no background processes left behind).
// Usage: npm run smoke     Interactive: npx @modelcontextprotocol/inspector -e SITEVERDICT_DRY_RUN=1 -e SITEVERDICT_TOOLSETS=all node dist/cli.js
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_ARGS, NEGATIVE_ARGS } from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const children = new Set();
const fail = (msg) => {
  process.stderr.write(`SMOKE FAIL: ${msg}\n`);
  for (const c of children) c.kill('SIGTERM');
  process.exit(1);
};
const log = (msg) => process.stdout.write(`${msg}\n`);
const EXPECTED_ALL = 29;
const baseEnv = { PATH: process.env.PATH ?? '', SITEVERDICT_DRY_RUN: '1', SITEVERDICT_MOCK_DELAY_MS: '0', SITEVERDICT_DNS_CHECK: 'false', SITEVERDICT_TOOLSETS: 'all', SITEVERDICT_RATE_LIMIT_PER_MINUTE: '1000' };

async function exercise(client, label) {
  const { tools } = await client.listTools();
  if (tools.length !== EXPECTED_ALL) fail(`${label}: expected ${EXPECTED_ALL} tools, got ${tools.length}`);
  for (const t of tools) {
    const a = t.annotations ?? {};
    if (!t.title || typeof a.readOnlyHint !== 'boolean' || typeof a.destructiveHint !== 'boolean' || typeof a.openWorldHint !== 'boolean') fail(`${label}: ${t.name} missing title/annotations`);
  }
  let ok = 0;
  for (const [name, args] of Object.entries(EXAMPLE_ARGS)) {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) fail(`${label}: ${name} -> ${JSON.stringify(r.content)}`);
    if (!r.structuredContent || r.structuredContent.dryRun !== true) fail(`${label}: ${name} not dry-run structured content`);
    ok++;
  }
  for (const n of NEGATIVE_ARGS) {
    const r = await client.callTool({ name: n.tool, arguments: n.args });
    if (!r.isError) fail(`${label}: negative case accepted: ${n.tool} (${n.why})`);
  }
  const { resources } = await client.listResources();
  const widget = resources.find((r) => r.uri.startsWith('ui://'));
  if (!widget) fail(`${label}: widget resource missing`);
  const w = await client.readResource({ uri: widget.uri });
  if (w.contents[0].mimeType !== 'text/html;profile=mcp-app') fail(`${label}: widget mimeType`);
  log(`${label}: ${tools.length} tools listed, ${ok} tool calls OK (dry-run), ${NEGATIVE_ARGS.length} negative cases refused, widget ${widget.uri}`);
}

/* 1. stdio */
{
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env: baseEnv, stderr: 'pipe' });
  const client = new Client({ name: 'smoke-stdio', version: '1.0.0' });
  await client.connect(transport);
  await exercise(client, 'stdio');
  await client.close();
  // no token, no dry run: actionable guidance
  const t2 = new StdioClientTransport({ command: process.execPath, args: [cli, '--toolsets', 'web'], env: { PATH: process.env.PATH ?? '', SITEVERDICT_DNS_CHECK: 'false' }, stderr: 'pipe' });
  const c2 = new Client({ name: 'smoke-stdio-2', version: '1.0.0' });
  await c2.connect(t2);
  const res = await c2.callTool({ name: 'check_domain_email_health', arguments: { domain: 'example.com' } });
  if (!res.isError || !/APIFY_TOKEN/.test(res.content[0].text)) fail('missing-token message not shown');
  await c2.close();
  log('stdio: no-token guidance OK');
}

/* helpers for HTTP */
const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
async function startHttp(env) {
  const port = env.SITEVERDICT_HTTP_PORT ? Number(env.SITEVERDICT_HTTP_PORT) : await freePort();
  const child = spawn(process.execPath, [cli, '--http'], { env: { ...baseEnv, SITEVERDICT_HTTP_HOST: '127.0.0.1', SITEVERDICT_HTTP_PORT: String(port), ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(child);
  child.stderr.on('data', () => {});
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return { base, child, stop: () => new Promise((res) => { child.once('exit', res); child.kill('SIGTERM'); }).then(() => children.delete(child)) };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  fail('HTTP server did not start');
}

/* 2. HTTP with API-key auth (BYOK header) */
{
  const srv = await startHttp({});
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { 'X-Apify-Token': 'apify_api_SMOKETEST000000000000000' } } });
  const client = new Client({ name: 'smoke-http', version: '1.0.0' });
  await client.connect(transport);
  await exercise(client, 'http(api-key)');
  await client.close();
  const travel = new Client({ name: 'smoke-http-travel', version: '1.0.0' });
  await travel.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/travel`)));
  const names = (await travel.listTools()).tools.map((t) => t.name);
  if (names.includes('full_website_audit') || !names.includes('visa_entry_check')) fail('toolset path /mcp/travel not applied');
  await travel.close();
  const big = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(300_000) });
  if (big.status !== 413) fail(`expected 413, got ${big.status}`);
  await srv.stop();
  log(`http(api-key): /mcp/travel -> ${names.length} tools; 300 KB body -> 413`);
}

/* 3. HTTP with OAuth 2.1 (built-in AS) */
{
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const key = randomBytes(32).toString('base64url');
  const srv = await startHttp({ SITEVERDICT_HTTP_PORT: String(port), SITEVERDICT_OAUTH_ENABLED: '1', SITEVERDICT_PUBLIC_URL: base, SITEVERDICT_OAUTH_KEYS: key, SITEVERDICT_OAUTH_VERIFY_APIFY_TOKEN: '0', SITEVERDICT_ALLOW_API_KEYS: '0' });
  const unauth = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const www = unauth.headers.get('www-authenticate') ?? '';
  if (unauth.status !== 401 || !www.includes('resource_metadata=')) fail('no OAuth challenge');
  const prmUrl = /resource_metadata="([^"]+)"/.exec(www)[1];
  const prm = await (await fetch(prmUrl)).json();
  const as = await (await fetch(`${prm.authorization_servers[0].replace(/\/$/, '')}/.well-known/oauth-authorization-server`)).json();
  const redirect = 'http://127.0.0.1:9/callback';
  const reg = await (await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], client_name: 'smoke' }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: prm.resource, scope: 'siteverdict.tools' });
  const page = await fetch(`${as.authorization_endpoint}?${q}`);
  const html = await page.text();
  const sealed = /name="req" value="([^"]+)"/.exec(html)?.[1];
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
  if (!sealed || !cookie) fail('consent page');
  const post = await fetch(as.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: base }, body: new URLSearchParams({ req: sealed, action: 'allow', apify_token: 'apify_api_SMOKETEST000000000000000' }) });
  const loc = new URL(post.headers.get('location') ?? 'http://x/');
  if (loc.searchParams.get('iss') !== base || loc.searchParams.get('state') !== 'xyz') fail('authorization response (iss/state)');
  const tok = await (await fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier, resource: prm.resource }) })).json();
  if (!tok.access_token) fail(`token exchange: ${JSON.stringify(tok)}`);
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } });
  const client = new Client({ name: 'smoke-oauth', version: '1.0.0' });
  await client.connect(transport);
  await exercise(client, 'http(oauth)');
  await client.close();
  const keyOnly = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-apify-token': 'apify_api_SMOKETEST000000000000000' }, body: '{}' });
  if (keyOnly.status !== 401) fail('API key accepted although SITEVERDICT_ALLOW_API_KEYS=0');
  await srv.stop();
  log('http(oauth): 401 challenge -> PRM -> AS metadata -> DCR -> consent -> code (iss) -> PKCE token -> tools OK');
}

if (children.size) fail('child processes still running');
log('SMOKE PASS');
