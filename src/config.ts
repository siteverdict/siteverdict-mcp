import { BRAND } from './brand.js';
import { parseToolAllowList, parseToolsets, type ToolsetId } from './toolsets.js';

/** Which Apify token pays for runs. */
export type BillingMode =
  /** Default. The END USER's own APIFY_TOKEN (env var for stdio, header for HTTP). Apify pay-per-event bills them directly. */
  | 'byok'
  /** STUB, disabled by default: operator token + per-customer API keys. See docs/HOSTED-MODE.md. */
  | 'hosted';

export interface Config {
  mode: BillingMode;
  hostedEnabled: boolean;
  /** sha256 hex digests of customer API keys accepted in hosted mode. Never raw keys. */
  hostedKeyHashes: string[];
  operatorToken?: string;
  /** stdio: the user's token from APIFY_TOKEN. */
  envToken?: string;
  dryRun: boolean;
  mockDelayMs: number;
  apifyBaseUrl: string;
  apifyUsername: string;
  actorIds: Record<CheckKey, string>;
  /** Max seconds a tool waits for an Actor run before returning a "still running" result. */
  defaultWaitSecs: number;
  maxWaitSecs: number;
  /** Default cap passed to Apify as maxTotalChargeUsd per run (pay-per-event spend guard). */
  defaultMaxChargeUsd: number;
  rateLimitPerMinute: number;
  maxConcurrentRunsPerClient: number;
  dnsCheck: boolean;
  http: {
    host: string;
    port: number;
    path: string;
    allowedHosts: string[];
    allowedOrigins: string[];
    /** Max request body (bytes). Larger requests get 413. */
    maxBodyBytes: number;
    /** HTTP requests per minute per client IP (all endpoints; OAuth endpoints get a quarter of it). */
    ipRatePerMinute: number;
    /** Trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy (only behind your own proxy). */
    trustProxy: boolean;
    /** Allow API-key / Apify-token auth on HTTP in addition to OAuth (Claude "custom connection", Cursor, scripts). */
    allowApiKeys: boolean;
  };
  /** Toolsets enabled by default (stdio --toolsets / SITEVERDICT_TOOLSETS; HTTP clients may narrow or widen per connection with ?toolsets=). */
  toolsets: Set<ToolsetId>;
  /** Optional explicit tool allow-list (SITEVERDICT_TOOLS). */
  toolAllow: Set<string>;
  /** SITEVERDICT_ACTOR_<KEY> overrides for data tools, keyed by "ACTOR_<FOLDER>". */
  actorOverrides: Record<string, string>;
  /** Contact e-mail sent where a public API requires one (SEC EDGAR, Nominatim). */
  contactEmail: string;
  /** stdio: third-party credentials from SITEVERDICT_SECRET_<NAME> (never logged). */
  envSecrets: Record<string, string>;
  /** Which backend runs scans: Apify Actors (default), the SiteVerdict API, or auto (API when configured and the caller has an API key). */
  backend: 'apify' | 'api' | 'auto';
  apiBaseUrl?: string;
  /** stdio: SiteVerdict API key from SITEVERDICT_API_KEY. */
  envApiKey?: string;
  /** Hard cap on the JSON size of one tool result (Claude: ~150k chars; we stay well under). */
  maxResultChars: number;
  oauth: OAuthConfig;
}

export interface OAuthConfig {
  enabled: boolean;
  /** Public base URL of this server, e.g. https://mcp.webrevenuescan.com (issuer + resource are derived from it). */
  publicUrl?: string;
  /** base64url 32-byte keys; first = current, others still accepted (rotation). From SITEVERDICT_OAUTH_KEYS. */
  keys: string[];
  accessTokenTtlSecs: number;
  refreshTokenTtlSecs: number;
  /** Optional allow-list of redirect URI hosts (empty = any https host + loopback). */
  redirectHosts: string[];
  /** Verify a pasted Apify token against api.apify.com before issuing a code. */
  verifyApifyToken: boolean;
}

export const CHECK_KEYS = ['tracking_consent', 'speed_revenue', 'accessibility', 'domain_email', 'ai_search'] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

/** Default Actor names (owner decision 11 Oct 2026). Full ID = <apifyUsername>/<name>. */
export const DEFAULT_ACTOR_NAMES: Record<CheckKey, string> = {
  tracking_consent: `${BRAND.actorPrefix}tracking-consent-auditor`,
  speed_revenue: `${BRAND.actorPrefix}speed-revenue-scanner`,
  accessibility: `${BRAND.actorPrefix}accessibility-auditor`,
  domain_email: `${BRAND.actorPrefix}domain-email-health`,
  ai_search: `${BRAND.actorPrefix}ai-search-readiness`,
};

const ENV_PREFIX = 'SITEVERDICT_';
const SECRET_PREFIX = `${ENV_PREFIX}SECRET_`;

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[ENV_PREFIX + name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function envNum(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const v = env[ENV_PREFIX + name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${ENV_PREFIX}${name} must be a number`);
  return Math.min(max, Math.max(min, n));
}

function envList(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[ENV_PREFIX + name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apifyUsername = env[ENV_PREFIX + 'APIFY_USERNAME'] || BRAND.apifyUsername;
  const actorIds = {} as Record<CheckKey, string>;
  for (const key of CHECK_KEYS) {
    const override = env[`${ENV_PREFIX}ACTOR_${key.toUpperCase()}`];
    actorIds[key] = override && override.length > 0 ? override : `${apifyUsername}/${DEFAULT_ACTOR_NAMES[key]}`;
  }
  const actorOverrides: Record<string, string> = {};
  const envSecrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (k.startsWith(`${ENV_PREFIX}ACTOR_`)) actorOverrides[k.slice(ENV_PREFIX.length)] = v;
    if (k.startsWith(SECRET_PREFIX) && /^[A-Z0-9_]{2,64}$/.test(k.slice(SECRET_PREFIX.length))) envSecrets[k.slice(SECRET_PREFIX.length)] = v;
  }
  const backend = (env[ENV_PREFIX + 'BACKEND'] ?? 'apify') as Config['backend'];
  if (!['apify', 'api', 'auto'].includes(backend)) throw new Error(`${ENV_PREFIX}BACKEND must be apify, api or auto`);
  const publicUrl = (env[ENV_PREFIX + 'PUBLIC_URL'] || '').replace(/\/+$/, '') || undefined;
  const mode = (env[ENV_PREFIX + 'MODE'] ?? 'byok') as BillingMode;
  if (mode !== 'byok' && mode !== 'hosted') throw new Error(`${ENV_PREFIX}MODE must be "byok" or "hosted"`);
  return {
    mode,
    hostedEnabled: envBool(env, 'HOSTED_ENABLED', false),
    hostedKeyHashes: envList(env, 'HOSTED_KEY_SHA256').map((h) => h.toLowerCase()),
    operatorToken: env[ENV_PREFIX + 'OPERATOR_APIFY_TOKEN'] || undefined,
    envToken: env.APIFY_TOKEN || undefined,
    dryRun: envBool(env, 'DRY_RUN', false),
    mockDelayMs: envNum(env, 'MOCK_DELAY_MS', 250, 0, 10_000),
    apifyBaseUrl: (env[ENV_PREFIX + 'APIFY_BASE_URL'] || 'https://api.apify.com').replace(/\/+$/, ''),
    apifyUsername,
    actorIds,
    defaultWaitSecs: envNum(env, 'DEFAULT_WAIT_SECS', 240, 10, 3600),
    maxWaitSecs: envNum(env, 'MAX_WAIT_SECS', 900, 30, 3600),
    defaultMaxChargeUsd: envNum(env, 'DEFAULT_MAX_CHARGE_USD', 2, 0.01, 1000),
    rateLimitPerMinute: envNum(env, 'RATE_LIMIT_PER_MINUTE', 20, 1, 10_000),
    maxConcurrentRunsPerClient: envNum(env, 'MAX_CONCURRENT_RUNS', 6, 1, 100),
    dnsCheck: envBool(env, 'DNS_CHECK', true),
    http: {
      host: env[ENV_PREFIX + 'HTTP_HOST'] || '127.0.0.1',
      port: envNum(env, 'HTTP_PORT', 3333, 0, 65535),
      path: env[ENV_PREFIX + 'HTTP_PATH'] || '/mcp',
      allowedHosts: envList(env, 'ALLOWED_HOSTS'),
      allowedOrigins: envList(env, 'ALLOWED_ORIGINS'),
      maxBodyBytes: envNum(env, 'MAX_BODY_BYTES', 262_144, 1024, 10_485_760),
      ipRatePerMinute: envNum(env, 'IP_RATE_PER_MINUTE', 120, 1, 100_000),
      trustProxy: envBool(env, 'TRUST_PROXY', false),
      allowApiKeys: envBool(env, 'ALLOW_API_KEYS', true),
    },
    toolsets: parseToolsets(env[ENV_PREFIX + 'TOOLSETS']),
    toolAllow: parseToolAllowList(env[ENV_PREFIX + 'TOOLS']),
    actorOverrides,
    contactEmail: env[ENV_PREFIX + 'CONTACT_EMAIL'] || BRAND.supportEmail,
    envSecrets,
    backend,
    apiBaseUrl: (env[ENV_PREFIX + 'API_BASE'] || '').replace(/\/+$/, '') || undefined,
    envApiKey: env[ENV_PREFIX + 'API_KEY'] || undefined,
    maxResultChars: envNum(env, 'MAX_RESULT_CHARS', 100_000, 5_000, 1_000_000),
    oauth: {
      enabled: envBool(env, 'OAUTH_ENABLED', false),
      publicUrl,
      keys: envList(env, 'OAUTH_KEYS'),
      accessTokenTtlSecs: envNum(env, 'OAUTH_ACCESS_TTL_SECS', 3600, 60, 86_400),
      refreshTokenTtlSecs: envNum(env, 'OAUTH_REFRESH_TTL_SECS', 30 * 86_400, 3600, 365 * 86_400),
      redirectHosts: envList(env, 'OAUTH_REDIRECT_HOSTS').map((h) => h.toLowerCase()),
      verifyApifyToken: envBool(env, 'OAUTH_VERIFY_APIFY_TOKEN', true),
    },
  };
}
