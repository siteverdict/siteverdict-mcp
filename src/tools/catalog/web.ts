import * as z from 'zod/v4';
import { COST_NOTE, READ_ONLY, STATEFUL, clip, compactObj, pick, s, str, strList } from '../helpers.js';
import { UserInputError } from '../../lib/errors.js';
import type { DataToolSpec, Obj } from '../types.js';

/* ---------------------------------------------------------------- detect_tech_stack (tech-stack-detector) */
export const detectTechStack: DataToolSpec = {
  name: 'detect_tech_stack',
  title: 'Detect website technology stack',
  folder: 'tech-stack-detector',
  actor: 'siteverdict-tech-stack-detector',
  apiTool: 'tech-stack',
  toolsets: ['web', 'leads'],
  annotations: READ_ONLY,
  runTimeoutSecs: 600,
  memoryMbytes: 1024,
  maxItems: 50,
  description:
    'Detects the technology stack of one or many websites from public signals: homepage HTML, script/stylesheet URLs, HTTP headers, cookie names, public DNS (MX, SPF, DMARC, NS, CNAME), TLS issuer and robots.txt. Returns per site the technologies found (category, confidence 0-100, version, evidence) plus convenience fields cms, ecommerce, analytics, advertising, hosting, cdn, emailProviders and dnsProvider. Covers 1,000+ technologies (CMS, ecommerce and Shopify apps, analytics, tag managers, ad pixels, consent tools, CRM, chat, payments, CDN, hosting, email providers). Filters build lists such as "Shopify stores not using Klaviyo" (onlySitesUsing / excludeSitesUsing). mode "http" (default) is fast and cheap; "browser" also catches tags injected by tag managers. Respects robots.txt and never bypasses bot protection: blocked sites return status "blocked" and are not charged. It analyses only the sites you pass; it cannot list every site using a technology. ' +
    COST_NOTE,
  inputSchema: z.object({
    urls: strList(500, 2048).min(1).describe('Domains or URLs, e.g. ["example.com", "https://shop.example.co.uk"]'),
    mode: z.enum(['http', 'browser']).default('http').describe('"browser" renders in headless Chrome (more tags, costs more). Prefer http.'),
    extraPaths: strList(10, 200).optional().describe('Extra paths per site, e.g. ["/pricing", "/cart"]'),
    checkDns: z.boolean().default(true),
    checkTls: z.boolean().default(true),
    minConfidence: z.number().int().min(0).max(100).default(50),
    includeEvidence: z.boolean().default(false).describe('Include evidence strings (more tokens).'),
    onlySitesUsing: strList(50).optional().describe('Keep only sites using these technologies, e.g. ["Shopify"]'),
    onlyCategories: strList(30).optional().describe('Keep only these categories, e.g. ["Booking & scheduling"]'),
    matchAll: z.boolean().default(false).describe('onlySitesUsing must ALL match (default: any).'),
    excludeSitesUsing: strList(50).optional().describe('Drop sites using these, e.g. ["Klaviyo"]'),
  }),
  async validate(args, check) {
    const urls = await Promise.all((args.urls as string[]).map((u) => check.url(u)));
    return { ...args, urls };
  },
  buildInput: (a) => compactObj({ ...pick(a, ['urls', 'mode', 'extraPaths', 'checkDns', 'checkTls', 'minConfidence', 'includeEvidence', 'onlySitesUsing', 'onlyCategories', 'matchAll', 'excludeSitesUsing']), monitor: false, respectRobotsTxt: true }),
  // SiteVerdict API v1.1 fields only (unknown fields are rejected); several URLs run as one batch job. mode/extraPaths/filters are Actor-only.
  apiBody: (a) => compactObj({ url: (a.urls as string[])[0], urls: a.urls, check_dns: a.checkDns, check_tls: a.checkTls, min_confidence: a.minConfidence, include_evidence: a.includeEvidence }),
  shape: (i) => {
    const out = pick(i, ['url', 'domain', 'status', 'httpStatus', 'blockedReason', 'error', 'title', 'technologyCount', 'techNames', 'cms', 'ecommerce', 'analytics', 'advertising', 'hosting', 'cdn', 'emailProviders', 'dnsProvider', 'wordpressTheme', 'shopifyTheme', 'tls', 'notes', 'checkedAt']);
    if (Array.isArray(i.technologies)) out.technologies = (i.technologies as Obj[]).slice(0, 40).map((t) => pick(t, ['name', 'category', 'confidence', 'version', 'evidence']));
    return out;
  },
  line: (i) => `${s(i.domain || i.url)}: ${s(i.status)}${Array.isArray(i.techNames) ? ` — ${(i.techNames as string[]).slice(0, 12).join(', ')}` : ''}`,
  sample: (a) =>
    ((a.urls as string[]) ?? ['https://example.com/']).slice(0, 3).map((u) => ({
      url: u, domain: new URL(u).hostname, status: 'ok', httpStatus: 200, title: 'SAMPLE DATA', technologyCount: 6,
      techNames: ['WordPress', 'WooCommerce', 'Google Tag Manager', 'Google Analytics 4', 'Cloudflare', 'Google Workspace'],
      cms: ['WordPress'], ecommerce: ['WooCommerce'], analytics: ['Google Analytics 4'], cdn: ['Cloudflare'], emailProviders: ['Google Workspace'],
      technologies: [{ name: 'WordPress', category: 'CMS', confidence: 100, version: '6.6' }, { name: 'WooCommerce', category: 'Ecommerce', confidence: 90, version: null }],
      isSampleData: true,
    })),
  examples: ['What is acme.co.uk built on? Which email provider and CRM do they use?', 'Which of these 200 domains are Shopify stores without Klaviyo?'],
  costHint: 'site-detected (HTTP) or site-detected-browser per analysed site with at least one detection; blocked sites free.',
};

/* ---------------------------------------------------------------- monitor_website_changes (change-uptime-monitor) */
const monitorItem = z.object({
  url: str(2048),
  name: str(100).optional(),
  mode: z.enum(['http', 'browser']).optional(),
  selector: str(500).optional(),
  xpath: str(500).optional(),
  keywords: strList(20).optional(),
  trackPrices: z.boolean().optional(),
  extractSelector: str(500).optional(),
  extractAttribute: str(100).optional(),
  visualDiff: z.boolean().optional(),
  visualThresholdPercent: z.number().min(0).max(100).optional(),
});

export const monitorWebsiteChanges: DataToolSpec = {
  name: 'monitor_website_changes',
  title: 'Check website uptime and changes since last check',
  folder: 'change-uptime-monitor',
  actor: 'siteverdict-change-uptime-monitor',
  toolsets: ['web'],
  annotations: STATEFUL,
  runTimeoutSecs: 600,
  memoryMbytes: 2048,
  maxItems: 50,
  description:
    'Checks web pages for uptime and for changes since the last check. Per URL: up/down/blocked status, HTTP status, response time, TTFB, redirect chain, DNS result and TLS days-to-expiry; for pages checked before, a change verdict (baseline | no-change | changed) with a plain-English summary and a unified diffExcerpt. Detects text changes in the whole page or a CSS/XPath region, price changes, list items added/removed, keywords appearing/disappearing, SEO-critical changes (title, meta description, canonical, H1, noindex appearing), robots.txt/sitemap changes and, in browser mode, screenshot pixel differences. The FIRST call for a URL returns changeStatus "baseline": reuse the same stateStoreName on later calls to compare. Saves a private snapshot in the caller\'s Apify storage (nothing on the target site changes). Dates, times, UUIDs and copyright years are ignored by default; add ignorePatterns/excludeSelectors for false changes. Respects robots.txt; blocked pages are not charged. Browser mode costs 3x an HTTP check. ' +
    COST_NOTE,
  inputSchema: z.object({
    urls: strList(100, 2048).min(1).describe('Pages to check, e.g. ["https://shop.example/pricing"]'),
    monitors: z.array(monitorItem).max(100).optional().describe('Optional per-URL settings that override the global ones.'),
    mode: z.enum(['http', 'browser']).default('http'),
    contentSelector: str(500).optional().describe('CSS selector of the region to compare'),
    contentXPath: str(500).optional().describe('XPath of the region to compare'),
    excludeSelectors: strList(30, 500).optional(),
    ignorePatterns: strList(30, 300).optional().describe('Regexes masked before comparing'),
    keywords: strList(30).optional(),
    keywordAlertOn: z.enum(['both', 'appear', 'disappear']).default('both'),
    trackPrices: z.boolean().default(false),
    seoChecks: z.boolean().default(true),
    checkRobotsTxt: z.boolean().default(false),
    checkSitemap: z.boolean().default(false),
    visualDiff: z.boolean().default(false),
    visualThresholdPercent: z.number().min(0).max(100).optional(),
    minChangePercent: z.number().min(0).max(100).default(0),
    stateStoreName: z.string().regex(/^[a-z0-9-]{1,40}$/).default('default').describe('Your snapshot namespace (e.g. a project name); reuse it to compare with earlier calls.'),
    resetBaseline: z.boolean().default(false),
  }),
  async validate(args, check) {
    const urls = await Promise.all((args.urls as string[]).map((u) => check.url(u)));
    const monitors = args.monitors ? await Promise.all((args.monitors as Obj[]).map(async (m) => ({ ...m, url: await check.url(String(m.url)) }))) : undefined;
    return { ...args, urls, monitors };
  },
  buildInput: (a, ctx) =>
    compactObj({
      ...pick(a, ['urls', 'monitors', 'mode', 'contentSelector', 'contentXPath', 'excludeSelectors', 'ignorePatterns', 'keywords', 'keywordAlertOn', 'trackPrices', 'seoChecks', 'checkRobotsTxt', 'checkSitemap', 'visualDiff', 'visualThresholdPercent', 'minChangePercent', 'resetBaseline']),
      stateStoreName: ctx.stateName(String(a.stateStoreName ?? 'default')),
      respectRobotsTxt: true,
    }),
  shape: (i) => ({ ...pick(i, ['name', 'url', 'checkedAt', 'status', 'statusReason', 'httpStatus', 'responseTimeMs', 'ttfbMs', 'finalUrl', 'tlsDaysToExpiry', 'changeStatus', 'changeTypes', 'summary', 'previousCheckAt', 'warnings', 'prices', 'keywordsPresent']), diffExcerpt: clip(i.diffExcerpt, 4000) }),
  line: (i) => `${s(i.url)}: ${s(i.status)}${i.httpStatus ? ` (${s(i.httpStatus)})` : ''}, ${s(i.changeStatus)}${i.summary ? ` — ${s(i.summary)}` : ''}`,
  sample: (a) =>
    (a.urls as string[]).slice(0, 5).map((u, idx) => ({
      url: u, checkedAt: new Date().toISOString(), status: 'up', httpStatus: 200, responseTimeMs: 420 + idx * 10, ttfbMs: 180, tlsDaysToExpiry: 54,
      changeStatus: idx === 0 ? 'changed' : 'baseline', changeTypes: idx === 0 ? ['content', 'seo'] : [],
      summary: idx === 0 ? 'SAMPLE DATA: price of "Pro plan" changed £49 → £59; meta description changed.' : 'SAMPLE DATA: baseline saved; later calls compare against it.',
      diffExcerpt: idx === 0 ? '- Pro plan £49/month\n+ Pro plan £59/month' : '', isSampleData: true,
    })),
  examples: ['Is https://status.example.com up right now, and how many days are left on its SSL certificate?', 'Start watching the pricing table on https://competitor.example/pricing (#plans) and tell me when a price changes.'],
  costHint: 'Per URL checked; browser mode 3x; blocked pages free.',
};

/* ---------------------------------------------------------------- fetch_clean_markdown (web-to-markdown) */
export const fetchCleanMarkdown: DataToolSpec = {
  name: 'fetch_clean_markdown',
  title: 'Fetch web pages as clean Markdown with citations',
  folder: 'web-to-markdown',
  actor: 'siteverdict-web-to-markdown',
  apiTool: 'web-to-markdown',
  toolsets: ['web'],
  annotations: READ_ONLY,
  runTimeoutSecs: 600,
  memoryMbytes: 2048,
  maxItems: 20,
  description:
    'Fetches public web pages and returns their main content as clean Markdown (no menus, ads, cookie banners or footers), plus title, author, published/modified dates, language, canonical URL, a heading outline and a ready-made citation. Tables stay Markdown tables; code blocks keep their language. Use it to read, quote or summarise a page or load documentation; cite citation.url. chunk:true returns heading-aware chunks for long pages; mode "sitemap"/"crawl" (with maxPages, includeGlobs like "/docs/**") reads several pages of one site; rendering "auto" only if a page comes back nearly empty. Respects publishers: obeys robots.txt, never bypasses paywalls, logins, CAPTCHAs or bot protection, honours noai/TDM opt-outs — such pages return status "blocked"/"paywalled" with a reason and NO content; do not retry them by other means. ' +
    COST_NOTE,
  inputSchema: z.object({
    urls: strList(50, 2048).min(1).describe('Page URLs (or site / sitemap URLs for mode sitemap/crawl).'),
    mode: z.enum(['urls', 'sitemap', 'crawl']).default('urls'),
    maxPages: z.number().int().min(1).max(200).default(10).describe('Cap for sitemap/crawl modes.'),
    maxDepth: z.number().int().min(0).max(5).default(1),
    includeGlobs: strList(20).optional().describe('e.g. ["/docs/**"]'),
    excludeGlobs: strList(20).optional(),
    rendering: z.enum(['http', 'auto', 'browser']).default('http'),
    contentSelector: str(500).optional().describe('Optional CSS selector to force the content region.'),
    includeLinks: z.boolean().default(true).describe('Keep hyperlinks in the Markdown (false = fewer tokens).'),
    includeImages: z.boolean().default(false),
    chunk: z.boolean().default(false),
    chunkSize: z.number().int().min(64).max(4096).default(512),
    chunkOverlap: z.number().int().min(0).max(512).default(64),
    maxCharsPerPage: z.number().int().min(1000).max(100000).default(30000).describe('Server-side truncation of markdown per page; truncatedForAgent=true when cut.'),
  }),
  async validate(args, check) {
    return { ...args, urls: await Promise.all((args.urls as string[]).map((u) => check.url(u))) };
  },
  buildInput: (a) =>
    compactObj({
      startUrls: (a.urls as string[]).map((url) => ({ url })),
      ...pick(a, ['mode', 'maxPages', 'maxDepth', 'includeGlobs', 'excludeGlobs', 'contentSelector', 'chunkSize', 'chunkOverlap']),
      renderingMode: a.rendering,
      includeLinksInMarkdown: a.includeLinks,
      includeImagesInMarkdown: a.includeImages,
      enableChunking: a.chunk,
      includePlainText: false,
      includeJsonLd: false,
      outputSkippedPages: true,
      generateLlmsTxt: false,
    }),
  // SiteVerdict API v1.1 reads the given URLs only (no sitemap/crawl); several URLs run as one batch job.
  apiBody: (a) => {
    if (a.mode && a.mode !== 'urls') throw new UserInputError('mode "sitemap"/"crawl" is not available on the SiteVerdict API backend: pass the page URLs with mode "urls" (max 50).');
    return compactObj({ url: (a.urls as string[])[0], urls: a.urls, rendering: a.rendering, include_links: a.includeLinks, include_images: a.includeImages, chunking: a.chunk, chunk_size: a.chunk ? a.chunkSize : undefined });
  },
  shape: (i, a) => {
    const max = Number(a.maxCharsPerPage ?? 30000);
    const md = typeof i.markdown === 'string' ? i.markdown : undefined;
    const out = pick(i, ['url', 'status', 'reason', 'detail', 'title', 'author', 'publishedAt', 'modifiedAt', 'language', 'canonicalUrl', 'headings', 'wordCount', 'tokenEstimate', 'citation']);
    if (md !== undefined) {
      out.markdown = md.length > max ? md.slice(0, max) : md;
      out.truncatedForAgent = md.length > max;
    }
    if (Array.isArray(i.chunks)) out.chunks = (i.chunks as Obj[]).slice(0, 40).map((c) => ({ ...pick(c, ['chunkIndex', 'chunkId', 'headingPath', 'anchorUrl', 'tokenEstimate']), text: clip(c.text, 3000) }));
    return out;
  },
  line: (i) => `${s(i.url)}: ${s(i.status)}${i.title ? ` — "${s(i.title)}"` : ''}${i.wordCount ? ` (${s(i.wordCount)} words)` : ''}${i.reason ? ` [${s(i.reason)}]` : ''}`,
  sample: (a) =>
    (a.urls as string[]).slice(0, 3).map((u) => ({
      url: u, status: 'ok', title: 'SAMPLE DATA: Example Domain', language: 'en', canonicalUrl: u, wordCount: 28, tokenEstimate: 40,
      markdown: '# Example Domain\n\nSAMPLE DATA. This domain is for use in illustrative examples in documents.',
      headings: [{ level: 1, text: 'Example Domain' }],
      citation: { title: 'Example Domain', url: u, siteName: new URL(u).hostname, author: null, publishedAt: null, accessedAt: new Date().toISOString() },
      isSampleData: true,
    })),
  examples: ['Read https://docs.python.org/3/library/asyncio-task.html and explain TaskGroup with a citation.', 'Load the /guides/** pages from docs.example.com (max 50) and chunk them at 400 tokens.'],
  costHint: 'About $0.0015 per page ($0.004 with a browser); blocked pages free.',
};
