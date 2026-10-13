import type { CheckKey } from '../config.js';

/**
 * Request bodies for the SiteVerdict API v1.1 (products/siteverdict-api/openapi.yaml).
 * The API rejects unknown fields with 400, so only spec fields are sent. MCP inputs that have
 * no API equivalent (maxPages, waitSecs, maxCostUsd ...) are dropped: the API scans one page per call.
 */
type Obj = Record<string, unknown>;

const has = (v: unknown) => v !== undefined && v !== null;
const clampInt = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : undefined;

function compactBody(o: Obj): Obj {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => has(v)));
}

/** API body for one of the five audit checks. `target` is the validated URL (or domain for domain_email). */
export function apiBodyForCheck(check: CheckKey, target: string, args: Obj): Obj {
  switch (check) {
    case 'tracking_consent':
      return compactBody({
        url: target,
        scan_mode: args.scanMode === 'quick' || args.scanMode === 'full' ? args.scanMode : undefined,
        internal_pages: clampInt(args.internalPages, 0, 3),
        locale: typeof args.locale === 'string' ? args.locale : undefined,
        timezone: typeof args.timezoneId === 'string' ? args.timezoneId : undefined,
      });
    case 'speed_revenue':
      return compactBody({
        url: target,
        devices: args.device === 'mobile' || args.device === 'desktop' ? args.device : undefined,
        monthly_visitors: args.monthlyVisitors,
        average_order_value: args.averageOrderValue,
        conversion_rate_pct: args.conversionRatePct,
        currency: typeof args.currency === 'string' ? args.currency : undefined,
      });
    case 'accessibility':
      return compactBody({
        url: target,
        wcag_level: ['A', 'AA', 'AAA'].includes(String(args.wcagLevel)) ? args.wcagLevel : undefined,
        include_best_practices: typeof args.includeBestPractices === 'boolean' ? args.includeBestPractices : undefined,
      });
    case 'domain_email':
      return compactBody({
        domain: target,
        dkim_selectors: Array.isArray(args.dkimSelectors) && args.dkimSelectors.length ? args.dkimSelectors.slice(0, 10) : undefined,
      });
    case 'ai_search':
      return { url: target };
  }
}

/** Allowed body fields per API tool (scan endpoint), used to strip anything else defensively. */
export const API_ALLOWED_FIELDS: Record<string, readonly string[]> = {
  'tech-stack': ['url', 'check_dns', 'check_tls', 'min_confidence', 'include_evidence'],
  'consent-tracking': ['url', 'scan_mode', 'internal_pages', 'locale', 'timezone'],
  speed: ['url', 'devices', 'throttling', 'broken_link_sample', 'monthly_visitors', 'conversion_rate_pct', 'average_order_value', 'currency'],
  accessibility: ['url', 'devices', 'wcag_level', 'include_best_practices', 'include_needs_review', 'max_nodes_per_rule'],
  'ai-readiness': ['url', 'policy'],
  'domain-health': ['domain', 'url', 'dkim_selectors', 'check_blocklists', 'check_www'],
  'seo-basics': ['url', 'broken_link_sample'],
  'privacy-policy': ['url', 'privacy_policy_url', 'cookie_policy_url', 'internal_pages', 'generate_drafts', 'locale', 'timezone'],
  'web-to-markdown': ['url', 'rendering', 'extraction', 'include_links', 'include_images', 'include_text', 'chunking', 'chunk_size', 'max_chars'],
  'full-audit': ['url', 'sections', 'max_findings'],
};
/** Fields every scan endpoint accepts. */
export const API_COMMON_FIELDS = ['fresh', 'timeout_secs', 'webhook_url'] as const;

/** Keeps only spec fields for `tool` (plus `urls` for batch jobs). Unknown tools pass through unchanged. */
export function sanitiseApiBody(tool: string, body: Obj, opts: { batch?: boolean } = {}): Obj {
  const allowed = API_ALLOWED_FIELDS[tool];
  if (!allowed) return compactBody(body);
  const keep = new Set<string>([...allowed, ...API_COMMON_FIELDS, ...(opts.batch ? ['urls'] : [])]);
  if (opts.batch) keep.delete('timeout_secs'); // job endpoints do not take a sync window
  return compactBody(Object.fromEntries(Object.entries(body).filter(([k]) => keep.has(k))));
}
