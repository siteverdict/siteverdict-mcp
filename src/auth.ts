import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { AuthError } from './lib/errors.js';

/** Who is calling and which Apify token pays. Tokens never leave this object except toward api.apify.com. */
export interface CallerAuth {
  /** Apify token used for runs; undefined = none supplied. */
  token?: string;
  /** Opaque, non-reversible key for rate limiting (never the raw token). */
  clientKey: string;
  source: 'env' | 'header' | 'hosted' | 'oauth' | 'none';
  /** SiteVerdict API key (sv_...), used when the API backend is configured. */
  apiKey?: string;
  /** Third-party credentials for data tools, keyed by SecretDef.name. Never logged, never returned. */
  secrets?: Record<string, string>;
  /** OAuth scopes granted (oauth source only). */
  scopes?: string[];
}

/** SiteVerdict API keys look like sv_live_... / sv_test_... (API-CONTRACT.md). */
export const isSiteVerdictApiKey = (v: string) => /^sv_(live|test)_[A-Za-z0-9_-]{8,200}$/.test(v);

/** Reads X-SiteVerdict-Secret-<Name> headers into { NAME: value } (API-key mode only). */
export function headerSecrets(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const m = /^x-siteverdict-secret-([a-z0-9-]{2,64})$/i.exec(key);
    if (m && value.trim() && value.length <= 16_384) out[m[1]!.toUpperCase().replace(/-/g, '_')] = value.trim();
  });
  return out;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const clientKeyFor = (secret: string) => `k_${sha256(secret).slice(0, 24)}`;

/** stdio: one local user, token from APIFY_TOKEN. */
export function stdioAuth(config: Config): CallerAuth {
  if (config.mode === 'hosted') throw new AuthError('Hosted mode is HTTP-only.');
  const extra = { secrets: { ...config.envSecrets }, ...(config.envApiKey ? { apiKey: config.envApiKey } : {}) };
  return config.envToken ? { token: config.envToken, clientKey: 'stdio', source: 'env', ...extra } : { clientKey: 'stdio', source: config.envApiKey ? 'env' : 'none', ...extra };
}

function header(headers: Headers, name: string): string | undefined {
  const v = headers.get(name);
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * HTTP:
 *  - byok (default): the user's Apify token from `X-Apify-Token: <token>` or `Authorization: Bearer <token>`.
 *  - hosted (STUB, off unless SITEVERDICT_HOSTED_ENABLED=true): `Authorization: Bearer <customer API key>`
 *    is checked against SHA-256 hashes in SITEVERDICT_HOSTED_KEY_SHA256 and runs use the operator token.
 *    Needs metering/billing + OAuth before it can be offered publicly. See docs/HOSTED-MODE.md.
 */
export function httpAuth(config: Config, headers: Headers, remoteIp: string | undefined): CallerAuth {
  const bearer = header(headers, 'authorization')?.replace(/^Bearer\s+/i, '');
  if (config.mode === 'hosted') {
    if (!config.hostedEnabled) throw new AuthError('Hosted mode is disabled on this server (SITEVERDICT_HOSTED_ENABLED is not true).');
    if (!config.operatorToken) throw new AuthError('Hosted mode misconfigured: no operator token.');
    if (!bearer) throw new AuthError('Missing API key. Send Authorization: Bearer <your SiteVerdict API key>.');
    const digest = Buffer.from(sha256(bearer), 'hex');
    const ok = config.hostedKeyHashes.some((h) => {
      const b = Buffer.from(h, 'hex');
      return b.length === digest.length && timingSafeEqual(b, digest);
    });
    if (!ok) throw new AuthError('Invalid API key.');
    return { token: config.operatorToken, clientKey: clientKeyFor(bearer), source: 'hosted' };
  }
  const secrets = headerSecrets(headers);
  const xKey = header(headers, 'x-api-key');
  const apiKey = xKey && isSiteVerdictApiKey(xKey) ? xKey : bearer && isSiteVerdictApiKey(bearer) ? bearer : undefined;
  const token = header(headers, 'x-apify-token') ?? (bearer && !isSiteVerdictApiKey(bearer) ? bearer : undefined);
  if (token) return { token, clientKey: clientKeyFor(token), source: 'header', secrets, ...(apiKey ? { apiKey } : {}) };
  if (apiKey) return { clientKey: clientKeyFor(apiKey), source: 'header', apiKey, secrets };
  return { clientKey: remoteIp ? clientKeyFor(`ip:${remoteIp}`) : 'anonymous', source: 'none', secrets };
}

export const MISSING_TOKEN_HELP =
  'No Apify token. This server runs audits on YOUR Apify account (pay-per-event, billed by Apify). ' +
  'Get a token at https://console.apify.com/settings/integrations and set APIFY_TOKEN in the MCP server config ' +
  '(or send the X-Apify-Token header over HTTP, or connect with OAuth on a hosted endpoint). To try the tools with sample data instead, set SITEVERDICT_DRY_RUN=1.';
