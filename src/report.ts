import * as z from 'zod/v4';
import type { CheckKey } from './config.js';

/* ------------------------------------------------------------------ schemas */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'consent', 'tracking', 'performance', 'revenue', 'accessibility', 'email', 'dns', 'security', 'ai-search', 'seo', 'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const FindingSchema = z.object({
  id: z.string().describe('Stable identifier of the rule/check that produced the finding'),
  title: z.string(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  detail: z.string().optional(),
  fix: z.string().optional().describe('Concrete remediation step'),
  impact: z.string().optional().describe('Business, legal or revenue impact in plain words'),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  standard: z.string().optional().describe('e.g. "WCAG 2.2 SC 1.4.3", "UK GDPR / PECR reg. 6", "RFC 7489"'),
  pages: z.array(z.string()).optional().describe('Affected URLs (truncated)'),
  helpUrl: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const RunInfoSchema = z.object({
  actorId: z.string(),
  runId: z.string().optional(),
  status: z.string().describe('Apify run status: SUCCEEDED, RUNNING, FAILED, TIMED-OUT, ABORTED, or DRY-RUN'),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  usageTotalUsd: z.number().optional().describe('Cost of the run on the caller\'s Apify account, when Apify reports it'),
  consoleUrl: z.string().optional(),
});

export const CheckReportSchema = z.object({
  check: z.string(),
  target: z.string(),
  status: z.enum(['complete', 'running', 'failed']).describe('"running" = the Actor is still working; call get_audit_results with run.runId later'),
  dryRun: z.boolean().describe('true = sample data from the built-in mock, NOT a real scan'),
  score: z.number().min(0).max(100).nullable(),
  grade: z.string().nullable(),
  summary: z.string(),
  findings: z.array(FindingSchema),
  findingsTotal: z.number().int(),
  severityCounts: z.record(z.string(), z.number().int()),
  metrics: z.record(z.string(), z.unknown()),
  reportUrl: z.string().optional().describe('Full report (HTML/JSON) in the Apify key-value store'),
  datasetUrl: z.string().optional(),
  run: RunInfoSchema,
});
export type CheckReport = z.infer<typeof CheckReportSchema>;

export const FixPlanItemSchema = z.object({
  rank: z.number().int(),
  title: z.string(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  source: z.string().describe('Which check found it'),
  why: z.string(),
  fix: z.string(),
  effort: z.enum(['low', 'medium', 'high']),
  priorityScore: z.number(),
});
export type FixPlanItem = z.infer<typeof FixPlanItemSchema>;

export const FullAuditSchema = z.object({
  target: z.string(),
  domain: z.string(),
  dryRun: z.boolean(),
  overallScore: z.number().nullable(),
  grade: z.string().nullable(),
  executiveSummary: z.string(),
  sections: z.array(
    z.object({
      check: z.string(),
      status: z.enum(['complete', 'running', 'failed']),
      score: z.number().nullable(),
      summary: z.string(),
      findingsTotal: z.number().int(),
      reportUrl: z.string().optional(),
      runId: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  fixPlan: z.array(FixPlanItemSchema),
  severityCounts: z.record(z.string(), z.number().int()),
  totalCostUsd: z.number().optional(),
});
export type FullAudit = z.infer<typeof FullAuditSchema>;

/* ------------------------------------------------------------ normalisation */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function mapSeverity(v: unknown): Severity {
  const s = String(v ?? '').toLowerCase();
  if (['critical', 'blocker', 'fatal', 'error-critical', 'p0'].includes(s)) return 'critical';
  if (['high', 'serious', 'error', 'major', 'fail', 'failed', 'p1'].includes(s)) return 'high';
  if (['medium', 'moderate', 'warning', 'warn', 'p2'].includes(s)) return 'medium';
  if (['low', 'minor', 'notice', 'p3'].includes(s)) return 'low';
  if (typeof v === 'number') return v >= 9 ? 'critical' : v >= 7 ? 'high' : v >= 4 ? 'medium' : v > 0 ? 'low' : 'info';
  return 'info';
}

const DEFAULT_CATEGORY: Record<CheckKey, Category> = {
  tracking_consent: 'consent',
  speed_revenue: 'performance',
  accessibility: 'accessibility',
  domain_email: 'email',
  ai_search: 'ai-search',
};

function mapCategory(v: unknown, check: CheckKey): Category {
  const s = String(v ?? '').toLowerCase();
  const hit = CATEGORIES.find((c) => c === s);
  if (hit) return hit;
  if (/gdpr|cookie|consent|pecr|cmp/.test(s)) return 'consent';
  if (/analytics|gtm|ga4|pixel|tag|tracking/.test(s)) return 'tracking';
  if (/speed|lcp|inp|cls|vital|perf|ttfb/.test(s)) return 'performance';
  if (/revenue|conversion|checkout/.test(s)) return 'revenue';
  if (/wcag|a11y|access|aria|contrast/.test(s)) return 'accessibility';
  if (/spf|dkim|dmarc|mx|bimi|mail/.test(s)) return 'email';
  if (/dns|dnssec|caa|ns/.test(s)) return 'dns';
  if (/tls|ssl|https|hsts|header|security|cert/.test(s)) return 'security';
  if (/llm|ai|gptbot|schema|structured/.test(s)) return 'ai-search';
  if (/seo|meta|canonical|robots|sitemap/.test(s)) return 'seo';
  return DEFAULT_CATEGORY[check];
}

function mapEffort(v: unknown): 'low' | 'medium' | 'high' | undefined {
  const s = String(v ?? '').toLowerCase();
  if (['low', 'easy', 'quick', 'small'].includes(s)) return 'low';
  if (['medium', 'moderate'].includes(s)) return 'medium';
  if (['high', 'hard', 'large', 'complex'].includes(s)) return 'high';
  return undefined;
}

function pagesOf(f: Obj): string[] | undefined {
  const list: string[] = [];
  for (const key of ['pages', 'urls', 'affectedUrls']) {
    const v = f[key];
    if (Array.isArray(v)) for (const p of v) if (typeof p === 'string') list.push(p);
  }
  const single = str(f.url) ?? str(f.pageUrl);
  if (single) list.push(single);
  const uniq = [...new Set(list)];
  return uniq.length ? uniq.slice(0, 10) : undefined;
}

function toFinding(raw: Obj, check: CheckKey, idx: number): Finding {
  const id = str(raw.id) ?? str(raw.ruleId) ?? str(raw.code) ?? str(raw.check) ?? `${check}-${idx}`;
  const title = str(raw.title) ?? str(raw.help) ?? str(raw.name) ?? str(raw.message) ?? id;
  const severity = mapSeverity(raw.severity ?? raw.impact ?? raw.level ?? raw.priority ?? raw.status);
  const impactText = typeof raw.impact === 'string' && mapSeverity(raw.impact) === 'info' && !['info', ''].includes(raw.impact.toLowerCase()) ? raw.impact : undefined;
  const revenue = num(raw.estimatedMonthlyRevenueLoss) ?? num(raw.revenueImpactPerMonth);
  const finding: Finding = {
    id,
    title,
    severity,
    category: mapCategory(raw.category ?? raw.type ?? raw.group, check),
    detail: str(raw.detail) ?? str(raw.description) ?? (str(raw.message) !== title ? str(raw.message) : undefined),
    fix: str(raw.fix) ?? str(raw.recommendation) ?? str(raw.remediation) ?? str(raw.howToFix),
    impact: str(raw.businessImpact) ?? impactText ?? (revenue !== undefined ? `Estimated revenue at risk: ~${Math.round(revenue)} per month` : undefined),
    effort: mapEffort(raw.effort),
    standard: str(raw.standard) ?? str(raw.wcag) ?? str(raw.reference) ?? (Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string' && /^wcag\d/.test(t)).join(', ') || undefined : undefined),
    pages: pagesOf(raw),
    helpUrl: str(raw.helpUrl) ?? str(raw.docsUrl) ?? str(raw.learnMoreUrl),
  };
  for (const k of Object.keys(finding) as (keyof Finding)[]) if (finding[k] === undefined) delete finding[k];
  return finding;
}

const FINDING_ARRAY_KEYS = ['findings', 'issues', 'violations', 'problems', 'recommendations'];

export interface NormalisedItems {
  summaryItem: Obj | undefined;
  findings: Finding[];
}

/**
 * Tolerant adapter for Actor dataset items. Preferred contract (docs/ACTOR-CONTRACTS.md):
 *   - one item with type:"summary" (score, grade, summary, metrics, reportUrl)
 *   - zero or more items with type:"finding"
 * Also accepts a single report item holding a findings/issues/violations array (e.g. axe-core shape).
 */
export function normaliseItems(items: unknown[], check: CheckKey): NormalisedItems {
  const objs = items.filter(isObj);
  let summaryItem = objs.find((o) => o.type === 'summary' || o.recordType === 'summary');
  const rawFindings: Obj[] = [];
  for (const o of objs) {
    if (o.type === 'finding' || o.recordType === 'finding') {
      rawFindings.push(o);
      continue;
    }
    for (const key of FINDING_ARRAY_KEYS) {
      const arr = o[key];
      if (Array.isArray(arr)) rawFindings.push(...arr.filter(isObj));
    }
  }
  if (!summaryItem) summaryItem = objs.find((o) => o.type !== 'finding' && o.recordType !== 'finding');
  const findings = rawFindings.map((f, i) => toFinding(f, check, i));
  return { summaryItem, findings: dedupeFindings(findings) };
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const map = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.category}|${f.id}|${normTitle(f.title)}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...f });
      continue;
    }
    if (SEV_RANK[f.severity] > SEV_RANK[prev.severity]) prev.severity = f.severity;
    if (f.pages) prev.pages = [...new Set([...(prev.pages ?? []), ...f.pages])].slice(0, 10);
  }
  return [...map.values()];
}

export const SEV_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || (b.pages?.length ?? 0) - (a.pages?.length ?? 0));
}

export function countSeverities(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

export function gradeFor(score: number | null): string | null {
  if (score === null) return null;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}

/** If an Actor gives no score, derive one from severities (transparent, documented heuristic). */
export function deriveScore(findings: Finding[]): number {
  const c = countSeverities(findings);
  const penalty = c.critical * 20 + c.high * 8 + c.medium * 3 + c.low * 1;
  return Math.max(0, 100 - Math.min(100, penalty));
}

export function pickScore(summary: Obj | undefined): number | null {
  if (!summary) return null;
  const scores = isObj(summary.scores) ? summary.scores : {};
  const v = num(summary.score) ?? num(summary.overallScore) ?? num(scores.overall) ?? num(summary.totalScore);
  if (v === undefined) return null;
  const scaled = v <= 1 && v > 0 && !Number.isInteger(v) ? v * 100 : v; // accept 0..1
  return Math.round(Math.min(100, Math.max(0, scaled)));
}

export function pickMetrics(summary: Obj | undefined): Record<string, unknown> {
  if (!summary) return {};
  if (isObj(summary.metrics)) return summary.metrics;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(summary)) {
    if (FINDING_ARRAY_KEYS.includes(k) || ['type', 'recordType', 'summary', 'score', 'grade'].includes(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length < 200)) out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ merging */

const CATEGORY_WEIGHT: Record<Category, number> = {
  consent: 1.25, // legal exposure (UK GDPR/PECR, EU ePrivacy) + broken attribution
  accessibility: 1.2, // legal exposure (EAA, ADA, Equality Act) + lost customers
  revenue: 1.2,
  tracking: 1.15,
  performance: 1.15,
  email: 1.1, // spoofing + deliverability
  security: 1.1,
  dns: 1.0,
  'ai-search': 1.0,
  seo: 0.95,
  other: 0.9,
};
const SEV_WEIGHT: Record<Severity, number> = { critical: 100, high: 60, medium: 30, low: 10, info: 0 };
const EFFORT_FACTOR = { low: 1.2, medium: 1, high: 0.8 } as const;

export function priorityScore(f: Finding): number {
  const effort = f.effort ?? 'medium';
  const reach = Math.min(10, f.pages?.length ?? 0);
  return Math.round((SEV_WEIGHT[f.severity] * CATEGORY_WEIGHT[f.category] * EFFORT_FACTOR[effort] + reach) * 10) / 10;
}

const CHECK_WEIGHTS: Record<string, number> = {
  tracking_consent: 1.2,
  speed_revenue: 1.2,
  accessibility: 1.1,
  domain_email: 1.0,
  ai_search: 0.8,
};

export function buildFixPlan(sections: { check: string; findings: Finding[] }[], limit = 15): FixPlanItem[] {
  const all: { f: Finding; source: string; p: number }[] = [];
  for (const s of sections) for (const f of s.findings) if (f.severity !== 'info') all.push({ f, source: s.check, p: priorityScore(f) });
  const seen = new Set<string>();
  const ranked = all
    .sort((a, b) => b.p - a.p)
    .filter(({ f }) => {
      const k = normTitle(f.title);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);
  return ranked.map(({ f, source, p }, i) => ({
    rank: i + 1,
    title: f.title,
    severity: f.severity,
    category: f.category,
    source,
    why: f.impact ?? f.detail ?? `${f.severity} ${f.category} issue`,
    fix: f.fix ?? (f.helpUrl ? `See ${f.helpUrl}` : 'See the full report for remediation steps.'),
    effort: f.effort ?? 'medium',
    priorityScore: p,
  }));
}

export function overallScore(sections: { check: string; score: number | null }[]): number | null {
  let total = 0;
  let weight = 0;
  for (const s of sections) {
    if (s.score === null) continue;
    const w = CHECK_WEIGHTS[s.check] ?? 1;
    total += s.score * w;
    weight += w;
  }
  return weight === 0 ? null : Math.round(total / weight);
}

export function mergeSeverityCounts(list: Record<string, number>[]): Record<Severity, number> {
  const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const x of list) for (const s of SEVERITIES) c[s] += x[s] ?? 0;
  return c;
}
