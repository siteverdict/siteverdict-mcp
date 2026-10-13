import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { clientKeyFor, isSiteVerdictApiKey, type CallerAuth } from '../auth.js';
import { BRAND } from '../brand.js';
import type { Config } from '../config.js';
import { redact } from '../lib/errors.js';
import { validatePublicUrl, type Resolver } from '../lib/validate.js';
import { consentPage, errorPage } from './pages.js';
import { JtiList, Sealer } from './seal.js';

/**
 * Built-in OAuth 2.1 Authorization Server for the remote MCP endpoint (MCP authorization spec 2025-11-25 / 2026-07-28):
 *  - RFC 8414 metadata (+ OIDC discovery alias), RFC 9728 PRM is served by http.ts via the SDK.
 *  - Authorization code + PKCE S256 only; RFC 8707 resource binding (token audience = the MCP URL);
 *    RFC 9207 `iss` in the authorization response; refresh-token rotation for public clients.
 *  - Client ID Metadata Documents (client_id = https URL) preferred; RFC 7591 Dynamic Client Registration as fallback.
 *  - "Login" = the user pastes THEIR OWN Apify token (BYOK billing) or SiteVerdict API key on our consent page.
 *    It is sealed (AES-GCM) into the access token; the MCP server never stores it and never passes OAuth tokens upstream.
 */
export const SCOPE = 'siteverdict.tools';
const CODE_TTL = 120;
const AUTHREQ_TTL = 600;
const now = () => Math.floor(Date.now() / 1000);
const b64u = (b: Buffer) => b.toString('base64url');

interface ClientInfo {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
  kind: 'dcr' | 'cimd';
}
interface DcrPayload { ru: string[]; n?: string; m: ClientInfo['token_endpoint_auth_method']; iat: number }
interface AuthReq { cid: string; ru: string; cc: string; st?: string; sc: string; res: string; exp: number; nonce: string }
interface Cred { t?: string; k?: string }
interface CodePayload { cid: string; ru: string; cc: string; sc: string; res: string; cred: Cred; exp: number; jti: string }
interface TokenPayload { cid: string; sc: string; res: string; cred: Cred; exp: number; jti: string; fam?: string }

export interface OAuthDeps {
  fetch?: typeof globalThis.fetch;
  resolver?: Resolver;
  log?: (m: string) => void;
  apifyBaseUrl: string;
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache', ...extra } });
const oauthErr = (status: number, error: string, description: string, extra: Record<string, string> = {}) => json(status, { error, error_description: description }, extra);

function isLoopback(u: URL): boolean {
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

export class OAuthServer {
  readonly issuer: string;
  readonly sealer: Sealer;
  private readonly used = new JtiList();
  private readonly revoked = new JtiList();
  private readonly cimdCache = new Map<string, { info: ClientInfo; until: number }>();
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: Config, private readonly deps: OAuthDeps) {
    if (!config.oauth.publicUrl) throw new Error('SITEVERDICT_PUBLIC_URL is required when SITEVERDICT_OAUTH_ENABLED=1 (e.g. https://mcp.webrevenuescan.com).');
    this.issuer = config.oauth.publicUrl;
    this.sealer = new Sealer(config.oauth.keys);
    if (this.sealer.ephemeral) deps.log?.('WARNING: SITEVERDICT_OAUTH_KEYS not set: using an ephemeral key; all OAuth tokens die on restart.');
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** The MCP base resource, e.g. https://mcp.webrevenuescan.com/mcp */
  get baseResource(): string {
    return `${this.issuer}${this.config.http.path}`;
  }

  /** Any /mcp or /mcp/<toolsets> URL on this server is a valid resource indicator. */
  isOurResource(res: string): boolean {
    const r = res.replace(/#.*$/, '').replace(/\/$/, '');
    return r === this.baseResource || (r.startsWith(`${this.baseResource}/`) && /^[a-z+,]{2,80}$/.test(r.slice(this.baseResource.length + 1)));
  }

  metadata(): Record<string, unknown> {
    const i = this.issuer;
    return {
      issuer: i,
      authorization_endpoint: `${i}/oauth/authorize`,
      token_endpoint: `${i}/oauth/token`,
      registration_endpoint: `${i}/oauth/register`,
      revocation_endpoint: `${i}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `https://github.com/${BRAND.githubOwner}/${BRAND.githubRepo}#readme`,
      op_policy_uri: `${BRAND.website}/privacy`,
      op_tos_uri: `${BRAND.website}/terms`,
    };
  }

  /** Routes OAuth endpoints; returns undefined for other paths. */
  async handle(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration') {
      return req.method === 'GET' ? json(200, this.metadata(), { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' }) : json(405, { error: 'method_not_allowed' });
    }
    if (!p.startsWith('/oauth/')) return undefined;
    try {
      if (p === '/oauth/register' && req.method === 'POST') return await this.register(req);
      if (p === '/oauth/authorize' && req.method === 'GET') return await this.authorizeGet(url);
      if (p === '/oauth/authorize' && req.method === 'POST') return await this.authorizePost(req);
      if (p === '/oauth/token' && req.method === 'POST') return await this.token(req);
      if (p === '/oauth/revoke' && req.method === 'POST') return await this.revoke(req);
    } catch (err) {
      this.deps.log?.(`oauth error: ${redact(String((err as Error)?.message ?? err))}`);
      return oauthErr(500, 'server_error', 'Unexpected error.');
    }
    return json(404, { error: 'not_found' });
  }

  /* --------------------------------------------------------------- clients */

  private validRedirect(raw: unknown): string | undefined {
    if (typeof raw !== 'string' || raw.length > 2000) return undefined;
    let u: URL;
    try { u = new URL(raw); } catch { return undefined; }
    if (u.hash || u.username || u.password) return undefined;
    if (u.protocol !== 'https:' && !isLoopback(u)) return undefined;
    const hosts = this.config.oauth.redirectHosts;
    if (hosts.length && !isLoopback(u) && !hosts.includes(u.hostname.toLowerCase())) return undefined;
    return u.toString();
  }

  private async register(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; } catch { return oauthErr(400, 'invalid_client_metadata', 'Body must be JSON.'); }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    const ru = uris.map((u) => this.validRedirect(u));
    if (!ru.length || ru.length > 10 || ru.some((u) => !u)) return oauthErr(400, 'invalid_redirect_uri', 'redirect_uris must be 1-10 https (or loopback http) URIs without fragments.');
    const method = (body.token_endpoint_auth_method ?? 'none') as string;
    const m = (['none', 'client_secret_post', 'client_secret_basic'].includes(method) ? method : 'none') as DcrPayload['m'];
    const grants = Array.isArray(body.grant_types) ? (body.grant_types as string[]) : ['authorization_code', 'refresh_token'];
    if (grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) return oauthErr(400, 'invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported.');
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : undefined;
    const iat = now();
    const clientId = `svc_${this.sealer.seal('client', { ru: ru as string[], n: name, m, iat } satisfies DcrPayload)}`;
    return json(201, {
      client_id: clientId,
      client_id_issued_at: iat,
      ...(m !== 'none' ? { client_secret: this.sealer.clientSecret(clientId), client_secret_expires_at: 0 } : {}),
      redirect_uris: ru,
      token_endpoint_auth_method: m,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(name ? { client_name: name } : {}),
      scope: SCOPE,
    });
  }

  /** DCR client (sealed id) or CIMD client (https URL -> metadata document). */
  async resolveClient(clientId: string): Promise<ClientInfo | undefined> {
    if (clientId.startsWith('svc_')) {
      const d = this.sealer.open<DcrPayload>('client', clientId.slice(4));
      return d ? { client_id: clientId, client_name: d.n, redirect_uris: d.ru, token_endpoint_auth_method: d.m, kind: 'dcr' } : undefined;
    }
    if (!/^https:\/\/[^/]+\/.+/.test(clientId) || clientId.length > 1000) return undefined;
    const hit = this.cimdCache.get(clientId);
    if (hit && hit.until > Date.now()) return hit.info;
    try {
      // SSRF guard: public https host only, no redirects, 5 s timeout, 64 KB cap.
      await validatePublicUrl(clientId, { dnsCheck: this.config.dnsCheck, resolver: this.deps.resolver });
      const res = await this.fetchImpl(clientId, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
      if (!res.ok) return undefined;
      const text = await res.text();
      if (text.length > 65_536) return undefined;
      const doc = JSON.parse(text) as Record<string, unknown>;
      if (doc.client_id !== clientId) return undefined;
      const ru = (Array.isArray(doc.redirect_uris) ? doc.redirect_uris : []).map((u) => this.validRedirect(u)).filter((u): u is string => Boolean(u));
      if (!ru.length) return undefined;
      const m = doc.token_endpoint_auth_method === undefined || doc.token_endpoint_auth_method === 'none' ? 'none' : undefined;
      if (!m) return undefined; // CIMD clients are public (private_key_jwt not supported here)
      const info: ClientInfo = { client_id: clientId, client_name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : undefined, redirect_uris: ru, token_endpoint_auth_method: 'none', kind: 'cimd' };
      this.cimdCache.set(clientId, { info, until: Date.now() + 3600_000 });
      if (this.cimdCache.size > 1000) this.cimdCache.delete(this.cimdCache.keys().next().value!);
      return info;
    } catch {
      return undefined;
    }
  }

  /* --------------------------------------------------------------- authorize */

  private redirectWith(ru: string, params: Record<string, string | undefined>): Response {
    const u = new URL(ru);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set('iss', this.issuer);
    return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } });
  }

  private async authorizeGet(url: URL): Promise<Response> {
    const q = url.searchParams;
    const client = await this.resolveClient(q.get('client_id') ?? '');
    if (!client) return errorPage(400, 'Unknown client', 'This app is not registered with this server (invalid client_id).');
    const ru = q.get('redirect_uri') ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : '');
    if (!client.redirect_uris.includes(ru)) return errorPage(400, 'Invalid redirect', 'redirect_uri does not exactly match a registered redirect URI.');
    const state = q.get('state') ?? undefined;
    if (q.get('response_type') !== 'code') return this.redirectWith(ru, { error: 'unsupported_response_type', state });
    const cc = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(cc)) return this.redirectWith(ru, { error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required.', state });
    const res = (q.get('resource') ?? this.baseResource).replace(/\/$/, '');
    if (!this.isOurResource(res)) return this.redirectWith(ru, { error: 'invalid_target', error_description: 'Unknown resource.', state });
    const requested = (q.get('scope') ?? SCOPE).split(/\s+/).filter(Boolean);
    const unknown = requested.filter((s) => s !== SCOPE && s !== 'offline_access');
    if (unknown.length) return this.redirectWith(ru, { error: 'invalid_scope', error_description: `Unsupported scope: ${unknown.join(' ')}`, state });
    const nonce = b64u(randomBytes(16));
    const ar: AuthReq = { cid: client.client_id, ru, cc, st: state, sc: SCOPE, res, exp: now() + AUTHREQ_TTL, nonce };
    const sealed = this.sealer.seal('authreq', ar);
    return consentPage({
      sealed,
      clientName: client.client_name ?? new URL(ru).hostname,
      redirectHost: new URL(ru).host,
      redirectOrigin: new URL(ru).origin,
      secureCookie: this.issuer.startsWith('https://'),
      nonce,
      apiKeyAllowed: Boolean(this.config.apiBaseUrl),
    });
  }

  private async verifyApifyToken(token: string): Promise<boolean> {
    if (!this.config.oauth.verifyApifyToken) return true;
    try {
      const res = await this.fetchImpl(`${this.deps.apifyBaseUrl}/v2/users/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async authorizePost(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const ar = this.sealer.open<AuthReq>('authreq', form.get('req') ?? '');
    if (!ar || ar.exp < now()) return errorPage(400, 'Request expired', 'This sign-in request expired. Go back to your AI app and connect again.');
    const cookie = /(?:^|;\s*)sv_oauth_nonce=([A-Za-z0-9_-]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
    if (!cookie || cookie !== ar.nonce) return errorPage(400, 'Session mismatch', 'Please start the connection again from your AI app (cookie check failed).');
    if (form.get('action') !== 'allow') return this.redirectWith(ar.ru, { error: 'access_denied', state: ar.st });
    const t = (form.get('apify_token') ?? '').trim();
    const k = (form.get('api_key') ?? '').trim();
    const rerender = (msg: string) =>
      consentPage({ sealed: form.get('req')!, clientName: '', redirectHost: new URL(ar.ru).host, redirectOrigin: new URL(ar.ru).origin, secureCookie: this.issuer.startsWith('https://'), nonce: ar.nonce, apiKeyAllowed: Boolean(this.config.apiBaseUrl), error: msg, keepCookie: true });
    const cred: Cred = {};
    if (t) {
      if (!/^apify_api_[A-Za-z0-9]{20,100}$/.test(t)) return rerender('That does not look like an Apify API token (it starts with apify_api_).');
      if (!(await this.verifyApifyToken(t))) return rerender('Apify did not accept that token. Copy it again from console.apify.com → Settings → API & Integrations.');
      cred.t = t;
    }
    if (k) {
      if (!this.config.apiBaseUrl || !isSiteVerdictApiKey(k)) return rerender('That is not a valid SiteVerdict API key.');
      cred.k = k;
    }
    if (!cred.t && !cred.k) return rerender('Paste your Apify API token to continue.');
    const code = `svac_${this.sealer.seal('code', { cid: ar.cid, ru: ar.ru, cc: ar.cc, sc: ar.sc, res: ar.res, cred, exp: now() + CODE_TTL, jti: b64u(randomBytes(12)) } satisfies CodePayload)}`;
    const resp = this.redirectWith(ar.ru, { code, state: ar.st });
    resp.headers.append('set-cookie', `sv_oauth_nonce=; Path=/oauth; Max-Age=0; HttpOnly; SameSite=Lax${this.issuer.startsWith('https://') ? '; Secure' : ''}`);
    return resp;
  }

  /* --------------------------------------------------------------- token */

  private async readParams(req: Request): Promise<URLSearchParams> {
    const ct = req.headers.get('content-type') ?? '';
    const text = await req.text();
    if (ct.includes('application/json')) {
      const o = JSON.parse(text || '{}') as Record<string, string>;
      return new URLSearchParams(Object.entries(o).map(([a, b]): [string, string] => [a, String(b)]));
    }
    return new URLSearchParams(text);
  }

  /** Authenticates the client per its registered method. */
  private async authClient(req: Request, form: URLSearchParams): Promise<ClientInfo | Response> {
    let id = form.get('client_id') ?? '';
    let secret = form.get('client_secret') ?? undefined;
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (basic) {
      const [u, p] = Buffer.from(basic, 'base64').toString('utf8').split(':');
      id = decodeURIComponent(u ?? '');
      secret = decodeURIComponent(p ?? '');
    }
    const client = await this.resolveClient(id);
    if (!client) return oauthErr(401, 'invalid_client', 'Unknown client.');
    if (client.token_endpoint_auth_method !== 'none') {
      if (!secret || !this.sealer.checkClientSecret(client.client_id, secret)) return oauthErr(401, 'invalid_client', 'Client authentication failed.');
    }
    return client;
  }

  private issue(cid: string, sc: string, res: string, cred: Cred, fam?: string): Record<string, unknown> {
    const t = now();
    const access = `svat_${this.sealer.seal('access', { cid, sc, res, cred, exp: t + this.config.oauth.accessTokenTtlSecs, jti: b64u(randomBytes(12)) } satisfies TokenPayload)}`;
    const family = fam ?? b64u(randomBytes(12));
    const refresh = `svrt_${this.sealer.seal('refresh', { cid, sc, res, cred, exp: t + this.config.oauth.refreshTokenTtlSecs, jti: b64u(randomBytes(12)), fam: family } satisfies TokenPayload)}`;
    return { access_token: access, token_type: 'Bearer', expires_in: this.config.oauth.accessTokenTtlSecs, refresh_token: refresh, scope: sc };
  }

  private async token(req: Request): Promise<Response> {
    let form: URLSearchParams;
    try { form = await this.readParams(req); } catch { return oauthErr(400, 'invalid_request', 'Malformed body.'); }
    const client = await this.authClient(req, form);
    if (client instanceof Response) return client;
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const raw = form.get('code') ?? '';
      const c = raw.startsWith('svac_') ? this.sealer.open<CodePayload>('code', raw.slice(5)) : undefined;
      if (!c || c.exp < now() || this.used.has(c.jti)) return oauthErr(400, 'invalid_grant', 'Authorization code is invalid, expired or already used.');
      this.used.add(c.jti, c.exp + 60);
      if (c.cid !== client.client_id) return oauthErr(400, 'invalid_grant', 'Code was issued to another client.');
      if ((form.get('redirect_uri') ?? c.ru) !== c.ru) return oauthErr(400, 'invalid_grant', 'redirect_uri mismatch.');
      const verifier = form.get('code_verifier') ?? '';
      const expected = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
      const got = Buffer.from(c.cc);
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || expected.length !== got.length || !timingSafeEqual(expected, got)) return oauthErr(400, 'invalid_grant', 'PKCE verification failed.');
      const res = form.get('resource');
      if (res && res.replace(/\/$/, '') !== c.res) return oauthErr(400, 'invalid_target', 'resource does not match the authorization request.');
      return json(200, this.issue(c.cid, c.sc, c.res, c.cred));
    }
    if (grant === 'refresh_token') {
      const raw = form.get('refresh_token') ?? '';
      const r = raw.startsWith('svrt_') ? this.sealer.open<TokenPayload>('refresh', raw.slice(5)) : undefined;
      if (r && this.revoked.has(r.jti) && r.fam) this.revoked.add(`fam:${r.fam}`, r.exp); // reuse of a rotated token: revoke the whole family
      if (!r || r.exp < now() || this.revoked.has(r.jti) || (r.fam && this.revoked.has(`fam:${r.fam}`))) return oauthErr(400, 'invalid_grant', 'Refresh token is invalid, expired or revoked.');
      if (r.cid !== client.client_id) return oauthErr(400, 'invalid_grant', 'Refresh token was issued to another client.');
      const res = form.get('resource');
      if (res && res.replace(/\/$/, '') !== r.res) return oauthErr(400, 'invalid_target', 'resource does not match.');
      this.revoked.add(r.jti, r.exp); // rotation: each refresh token works once
      return json(200, this.issue(r.cid, r.sc, r.res, r.cred, r.fam));
    }
    return oauthErr(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }

  private async revoke(req: Request): Promise<Response> {
    let form: URLSearchParams;
    try { form = await this.readParams(req); } catch { return oauthErr(400, 'invalid_request', 'Malformed body.'); }
    const t = form.get('token') ?? '';
    const p = t.startsWith('svrt_') ? this.sealer.open<TokenPayload>('refresh', t.slice(5)) : t.startsWith('svat_') ? this.sealer.open<TokenPayload>('access', t.slice(5)) : undefined;
    if (p) {
      this.revoked.add(p.jti, p.exp);
      if (p.fam) this.revoked.add(`fam:${p.fam}`, p.exp);
    }
    return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } }); // RFC 7009: 200 even for unknown tokens
  }

  /* --------------------------------------------------------------- resource-server side */

  /** OAuthTokenVerifier for the SDK's verifyBearerToken: maps our sealed access token to AuthInfo + CallerAuth. */
  verifier(): OAuthTokenVerifier {
    return {
      verifyAccessToken: async (token: string): Promise<AuthInfo> => {
        const p = token.startsWith('svat_') ? this.sealer.open<TokenPayload>('access', token.slice(5)) : undefined;
        if (!p || p.exp < now() || this.revoked.has(p.jti)) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
        const caller: CallerAuth = {
          token: p.cred.t,
          apiKey: p.cred.k,
          clientKey: clientKeyFor(p.cred.t ?? p.cred.k ?? p.cid),
          source: 'oauth',
          secrets: {},
          scopes: p.sc.split(' '),
        };
        return { token: 'redacted', clientId: p.cid, scopes: p.sc.split(' '), expiresAt: p.exp, resource: new URL(p.res), extra: { caller } };
      },
    };
  }
}
