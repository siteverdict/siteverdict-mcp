import { ApifyHttpRunner } from './apify/runner.js';
import { SiteVerdictApiRunner } from './api/client.js';
import { MockRunner } from './apify/mock.js';
import { BRAND, SERVER_VERSION } from './brand.js';
import { CHECK_KEYS, type CheckKey, type Config } from './config.js';
import { ClientLimiter } from './lib/rateLimit.js';
import type { HttpDeps } from './http.js';

/** Builds the shared (process-wide) dependencies: runners and the rate limiter. */
export function buildDeps(config: Config, log: (m: string) => void = (m) => process.stderr.write(`[${BRAND.slug}] ${m}\n`)): HttpDeps {
  const checkForActor = (actorId: string): CheckKey | undefined => CHECK_KEYS.find((k) => config.actorIds[k] === actorId);
  return {
    config,
    limiter: new ClientLimiter(config.rateLimitPerMinute, config.maxConcurrentRunsPerClient),
    runner: new ApifyHttpRunner(config.apifyBaseUrl, undefined, 20, `${BRAND.binName}/${SERVER_VERSION}`),
    mockRunner: new MockRunner(config.mockDelayMs, checkForActor),
    log,
    ...(config.apiBaseUrl ? { apiRunner: new SiteVerdictApiRunner(config.apiBaseUrl, undefined, `${BRAND.binName}/${SERVER_VERSION}`) } : {}),
  };
}
