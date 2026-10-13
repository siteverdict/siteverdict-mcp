import { createServer as createNodeServer, type Server as NodeServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler, getOAuthProtectedResourceMetadataUrl, localhostAllowedHostnames, localhostAllowedOrigins,
  oauthMetadataResponse, validateHostHeader, validateOriginHeader, verifyBearerToken, bearerAuthChallengeResponse,
  type OAuthMetadata,
} from '@modelcontextprotocol/server';
import { httpAuth, type CallerAuth } from './auth.js';
import { BRAND, SERVER_VERSION } from './brand.js';
import type { Config } from './config.js';
import { AuthError, UserInputError, redact } from './lib/errors.js';
import { OAuthServer, SCOPE } from './oauth/server.js';
import { createServer, type ServerDeps } from './server.js';
import { parseToolAllowList, parseToolsets, type ToolsetId } from './toolsets.js';

export type HttpDeps = Omit<ServerDeps, 'auth'> & {
  /** fetch used by the OAuth server (CIMD documents, Apify token check). Tests inject a fake. */
  oauthFetch?: typeof globalThis.fetch;
};

/** Internal header carrying the socket IP from the Node layer (any client-sent value is overwritten). */
export const REMOTE_IP_HEADER = 'x-siteverdict-remote-ip';
/** Remote clients (Claude: 240 s tool timeout) must get an answer before they give up. */
export const HTTP_MAX_DEFAULT_WAIT_SECS = 200;

const CORS_ALLOW_HEADERS = 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, last-event-id, x-apify-token, x-api-key';
const CORS_EXPOSE_HEADERS = 'www-authenticate, mcp-session-id, mcp-protocol-version, retry-after, x-ratelimit-limit, x-ratelimit-remaining';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const rpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  json(status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers);

/** Fixed-window per-IP request limiter (in memory; use a shared store such as Redis for more than one instance). */
class IpLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly perMinute: number) {}
  take(key: string, cost = 1): { ok: boolean; remaining: number; retryAfter: number } {
    const t = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= t) {
      e = { n: 0, reset: t + 60_000 };
      this.hits.set(key, e);
      if (this.hits.size > 20_000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    }
    e.n += cost;
    return { ok: e.n <= this.perMinute, remaining: Math.max(0, this.perMinute - e.n), retryAfter: Math.ceil((e.reset - t) / 1000) };
  }
}

async function readLimited(req: Request, max: number): Promise<Uint8Array | 'too_large'> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return 'too_large';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Web-standard Streamable HTTP endpoint (deployable on Node now, Workers/Deno/Bun later).
 *  - Stateless per request: 2026-07-28 clients natively, 2025-era clients via the SDK's stateless legacy fallback.
 *  - Host + Origin validation (DNS rebinding), CORS for allowed browser origins, per-IP rate limit, body size limit.
 *  - Auth: OAuth 2.1 (built-in AS, see src/oauth) when SITEVERDICT_OAUTH_ENABLED=1, plus API-key fallback
 *    (X-Apify-Token / Authorization: Bearer apify_api_… / X-API-Key: sv_…) unless SITEVERDICT_ALLOW_API_KEYS=0.
 *  - Toolsets per connection: /mcp?toolsets=web,travel or /mcp/web+travel.
 *  - Health: GET /healthz (and /health).
 */
export function createHttpApp(deps: HttpDeps): { fetch: (req: Request) => Promise<Response>; close: () => Promise<void>; oauth?: OAuthServer } {
  const config: Config = { ...deps.config, defaultWaitSecs: Math.min(deps.config.defaultWaitSecs, HTTP_MAX_DEFAULT_WAIT_SECS) };
  const base = config.http.path.replace(/\/$/, '') || '/mcp';
  const publicUrl = config.oauth.publicUrl ? new URL(config.oauth.publicUrl) : undefined;
  const allowedHosts = [...localhostAllowedHostnames(), ...config.http.allowedHosts, ...(publicUrl ? [publicUrl.hostname] : [])];
  const allowedOrigins = [...localhostAllowedOrigins(), ...config.http.allowedOrigins, ...(publicUrl ? [publicUrl.origin] : [])];
  const oauth = config.oauth.enabled ? new OAuthServer(config, { apifyBaseUrl: config.apifyBaseUrl, resolver: deps.resolver, log: deps.log, fetch: deps.oauthFetch }) : undefined;
  const ipLimiter = new IpLimiter(config.http.ipRatePerMinute);

  const mcp = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as { caller?: CallerAuth; toolsets?: Set<ToolsetId>; toolAllow?: Set<string> } | undefined;
      const auth = extra?.caller ?? { clientKey: 'anonymous', source: 'none' as const };
      const { oauthFetch: _f, ...serverDeps } = deps;
      return createServer({ ...serverDeps, config, auth, toolsets: extra?.toolsets, toolAllow: extra?.toolAllow });
    },
    { legacy: 'stateless', onerror: (e) => deps.log?.(`mcp http: ${redact(e.message)}`) },
  );

  const corsFor = (origin: string | null): Record<string, string> =>
    origin && allowedOrigins.includes(origin)
      ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': CORS_ALLOW_HEADERS, 'access-control-expose-headers': CORS_EXPOSE_HEADERS, 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-max-age': '600' }
      : {};
  const withHeaders = (res: Response, headers: Record<string, string>): Response => {
    if (!Object.keys(headers).length) return res;
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  };

  /** Resolves /mcp, /mcp/<toolsets> -> toolset selection; undefined = not an MCP path. */
  function mcpRoute(url: URL): { toolsets?: Set<ToolsetId>; toolAllow?: Set<string>; resource: string } | undefined | 'bad' {
    const p = url.pathname.replace(/\/$/, '');
    let seg: string | undefined;
    if (p === base) seg = undefined;
    else if (p.startsWith(`${base}/`) && /^[a-z+,]{2,80}$/.test(p.slice(base.length + 1))) seg = p.slice(base.length + 1);
    else return undefined;
    const raw = seg?.replace(/\+/g, ',') ?? url.searchParams.get('toolsets');
    try {
      const toolsets = raw ? parseToolsets(raw, [...config.toolsets]) : undefined;
      const tools = url.searchParams.get('tools');
      return { toolsets, toolAllow: tools ? parseToolAllowList(tools) : undefined, resource: `${publicUrl ? publicUrl.origin : url.origin}${p}` };
    } catch {
      return 'bad';
    }
  }

  const prmUrl = (resource: string) => getOAuthProtectedResourceMetadataUrl(new URL(resource));
  const oauthMeta = oauth ? (oauth.metadata() as unknown as OAuthMetadata) : undefined;

  async function fetch(inReq: Request): Promise<Response> {
    let req = inReq;
    const url = new URL(req.url);
    const ip = req.headers.get(REMOTE_IP_HEADER) ?? 'unknown';
    const origin = req.headers.get('origin');
    const cors = corsFor(origin);
    const isPublicDoc = url.pathname.startsWith('/.well-known/') || url.pathname === '/healthz' || url.pathname === '/health';

    // DNS-rebinding protection. Node requests carry Host; web-standard Requests may not (forbidden header), so fall back to the URL host.
    const host = validateHostHeader(req.headers.get('host') ?? url.host, allowedHosts);
    if (!host.ok) return rpcError(403, `Forbidden: ${host.message}`);

    if (req.method === 'OPTIONS') {
      if (isPublicDoc || url.pathname === '/oauth/token' || url.pathname === '/oauth/register' || url.pathname === '/oauth/revoke') {
        return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': CORS_ALLOW_HEADERS, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '600' } });
      }
      return origin && Object.keys(cors).length ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
    }

    // Per-IP limit (OAuth endpoints cost 4: they are cheap to call and attractive to abuse).
    const cost = url.pathname.startsWith('/oauth/') ? 4 : 1;
    const rl = ipLimiter.take(ip, cost);
    if (!rl.ok) return withHeaders(json(429, { error: 'rate_limited', message: `Too many requests. Retry in ${rl.retryAfter}s.` }, { 'retry-after': String(rl.retryAfter) }), cors);

    // Body size limit (Content-Length fast path, then a streaming cap for chunked bodies).
    if (req.method === 'POST' || req.method === 'PUT') {
      const len = Number(req.headers.get('content-length') ?? '0');
      if (len > config.http.maxBodyBytes) return withHeaders(json(413, { error: 'payload_too_large', limit: config.http.maxBodyBytes }), cors);
      const body = await readLimited(req, config.http.maxBodyBytes);
      if (body === 'too_large') return withHeaders(json(413, { error: 'payload_too_large', limit: config.http.maxBodyBytes }), cors);
      req = new Request(req.url, { method: req.method, headers: req.headers, body });
    }

    if ((url.pathname === '/healthz' || url.pathname === '/health') && req.method === 'GET') {
      return json(200, { ok: true, name: BRAND.registryName, version: SERVER_VERSION, mode: config.mode, dryRun: config.dryRun, oauth: Boolean(oauth), toolsets: [...config.toolsets] }, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/.well-known/openai-apps-challenge' && req.method === 'GET') {
      const token = process.env.SITEVERDICT_OPENAI_APPS_CHALLENGE;
      return token ? new Response(token, { headers: { 'content-type': 'text/plain' } }) : json(404, { error: 'not_found' });
    }

    // OAuth discovery: RFC 9728 PRM (path-aware) + RFC 8414 AS metadata.
    if (oauth && oauthMeta && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      const resPath = url.pathname.slice('/.well-known/oauth-protected-resource'.length) || base;
      const route = mcpRoute(new URL(resPath, url.origin));
      if (!route || route === 'bad') return json(404, { error: 'not_found' });
      const res = oauthMetadataResponse(new Request(new URL(`/.well-known/oauth-protected-resource${new URL(route.resource).pathname}`, url.origin), { method: req.method }), {
        oauthMetadata: oauthMeta,
        resourceServerUrl: new URL(route.resource),
        scopesSupported: [SCOPE],
        resourceName: BRAND.displayName,
        serviceDocumentationUrl: new URL(`https://github.com/${BRAND.githubOwner}/${BRAND.githubRepo}#readme`),
        dangerouslyAllowInsecureIssuerUrl: oauth.issuer.startsWith('http://'),
      });
      if (res) return res;
    }
    if (oauth) {
      // The consent form POST must come from our own origin (browsers send Origin on form posts).
      if (url.pathname === '/oauth/authorize' && req.method === 'POST' && origin && origin !== publicUrl?.origin && !allowedOrigins.includes(origin)) {
        return rpcError(403, 'Forbidden: cross-origin form post');
      }
      const r = await oauth.handle(req);
      if (r) return url.pathname === '/oauth/token' || url.pathname === '/oauth/register' || url.pathname === '/oauth/revoke' || url.pathname.startsWith('/.well-known/') ? withHeaders(r, { 'access-control-allow-origin': '*' }) : r;
    }

    const route = mcpRoute(url);
    if (route === 'bad') return withHeaders(json(400, { error: 'invalid_toolsets', message: 'Unknown toolset. Valid: web, marketing, leads, compliance, travel, property, all.' }), cors);
    if (!route) return json(404, { error: 'not_found' });

    // MCP endpoint: browsers must come from an allowed Origin; server-side clients (Claude, ChatGPT) send none.
    const originCheck = validateOriginHeader(origin, allowedOrigins);
    if (!originCheck.ok) return rpcError(403, `Forbidden: ${originCheck.message}`);

    const authz = req.headers.get('authorization') ?? '';
    const bearer = /^Bearer\s+(\S+)/i.exec(authz)?.[1];
    let caller: CallerAuth;
    if (oauth && bearer?.startsWith('svat_')) {
      try {
        const info = await verifyBearerToken(authz, { verifier: oauth.verifier(), requiredScopes: [SCOPE], resourceMetadataUrl: prmUrl(route.resource), expectedResource: new URL(route.resource) });
        caller = (info.extra as { caller: CallerAuth }).caller;
      } catch (err) {
        return withHeaders(bearerAuthChallengeResponse(err, { requiredScopes: [SCOPE], resourceMetadataUrl: prmUrl(route.resource) }), cors);
      }
    } else {
      const hasKey = Boolean(bearer || req.headers.get('x-apify-token') || req.headers.get('x-api-key'));
      if (oauth && (!hasKey || !config.http.allowApiKeys)) {
        // 401 + WWW-Authenticate starts the OAuth flow in Claude / ChatGPT (MCP authorization spec).
        return withHeaders(
          json(401, { error: 'unauthorized', message: 'Sign in with OAuth (or send an API key where allowed).' }, { 'www-authenticate': `Bearer resource_metadata="${prmUrl(route.resource)}", scope="${SCOPE}"` }),
          cors,
        );
      }
      try {
        caller = httpAuth(config, req.headers, ip);
      } catch (err) {
        if (err instanceof AuthError) return withHeaders(json(401, { error: 'unauthorized', message: err.message }, { 'www-authenticate': 'Bearer realm="mcp"' }), cors);
        if (err instanceof UserInputError) return withHeaders(json(400, { error: 'bad_request', message: err.message }), cors);
        throw err;
      }
    }
    const res = await mcp.fetch(req, {
      authInfo: { token: 'redacted', clientId: caller.clientKey, scopes: caller.scopes ?? [], extra: { caller, toolsets: route.toolsets, toolAllow: route.toolAllow } },
    });
    return withHeaders(res, { ...cors, 'x-accel-buffering': 'no', 'x-ratelimit-limit': String(config.http.ipRatePerMinute), 'x-ratelimit-remaining': String(rl.remaining) });
  }

  return { fetch, close: () => mcp.close(), oauth };
}

/** Starts a Node HTTP listener. Binds 127.0.0.1 by default; put a TLS reverse proxy in front for remote use. */
export function startHttpServer(deps: HttpDeps): Promise<NodeServer> {
  const app = createHttpApp(deps);
  const handler = toNodeHandler({ fetch: (r: Request) => app.fetch(r) });
  const trustProxy = deps.config.http.trustProxy;
  const server = createNodeServer((req, res) => {
    const fwd = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    req.headers[REMOTE_IP_HEADER] = fwd || req.socket.remoteAddress || 'unknown';
    void Promise.resolve(handler(req, res)).catch((err: unknown) => {
      deps.log?.(`http error: ${redact(String(err))}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.requestTimeout = 300_000;
  server.headersTimeout = 30_000;
  const { host, port } = deps.config.http;
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

export function describeHttp(config: Config): string {
  return `http://${config.http.host}:${config.http.port}${config.http.path}`;
}
