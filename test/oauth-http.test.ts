import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { MockRunner } from '../src/apify/mock.js';
import { CHECK_KEYS, loadConfig } from '../src/config.js';
import { createHttpApp, REMOTE_IP_HEADER } from '../src/http.js';
import { ClientLimiter } from '../src/lib/rateLimit.js';
import { generateKey, Sealer } from '../src/oauth/seal.js';
import { DataResultSchema } from '../src/tools/types.js';

const BASE = 'http://127.0.0.1:3333';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const TOKEN = 'apify_api_TESTTOKEN0000000000000001';

function app(env: Record<string, string> = {}, oauthFetch?: typeof fetch) {
  const config = loadConfig({
    SITEVERDICT_APIFY_USERNAME: 'tester', SITEVERDICT_MOCK_DELAY_MS: '0', SITEVERDICT_DNS_CHECK: 'false', SITEVERDICT_DRY_RUN: '1',
    SITEVERDICT_OAUTH_ENABLED: '1', SITEVERDICT_PUBLIC_URL: BASE, SITEVERDICT_OAUTH_KEYS: generateKey(), SITEVERDICT_OAUTH_VERIFY_APIFY_TOKEN: '0',
    ...env,
  });
  const mock = new MockRunner(0, (id) => CHECK_KEYS.find((k) => config.actorIds[k] === id));
  return createHttpApp({ config, limiter: new ClientLimiter(100, 10), runner: mock, mockRunner: mock, oauthFetch });
}
const req = (path: string, init: RequestInit = {}) => new Request(`${BASE}${path}`, init);
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function authorize(a: ReturnType<typeof app>, clientId: string, challenge: string, resource = `${BASE}/mcp`) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', scope: 'siteverdict.tools', resource });
  const page = await a.fetch(req(`/oauth/authorize?${q}`));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /Your Apify API token/);
  const sealed = /name="req" value="([^"]+)"/.exec(html)![1]!;
  const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
  const post = await a.fetch(req('/oauth/authorize', { ...form({ req: sealed, action: 'allow', apify_token: TOKEN }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: BASE } }));
  assert.equal(post.status, 302);
  const loc = new URL(post.headers.get('location')!);
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get('state'), 'st8');
  assert.equal(loc.searchParams.get('iss'), BASE); // RFC 9207
  return loc.searchParams.get('code')!;
}

test('OAuth discovery: 401 challenge -> PRM -> AS metadata (CIMD, DCR, S256, iss)', async () => {
  const a = app();
  const r = await a.fetch(req('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' }));
  assert.equal(r.status, 401);
  const www = r.headers.get('www-authenticate')!;
  assert.match(www, /resource_metadata="http:\/\/127\.0\.0\.1:3333\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(www, /scope="siteverdict\.tools"/);
  const prm = await (await a.fetch(req('/.well-known/oauth-protected-resource/mcp'))).json() as Record<string, unknown>;
  assert.equal(prm.resource, `${BASE}/mcp`);
  assert.ok(Array.isArray(prm.authorization_servers) && (prm.authorization_servers as string[])[0]!.startsWith(BASE));
  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    const md = await (await a.fetch(req(p))).json() as Record<string, unknown>;
    assert.equal(md.issuer, BASE);
    assert.deepEqual(md.code_challenge_methods_supported, ['S256']);
    assert.equal(md.client_id_metadata_document_supported, true);
    assert.equal(md.authorization_response_iss_parameter_supported, true);
    assert.ok((md.token_endpoint_auth_methods_supported as string[]).includes('none'));
    assert.ok(md.registration_endpoint);
  }
  const travelPrm = await (await a.fetch(req('/.well-known/oauth-protected-resource/mcp/travel'))).json() as Record<string, unknown>;
  assert.equal(travelPrm.resource, `${BASE}/mcp/travel`);
});

test('OAuth: DCR + PKCE code flow -> access token works over Streamable HTTP; codes single-use; refresh rotates', async () => {
  const a = app();
  const reg = await a.fetch(req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude', token_endpoint_auth_method: 'none' }) }));
  assert.equal(reg.status, 201);
  const client = await reg.json() as { client_id: string };
  const { verifier, challenge } = pkce();
  const code = await authorize(a, client.client_id, challenge);

  const bad = await a.fetch(req('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: pkce().verifier })));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as { error: string }).error, 'invalid_grant');

  // the failed attempt consumed the code (single use)
  const { verifier: v2, challenge: c2 } = pkce();
  const code2 = await authorize(a, client.client_id, c2);
  const tok = await a.fetch(req('/oauth/token', form({ grant_type: 'authorization_code', code: code2, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: v2, resource: `${BASE}/mcp` })));
  assert.equal(tok.status, 200);
  assert.equal(tok.headers.get('cache-control'), 'no-store');
  const t = await tok.json() as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
  assert.equal(t.token_type, 'Bearer');
  assert.ok(!t.access_token.includes(TOKEN), 'Apify token is encrypted inside the access token');
  const reuse = await a.fetch(req('/oauth/token', form({ grant_type: 'authorization_code', code: code2, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: v2 })));
  assert.equal(reuse.status, 400);
  void verifier;

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: (input, init) => {
      const h = new Headers(init?.headers);
      h.set('authorization', `Bearer ${t.access_token}`);
      return a.fetch(new Request(input as string | URL, { ...init, headers: h }));
    },
  });
  const mcp = new Client({ name: 'oauth-test', version: '1.0.0' });
  await mcp.connect(transport);
  const { tools } = await mcp.listTools();
  assert.ok(tools.some((x) => x.name === 'full_website_audit'));
  const r = (await mcp.callTool({ name: 'detect_tech_stack', arguments: { urls: ['example.com'] } })) as CallToolResult;
  assert.equal(DataResultSchema.parse(r.structuredContent).dryRun, true);
  await mcp.close();

  // token bound to /mcp is refused on /mcp/travel (RFC 8707 audience)
  const wrongAud = await a.fetch(req('/mcp/travel', { method: 'POST', headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' }));
  assert.equal(wrongAud.status, 401);

  const ref = await a.fetch(req('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client.client_id })));
  assert.equal(ref.status, 200);
  const t2 = await ref.json() as { refresh_token: string };
  const replay = await a.fetch(req('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client.client_id })));
  assert.equal((await replay.json() as { error: string }).error, 'invalid_grant');
  // replay revoked the whole family, so the rotated token is dead too
  const after = await a.fetch(req('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: client.client_id })));
  assert.equal(after.status, 400);
  await a.close();
});

test('OAuth: CIMD client (https client_id URL) and confidential DCR client', async () => {
  const cimdUrl = 'https://chatgpt.com/oauth/client.json';
  const fakeFetch = (async (url: string | URL | Request) => {
    assert.equal(String(url), cimdUrl);
    return new Response(JSON.stringify({ client_id: cimdUrl, client_name: 'ChatGPT', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const a = app({}, fakeFetch);
  const { verifier, challenge } = pkce();
  const code = await authorize(a, cimdUrl, challenge);
  const tok = await a.fetch(req('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: cimdUrl, redirect_uri: REDIRECT, code_verifier: verifier })));
  assert.equal(tok.status, 200);

  const reg = await (await a.fetch(req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' }) }))).json() as { client_id: string; client_secret: string };
  assert.ok(reg.client_secret);
  const p = pkce();
  const code2 = await authorize(a, reg.client_id, p.challenge);
  const noSecret = await a.fetch(req('/oauth/token', form({ grant_type: 'authorization_code', code: code2, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: p.verifier })));
  assert.equal(noSecret.status, 401);
  const p3 = pkce();
  const code3 = await authorize(a, reg.client_id, p3.challenge);
  const basic = Buffer.from(`${encodeURIComponent(reg.client_id)}:${encodeURIComponent(reg.client_secret)}`).toString('base64');
  const ok = await a.fetch(req('/oauth/token', { ...form({ grant_type: 'authorization_code', code: code3, redirect_uri: REDIRECT, code_verifier: p3.verifier }), headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` } }));
  assert.equal(ok.status, 200);
});

test('OAuth: bad requests are refused (no PKCE, unknown redirect, bad token, deny, foreign resource)', async () => {
  const a = app({ SITEVERDICT_OAUTH_REDIRECT_HOSTS: 'claude.ai,chatgpt.com' });
  const reg = await (await a.fetch(req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) }))).json() as { client_id: string };
  const evil = await a.fetch(req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) }));
  assert.equal(evil.status, 400);
  const noPkce = await a.fetch(req(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, state: 's' })}`));
  assert.equal(noPkce.status, 302);
  assert.equal(new URL(noPkce.headers.get('location')!).searchParams.get('error'), 'invalid_request');
  const wrongRedirect = await a.fetch(req(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/other', code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`));
  assert.equal(wrongRedirect.status, 400);
  const foreign = await a.fetch(req(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' })}`));
  assert.equal(new URL(foreign.headers.get('location')!).searchParams.get('error'), 'invalid_target');
  const tampered = await a.fetch(req('/mcp', { method: 'POST', headers: { authorization: 'Bearer svat_aaaa.bbbb.cccc.dddd', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' }));
  assert.equal(tampered.status, 401);
  assert.match(tampered.headers.get('www-authenticate') ?? '', /invalid_token/);
  // consent POST without the nonce cookie is refused
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
  const html = await (await a.fetch(req(`/oauth/authorize?${q}`))).text();
  const sealed = /name="req" value="([^"]+)"/.exec(html)![1]!;
  const noCookie = await a.fetch(req('/oauth/authorize', form({ req: sealed, action: 'allow', apify_token: TOKEN })));
  assert.equal(noCookie.status, 400);
});

test('OAuth enabled: API-key fallback still works unless disabled', async () => {
  const a = app();
  const init = { method: 'POST', headers: { 'x-apify-token': TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) };
  const ok = await a.fetch(req('/mcp', init));
  assert.notEqual(ok.status, 401);
  const strict = app({ SITEVERDICT_ALLOW_API_KEYS: '0' });
  const refused = await strict.fetch(req('/mcp', init));
  assert.equal(refused.status, 401);
});

test('sealer: tamper / wrong purpose / rotation', () => {
  const k1 = generateKey();
  const k2 = generateKey();
  const s1 = new Sealer([k1]);
  const t = s1.seal('access', { a: 1 });
  assert.deepEqual(s1.open('access', t), { a: 1 });
  assert.equal(s1.open('refresh', t), undefined);
  assert.equal(s1.open('access', t.slice(0, -2) + 'AA'), undefined);
  const rotated = new Sealer([k2, k1]);
  assert.deepEqual(rotated.open('access', t), { a: 1 });
  assert.throws(() => new Sealer(['short']), /32 random bytes/);
});

/* ------------------------------------------------------------------ HTTP hardening */

function plain(env: Record<string, string> = {}) {
  const config = loadConfig({ SITEVERDICT_APIFY_USERNAME: 'tester', SITEVERDICT_MOCK_DELAY_MS: '0', SITEVERDICT_DNS_CHECK: 'false', SITEVERDICT_DRY_RUN: '1', ...env });
  const mock = new MockRunner(0, (id) => CHECK_KEYS.find((k) => config.actorIds[k] === id));
  return createHttpApp({ config, limiter: new ClientLimiter(100, 10), runner: mock, mockRunner: mock });
}

test('HTTP: CORS preflight for allowed origins only', async () => {
  const a = plain({ SITEVERDICT_ALLOWED_ORIGINS: 'https://inspector.example' });
  const ok = await a.fetch(req('/mcp', { method: 'OPTIONS', headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST' } }));
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://inspector.example');
  assert.match(ok.headers.get('access-control-allow-headers') ?? '', /mcp-protocol-version/);
  const bad = await a.fetch(req('/mcp', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
  assert.equal(bad.status, 403);
  const wk = await a.fetch(req('/healthz', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
  assert.equal(wk.status, 204);
});

test('HTTP: body size limit (413) and per-IP rate limit (429)', async () => {
  const a = plain({ SITEVERDICT_MAX_BODY_BYTES: '2048', SITEVERDICT_IP_RATE_PER_MINUTE: '3' });
  const big = await a.fetch(req('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', [REMOTE_IP_HEADER]: '203.0.113.9' }, body: 'x'.repeat(5000) }));
  assert.equal(big.status, 413);
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('y'.repeat(4000))); c.close(); } });
  const chunked = await a.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', [REMOTE_IP_HEADER]: '203.0.113.10' }, body: stream, duplex: 'half' } as RequestInit));
  assert.equal(chunked.status, 413);
  let last = 0;
  for (let i = 0; i < 5; i++) last = (await a.fetch(req('/healthz', { headers: { [REMOTE_IP_HEADER]: '203.0.113.11' } }))).status;
  assert.equal(last, 429);
});

test('HTTP: toolsets per connection via path or query; bad toolset -> 400', async () => {
  const a = plain();
  const list = async (path: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}${path}`), { fetch: (input, init) => a.fetch(new Request(input as string | URL, init)) });
    const c = new Client({ name: 't', version: '1' });
    await c.connect(transport);
    const names = (await c.listTools()).tools.map((t) => t.name);
    await c.close();
    return names;
  };
  const travel = await list('/mcp/travel');
  assert.ok(travel.includes('visa_entry_check') && !travel.includes('full_website_audit'));
  const q = await list('/mcp?toolsets=property,compliance');
  assert.ok(q.includes('uk_property_data') && q.includes('sanctions_screen') && !q.includes('visa_entry_check'));
  const bad = await a.fetch(req('/mcp?toolsets=nope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(bad.status, 400);
  const health = await (await a.fetch(req('/health'))).json() as { ok: boolean; toolsets: string[] };
  assert.equal(health.ok, true);
  assert.deepEqual(health.toolsets, ['web']);
});
