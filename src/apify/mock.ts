import type { CheckKey } from '../config.js';
import { CancelledError } from '../lib/errors.js';
import type { ActorRunner, FetchResultsRequest, RunRequest, RunResult } from './runner.js';

/**
 * Dry-run / test runner. Never touches the network. Returns clearly-labelled SAMPLE data
 * shaped like the real Actors' dataset items, so agents and marketplace scanners can try
 * every tool without an Apify token. Results are flagged dryRun:true everywhere.
 */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function targetOf(input: Record<string, unknown>): string {
  const su = input.startUrls;
  if (Array.isArray(su) && su[0] && typeof (su[0] as { url?: unknown }).url === 'string') return (su[0] as { url: string }).url;
  const d = input.domains;
  if (Array.isArray(d) && typeof d[0] === 'string') return d[0];
  return 'https://example.com/';
}

export function fixtureItems(check: CheckKey, target: string): unknown[] {
  const jitter = hash(target) % 15;
  switch (check) {
    case 'tracking_consent':
      return [
        {
          url: target,
          status: 'ok',
          score: 48 + jitter,
          grade: 'D',
          complianceRiskScore: 70,
          tagHealthScore: 61,
          cmp: { name: 'Cookiebot', detected: true },
          consentMode: { version: 'v2-basic', defaultsBeforeTags: false },
          summary: 'SAMPLE DATA: Google Analytics and Meta Pixel fire before consent; Reject does not stop the Meta Pixel.',
          reportUrl: 'https://api.apify.com/v2/key-value-stores/DRYRUN/records/report.html',
          findings: [
            { id: 'pre-consent-ga4', severity: 'critical', category: 'consent', title: 'GA4 fires before the visitor makes a consent choice', fix: 'Set Consent Mode v2 defaults to "denied" before the GTM container loads and gate GA4 on analytics_storage.', scenario: 'no-click', urls: [target] },
            { id: 'meta-after-reject', severity: 'critical', category: 'consent', title: 'Meta Pixel still fires after "Reject all"', fix: 'Add a consent trigger to the Meta Pixel tag in GTM (fire only when ad_storage = granted).', scenario: 'reject', urls: [target] },
            { id: 'cm-v2-missing-ad-user-data', severity: 'high', category: 'tracking', title: 'Consent Mode v2 signals ad_user_data / ad_personalization missing', fix: 'Update the CMP template to send all four v2 signals.', scenario: 'accept' },
            { id: 'duplicate-page-view', severity: 'medium', category: 'tracking', title: 'Duplicate GA4 page_view events (hard-coded gtag + GTM)', fix: 'Remove the hard-coded gtag.js snippet or the GTM GA4 config tag.', scenario: 'accept', urls: [target] },
            { id: 'cookie-banner-no-reject-first-layer', severity: 'medium', category: 'consent', title: 'No "Reject all" button on the first banner layer', fix: 'Show Reject all with equal prominence to Accept all (ICO / EDPB guidance).' },
          ],
          findingCounts: { critical: 2, high: 1, medium: 2, low: 0 },
        },
      ];
    case 'speed_revenue':
      return [
        {
          type: 'summary',
          url: target,
          score: 55 + jitter,
          summary: 'SAMPLE DATA: mobile LCP 4.1 s (poor); hero image and 3 third-party scripts block rendering.',
          metrics: { lcpMs: 4100, inpMs: 240, cls: 0.12, ttfbMs: 820, pageWeightKb: 3480, estimatedMonthlyRevenueLoss: 1850, currency: 'USD' },
          reportUrl: 'https://api.apify.com/v2/key-value-stores/DRYRUN/records/report.html',
        },
        { type: 'finding', id: 'lcp-hero-image', severity: 'high', category: 'performance', title: 'Hero image is 1.6 MB and not preloaded (LCP 4.1 s)', fix: 'Serve AVIF/WebP at display size, add fetchpriority="high" and <link rel=preload>.', effort: 'low', estimatedMonthlyRevenueLoss: 1100, url: target },
        { type: 'finding', id: 'render-blocking-3p', severity: 'high', category: 'performance', title: 'Three third-party scripts block first render', fix: 'Load chat widget and A/B-test script with defer/async or after interaction.', effort: 'medium', url: target },
        { type: 'finding', id: 'cls-banner', severity: 'medium', category: 'performance', title: 'Cookie banner shifts layout (CLS 0.12)', fix: 'Reserve space or render the banner as an overlay.', effort: 'low' },
        { type: 'finding', id: 'ttfb-slow', severity: 'medium', category: 'performance', title: 'Server response time 820 ms', fix: 'Enable full-page caching / CDN for anonymous traffic.', effort: 'medium' },
      ];
    case 'accessibility':
      return [
        {
          type: 'summary',
          url: target,
          score: 62 + jitter,
          summary: 'SAMPLE DATA: 4 WCAG 2.2 AA failures types across 3 pages; colour contrast and unlabeled form fields are the biggest blockers.',
          metrics: { pagesScanned: 3, violations: 4, nodesAffected: 37, wcagLevel: 'AA' },
          violations: [
            { id: 'color-contrast', impact: 'serious', help: 'Elements must meet minimum colour contrast ratio thresholds', description: 'Text contrast below 4.5:1', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast', tags: ['wcag2aa', 'wcag143'], pages: [target], fix: 'Darken body text to at least #595959 on white.' },
            { id: 'label', impact: 'critical', help: 'Form elements must have labels', description: 'Newsletter and checkout inputs lack accessible names', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/label', tags: ['wcag2a', 'wcag412'], pages: [target], fix: 'Add <label for> or aria-label to each input.' },
            { id: 'image-alt', impact: 'critical', help: 'Images must have alternative text', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt', tags: ['wcag2a', 'wcag111'], pages: [target], fix: 'Add meaningful alt text; use alt="" for decorative images.' },
            { id: 'target-size', impact: 'moderate', help: 'Touch targets must be at least 24×24 CSS px', tags: ['wcag22aa', 'wcag258'], pages: [target], fix: 'Increase icon-button hit areas to 24×24 px or add spacing.' },
          ],
        },
      ];
    case 'domain_email':
      return [
        {
          type: 'summary',
          domain: target,
          score: 58 + jitter,
          summary: 'SAMPLE DATA: DMARC is p=none and SPF exceeds 10 DNS lookups; domain can be spoofed.',
          metrics: { mx: true, spf: 'permerror', dmarcPolicy: 'none', dkimFound: ['google'], tlsDaysLeft: 41, dnssec: false },
        },
        { type: 'finding', id: 'dmarc-none', severity: 'high', category: 'email', title: 'DMARC policy is p=none (no spoofing protection)', fix: 'After checking reports, move to p=quarantine then p=reject: v=DMARC1; p=quarantine; rua=mailto:dmarc@' + target, standard: 'RFC 7489', effort: 'low' },
        { type: 'finding', id: 'spf-too-many-lookups', severity: 'high', category: 'email', title: 'SPF record needs more than 10 DNS lookups (permerror)', fix: 'Remove unused include: mechanisms or flatten the record.', standard: 'RFC 7208 §4.6.4', effort: 'medium' },
        { type: 'finding', id: 'no-mta-sts', severity: 'low', category: 'email', title: 'No MTA-STS policy', fix: 'Publish _mta-sts TXT and https://mta-sts.' + target + '/.well-known/mta-sts.txt', effort: 'medium' },
        { type: 'finding', id: 'no-caa', severity: 'low', category: 'dns', title: 'No CAA record', fix: 'Add CAA records naming your certificate authorities.', effort: 'low' },
      ];
    case 'ai_search':
      return [
        {
          type: 'summary',
          url: target,
          score: 66 + jitter,
          summary: 'SAMPLE DATA: GPTBot is blocked in robots.txt, no llms.txt, and product pages lack schema.org markup.',
          metrics: { llmsTxt: false, blockedAiBots: ['GPTBot', 'CCBot'], structuredDataTypes: ['Organization'], ssrContent: true },
        },
        { type: 'finding', id: 'gptbot-blocked', severity: 'high', category: 'ai-search', title: 'robots.txt blocks GPTBot (ChatGPT search cannot cite you)', fix: 'Allow OAI-SearchBot and GPTBot if you want ChatGPT visibility; keep training opt-outs separate.', effort: 'low' },
        { type: 'finding', id: 'no-llms-txt', severity: 'medium', category: 'ai-search', title: 'No /llms.txt file', fix: 'Publish /llms.txt summarising key pages for LLMs.', effort: 'low' },
        { type: 'finding', id: 'no-product-schema', severity: 'medium', category: 'ai-search', title: 'Key pages have no Product/Service structured data', fix: 'Add schema.org JSON-LD (Product, Offer, FAQPage, LocalBusiness as relevant).', effort: 'medium' },
      ];
  }
}

export class MockRunner implements ActorRunner {
  readonly dryRun = true;
  constructor(
    private readonly delayMs = 0,
    private readonly checkForActor: (actorId: string) => CheckKey | undefined,
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const check = this.checkForActor(req.actorId);
    if (!check) throw new Error(`MockRunner: unknown actor ${req.actorId}`);
    const target = targetOf(req.input);
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      if (req.signal.aborted) throw new CancelledError('Cancelled (dry run).');
      req.onProgress?.(Math.round((i / steps) * 100), 100, `DRY RUN: simulating ${req.actorId} (${i + 1}/${steps})`);
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs / steps));
    }
    if (req.signal.aborted) throw new CancelledError('Cancelled (dry run).');
    req.onProgress?.(100, 100, 'DRY RUN complete');
    const now = new Date().toISOString();
    return {
      actorId: req.actorId,
      runId: `dryrun-${check}`,
      status: 'SUCCEEDED',
      items: fixtureItems(check, target),
      startedAt: now,
      finishedAt: now,
      usageTotalUsd: 0,
      dryRun: true,
    };
  }

  async fetchRun(req: FetchResultsRequest): Promise<RunResult> {
    const check = req.runId.startsWith('dryrun-') ? (req.runId.slice(7) as CheckKey) : undefined;
    if (!check) throw new Error('DRY RUN: only dry-run run IDs (dryrun-<check>) can be fetched without an Apify token.');
    return { actorId: `dry-run/${check}`, runId: req.runId, status: 'SUCCEEDED', items: fixtureItems(check, 'https://example.com/'), dryRun: true };
  }
}
