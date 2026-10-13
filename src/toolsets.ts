import { UserInputError } from './lib/errors.js';

/**
 * Toolsets keep the tool list small: a client only sees the groups it asks for.
 *   stdio:  --toolsets web,leads   or   SITEVERDICT_TOOLSETS=web,leads
 *   HTTP:   https://host/mcp?toolsets=web,travel   (per connection) or the server default
 * "all" enables everything. Default: "web" (the original website-audit tools, so existing installs see no change).
 */
export const TOOLSET_IDS = ['web', 'marketing', 'leads', 'compliance', 'travel', 'property'] as const;
export type ToolsetId = (typeof TOOLSET_IDS)[number];

export const TOOLSETS: Record<ToolsetId, { title: string; description: string }> = {
  web: { title: 'Website audits', description: 'Consent/GDPR, speed and revenue, WCAG accessibility, domain/email health, AI-search readiness, tech stack, change/uptime monitoring and clean Markdown from web pages.' },
  marketing: { title: 'SEO and marketing', description: 'Search rankings, Search Console + GA4 diagnosis, Google ad transparency and review monitoring for your own business.' },
  leads: { title: 'Leads and company research', description: 'Local businesses (OpenStreetMap / your Google key), company registries (SEC EDGAR, GLEIF), SEC filings and UK/EU public tenders.' },
  compliance: { title: 'Compliance and finance', description: 'Sanctions screening (UK, UN, EU, OFAC), VAT / company-number validation, PDF invoice extraction and registry lookups.' },
  travel: { title: 'Travel', description: 'Flight fare scans, public flight-deal feeds, UK261/EU261 compensation checks and official visa/entry requirements.' },
  property: { title: 'UK property', description: 'HM Land Registry sold prices, UK HPI context and planning constraints (England), optional EPC data with your token.' },
};

export const DEFAULT_TOOLSETS: ToolsetId[] = ['web'];

/** Parses "web,leads" / "all" / "default". Unknown names are an error (so typos are noticed). */
export function parseToolsets(raw: string | undefined | null, fallback: readonly ToolsetId[] = DEFAULT_TOOLSETS): Set<ToolsetId> {
  if (raw === undefined || raw === null || raw.trim() === '') return new Set(fallback);
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = new Set<ToolsetId>();
  for (const p of parts) {
    if (p === 'all' || p === '*') return new Set(TOOLSET_IDS);
    if (p === 'default') {
      DEFAULT_TOOLSETS.forEach((t) => out.add(t));
      continue;
    }
    if (!(TOOLSET_IDS as readonly string[]).includes(p)) {
      throw new UserInputError(`Unknown toolset "${p}". Valid: ${TOOLSET_IDS.join(', ')}, all.`);
    }
    out.add(p as ToolsetId);
  }
  return out.size ? out : new Set(fallback);
}

/** Optional explicit allow-list of tool names (SITEVERDICT_TOOLS / ?tools=). Empty = no filter. */
export function parseToolAllowList(raw: string | undefined | null): Set<string> {
  return new Set((raw ?? '').split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9_]{1,64}$/.test(s)));
}

export function toolEnabled(toolsets: readonly ToolsetId[], selected: Set<ToolsetId>, allow: Set<string>, name: string): boolean {
  if (allow.size > 0) return allow.has(name);
  return toolsets.some((t) => selected.has(t));
}
