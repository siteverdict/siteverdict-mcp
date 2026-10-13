import * as z from 'zod/v4';
import type { CheckKey } from './config.js';

/**
 * One entry per Apify Actor. `inputSchema` is what the AI agent sees; `buildActorInput`
 * maps it to the Actor's own input (docs/ACTOR-CONTRACTS.md). Contract status:
 *   tracking_consent  ALIGNED with siteverdict-tracking-consent-auditor/.actor/input_schema.json (11 Oct 2026)
 *   others            PROPOSED (sibling Actors had no input_schema.json yet) — align when they land.
 */

export const urlField = z
  .string()
  .min(3)
  .max(2048)
  .describe('Public website URL, e.g. "https://example.com" (https:// is added if missing). Private/internal addresses are rejected.');

export const domainField = z
  .string()
  .min(3)
  .max(253)
  .describe('Domain name, e.g. "example.com" (a URL or email address is accepted and reduced to its domain).');

export const runControls = {
  maxCostUsd: z
    .number()
    .min(0.01)
    .max(50)
    .optional()
    .describe('Spend cap for this run on YOUR Apify account (forwarded to Apify as maxTotalChargeUsd). Default from server config ($2).'),
  waitSecs: z
    .number()
    .int()
    .min(10)
    .max(900)
    .optional()
    .describe('How long to wait for results before returning status "running" with a runId (the scan keeps going; use get_audit_results). Default 240.'),
};

export type TargetKind = 'url' | 'domain';

export interface ActorSpec {
  key: CheckKey;
  tool: string;
  title: string;
  description: string;
  targetKind: TargetKind;
  inputSchema: z.ZodObject;
  runTimeoutSecs: number;
  memoryMbytes?: number;
  contractStatus: 'aligned' | 'proposed';
  buildActorInput(target: string, args: Record<string, unknown>): Record<string, unknown>;
}

const COST_NOTE =
  'Runs on the caller\'s own Apify account (APIFY_TOKEN) and is billed by Apify pay-per-event; nothing is charged by this server.';

export const ACTORS: Record<CheckKey, ActorSpec> = {
  tracking_consent: {
    key: 'tracking_consent',
    tool: 'audit_tracking_consent',
    title: 'Audit tracking & cookie consent (GDPR / Consent Mode v2)',
    description:
      'Loads the site in a real browser three ways (no click, Reject, Accept all) and reports which tags fire before consent or after Reject, tracking cookies set without consent, Google Consent Mode v2 signals, broken GA4/GTM tags, duplicate page_views and missing conversions. Returns a score, prioritised plain-English fixes and a link to the full HTML report. Use for GDPR/UK GDPR/PECR/ePrivacy cookie compliance and "why is my analytics data wrong" questions. ' +
      COST_NOTE,
    targetKind: 'url',
    contractStatus: 'aligned',
    runTimeoutSecs: 900,
    memoryMbytes: 2048,
    inputSchema: z.object({
      url: urlField,
      scanMode: z.enum(['full', 'quick']).default('full').describe('"full" = 3 visits (no click / Reject / Accept all). "quick" = 1 visit, cheaper: tag inventory, pre-consent tracking and broken tags only.'),
      internalPages: z.number().int().min(0).max(10).default(1).describe('Extra internal pages to check per scenario (0 = home page only).'),
      locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default('en-GB').describe('Browser language, e.g. en-GB, de-DE, fr-FR (banners are often localised).'),
      timezoneId: z.string().regex(/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/).default('Europe/London').describe('IANA time zone, e.g. Europe/London, Europe/Berlin, America/New_York.'),
      ...runControls,
    }),
    buildActorInput: (target, a) => ({
      startUrls: [{ url: target }],
      scanMode: a.scanMode ?? 'full',
      maxInternalPages: a.internalPages ?? 1,
      locale: a.locale ?? 'en-GB',
      timezoneId: a.timezoneId ?? 'Europe/London',
      saveScreenshots: true,
    }),
  },
  speed_revenue: {
    key: 'speed_revenue',
    tool: 'scan_speed_and_revenue',
    title: 'Scan page speed & estimate revenue lost to slowness',
    description:
      'Measures Core Web Vitals (LCP, INP, CLS, TTFB) and page weight on key pages, finds the biggest speed bottlenecks (images, render-blocking scripts, third-party tags) and, if you give traffic and order value, estimates monthly revenue lost to slow pages. Returns a score, metrics, prioritised fixes and a full-report link. ' +
      COST_NOTE,
    targetKind: 'url',
    contractStatus: 'proposed',
    runTimeoutSecs: 900,
    memoryMbytes: 4096,
    inputSchema: z.object({
      url: urlField,
      device: z.enum(['mobile', 'desktop']).default('mobile').describe('Emulated device; Google ranks on mobile.'),
      maxPages: z.number().int().min(1).max(20).default(3).describe('Pages to test (home page + discovered key pages).'),
      monthlyVisitors: z.number().int().min(0).max(1_000_000_000).optional().describe('Optional, for the revenue-loss estimate.'),
      averageOrderValue: z.number().min(0).max(1_000_000).optional().describe('Optional average order / lead value, for the revenue estimate.'),
      conversionRatePct: z.number().min(0).max(100).optional().describe('Optional current conversion rate in %, for the revenue estimate.'),
      currency: z.string().regex(/^[A-Z]{3}$/).default('USD').describe('ISO currency code for money figures.'),
      ...runControls,
    }),
    buildActorInput: (target, a) => ({
      startUrls: [{ url: target }],
      device: a.device ?? 'mobile',
      maxPages: a.maxPages ?? 3,
      monthlyVisitors: a.monthlyVisitors,
      averageOrderValue: a.averageOrderValue,
      conversionRatePct: a.conversionRatePct,
      currency: a.currency ?? 'USD',
    }),
  },
  accessibility: {
    key: 'accessibility',
    tool: 'audit_accessibility_wcag',
    title: 'Audit accessibility (WCAG 2.2 / European Accessibility Act)',
    description:
      'Crawls pages in a real browser and runs axe-core WCAG 2.2 checks (A/AA/AAA), mapping issues to WCAG success criteria and EN 301 549 / European Accessibility Act duties. Returns a score, issue counts by impact, the affected pages and concrete code-level fixes, plus a full-report link. Automated testing finds a subset of WCAG issues; it does not replace a manual audit. ' +
      COST_NOTE,
    targetKind: 'url',
    contractStatus: 'proposed',
    runTimeoutSecs: 1200,
    memoryMbytes: 4096,
    inputSchema: z.object({
      url: urlField,
      maxPages: z.number().int().min(1).max(50).default(5).describe('Pages to crawl on the same host.'),
      wcagLevel: z.enum(['A', 'AA', 'AAA']).default('AA').describe('Conformance level to test against (AA is the legal baseline in most regions).'),
      includeBestPractices: z.boolean().default(false).describe('Also report axe "best-practice" rules that are not strict WCAG failures.'),
      ...runControls,
    }),
    buildActorInput: (target, a) => ({
      startUrls: [{ url: target }],
      maxPages: a.maxPages ?? 5,
      wcagLevel: a.wcagLevel ?? 'AA',
      includeBestPractices: a.includeBestPractices ?? false,
    }),
  },
  domain_email: {
    key: 'domain_email',
    tool: 'check_domain_email_health',
    title: 'Check domain & email health (SPF, DKIM, DMARC, TLS, DNS)',
    description:
      'Checks a domain\'s email authentication and deliverability setup (MX, SPF, DKIM, DMARC policy, BIMI, MTA-STS/TLS-RPT), DNS hygiene (DNSSEC, CAA, nameservers) and HTTPS/TLS certificate expiry. Flags spoofing risk and Gmail/Yahoo bulk-sender requirement gaps with exact DNS records to add. ' +
      COST_NOTE,
    targetKind: 'domain',
    contractStatus: 'proposed',
    runTimeoutSecs: 300,
    memoryMbytes: 512,
    inputSchema: z.object({
      domain: domainField,
      dkimSelectors: z
        .array(z.string().regex(/^[A-Za-z0-9._-]{1,63}$/))
        .max(10)
        .optional()
        .describe('Optional DKIM selectors to test (e.g. "google", "selector1"). Common selectors are tried automatically.'),
      ...runControls,
    }),
    buildActorInput: (target, a) => ({
      domains: [target],
      dkimSelectors: a.dkimSelectors,
    }),
  },
  ai_search: {
    key: 'ai_search',
    tool: 'check_ai_search_readiness',
    title: 'Check AI-search readiness (ChatGPT, Perplexity, Google AI Overviews)',
    description:
      'Checks whether AI assistants and AI search engines can find, read and cite the site: robots.txt rules for GPTBot/ClaudeBot/PerplexityBot/Google-Extended, llms.txt, structured data (schema.org), server-rendered content, meta/canonical tags and sitemap. Returns a readiness score and prioritised fixes. ' +
      COST_NOTE,
    targetKind: 'url',
    contractStatus: 'proposed',
    runTimeoutSecs: 600,
    memoryMbytes: 2048,
    inputSchema: z.object({
      url: urlField,
      maxPages: z.number().int().min(1).max(25).default(5).describe('Pages to sample for content/structured-data checks.'),
      ...runControls,
    }),
    buildActorInput: (target, a) => ({
      startUrls: [{ url: target }],
      maxPages: a.maxPages ?? 5,
    }),
  },
};

export const CHECK_BY_TOOL: Record<string, CheckKey> = Object.fromEntries(
  Object.values(ACTORS).map((a) => [a.tool, a.key]),
) as Record<string, CheckKey>;

/** Removes undefined values (Apify input should not carry explicit undefined). */
export function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
