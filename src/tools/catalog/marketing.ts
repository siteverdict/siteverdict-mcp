import * as z from 'zod/v4';
import { COST_NOTE, READ_ONLY, STATEFUL, clip, compactObj, country2, isoDate, pick, s, str, strList } from '../helpers.js';
import type { DataToolSpec, Obj } from '../types.js';

/* ---------------------------------------------------------------- seo_rank_check */
export const seoRankCheck: DataToolSpec = {
  name: 'seo_rank_check',
  title: 'Check Google/Brave rankings for keywords',
  folder: 'seo-rank-tracker',
  actor: 'siteverdict-seo-rank-tracker',
  toolsets: ['marketing'],
  annotations: STATEFUL,
  runTimeoutSecs: 900,
  memoryMbytes: 1024,
  maxItems: 80,
  secrets: [
    { name: 'DATAFORSEO_LOGIN', label: 'DataForSEO login', help: 'Your own DataForSEO API login.' },
    { name: 'DATAFORSEO_PASSWORD', label: 'DataForSEO password', help: 'Your own DataForSEO API password.' },
    { name: 'SERPAPI_API_KEY', label: 'SerpApi key', help: 'Your own SerpApi key.' },
    { name: 'SERPER_API_KEY', label: 'Serper.dev key', help: 'Your own Serper.dev key.' },
    { name: 'BRAVE_API_KEY', label: 'Brave Search API key', help: 'Your own Brave Search API key.' },
    { name: 'GSC_CREDENTIALS_JSON', label: 'Search Console service-account JSON', help: 'Service account added as a user on your Search Console property.' },
  ],
  description:
    'Checks where domains rank in Google (or Brave) for a list of keywords by country, city, language and device, using the user\'s OWN SERP API key (DataForSEO, SerpApi, Serper.dev or Brave) configured on the server. Per keyword: organic position, ranking URL, change since the last run under the same projectName (rank history is saved in the caller\'s Apify storage), lost/gained alerts, top-10 results, SERP features (featured snippet owner, AI Overview present and whether it cites the domain, local pack, People Also Ask, ads count) and visibility/share-of-voice per domain. Can also pull real clicks/impressions/position from Google Search Console for a property the user owns. Does not scrape search engines. Use executionMode "estimate" first for large keyword lists. Without a key it returns clearly labelled SAMPLE data (isSampleData true) — never present that as real rankings. ' +
    COST_NOTE,
  inputSchema: z.object({
    keywords: strList(200, 200).optional().describe("Keywords; optional volume after a pipe: 'running shoes | 27100'"),
    targetDomains: strList(10, 253).min(1).describe("The user's domain(s), e.g. example.com"),
    competitorDomains: strList(20, 253).optional(),
    provider: z.enum(['dataforseo', 'serpapi', 'serper', 'brave', 'none']).default('dataforseo'),
    locations: z.array(z.object({ country: country2(), language: z.string().regex(/^[a-z]{2}$/).optional(), city: str(100).optional() })).min(1).max(10).default([{ country: 'GB', language: 'en' }]),
    devices: z.array(z.enum(['desktop', 'mobile'])).min(1).default(['desktop']),
    depth: z.number().int().min(10).max(100).default(20),
    projectName: z.string().regex(/^[a-z0-9-]{1,40}$/).optional().describe('Reuse the same name to get rank changes vs the previous run'),
    executionMode: z.enum(['auto', 'live', 'dryRun', 'estimate']).default('auto'),
    maxCostUsd: z.number().min(0).max(50).default(1).describe('Cap on provider spend (billed by the provider to the user)'),
    gscSiteUrl: str(300).optional().describe('sc-domain:example.com or https://www.example.com/'),
    gscOnlyTrackedKeywords: z.boolean().default(true),
    keywordIdeasSeeds: strList(10).optional().describe('DataForSEO only'),
  }),
  buildInput: (a, ctx) => {
    const sec = ctx.secrets;
    const has: Record<string, boolean> = {
      dataforseo: Boolean(sec.DATAFORSEO_LOGIN && sec.DATAFORSEO_PASSWORD),
      serpapi: Boolean(sec.SERPAPI_API_KEY),
      serper: Boolean(sec.SERPER_API_KEY),
      brave: Boolean(sec.BRAVE_API_KEY),
      none: true,
    };
    let mode = a.executionMode;
    if (!has[String(a.provider)] && mode !== 'estimate') {
      mode = 'dryRun';
      ctx.notes.push(`No ${String(a.provider)} credentials configured for this user: results are SAMPLE data (dry run), not real rankings.`);
    }
    return compactObj({
      ...pick(a, ['keywords', 'targetDomains', 'competitorDomains', 'provider', 'locations', 'devices', 'depth', 'maxCostUsd', 'gscSiteUrl', 'gscOnlyTrackedKeywords', 'keywordIdeasSeeds']),
      executionMode: mode,
      projectName: ctx.stateName(String(a.projectName ?? 'default')),
      dataforseoLogin: sec.DATAFORSEO_LOGIN,
      dataforseoPassword: sec.DATAFORSEO_PASSWORD,
      serpapiApiKey: sec.SERPAPI_API_KEY,
      serperApiKey: sec.SERPER_API_KEY,
      braveApiKey: sec.BRAVE_API_KEY,
      gscCredentialsJson: a.gscSiteUrl ? sec.GSC_CREDENTIALS_JSON : undefined,
    });
  },
  shape: (i) => {
    if (i.recordType === 'rank') {
      return { ...pick(i, ['recordType', 'keyword', 'location', 'device', 'provider', 'engine', 'domain', 'position', 'url', 'previousPosition', 'change', 'status', 'serpFeatures', 'targetOwnsFeaturedSnippet', 'targetCitedInAiOverview', 'alerts', 'gscLast', 'providerCostUsd', 'checkedAt', 'isSampleData']), top10: Array.isArray(i.top10) ? (i.top10 as Obj[]).slice(0, 10).map((r) => pick(r, ['position', 'domain', 'url', 'title'])) : undefined };
    }
    return i;
  },
  line: (i) => {
    switch (i.recordType) {
      case 'rank': return `"${s(i.keyword)}" ${s(i.location)} ${s(i.device)}: ${s(i.domain)} #${i.position ?? '—'} (${s(i.status)}${i.change ? `, ${Number(i.change) > 0 ? '+' : ''}${s(i.change)}` : ''})${i.targetCitedInAiOverview ? ' · cited in AI Overview' : ''}`;
      case 'visibility': return `Visibility ${s(i.domain)}: ${s(i.visibility)} (SoV ${s(i.shareOfVoice)}%, top10 ${s(i.top10)})`;
      case 'alert': return `Alert: ${s(i.message)}`;
      case 'gsc': return `GSC "${s(i.query)}": ${s(i.clicks)} clicks, ${s(i.impressions)} impr, pos ${s(i.position)}`;
      case 'keywordIdea': return `Idea "${s(i.keyword)}": volume ${s(i.searchVolume)}`;
      case 'error': case 'skipped': return `${s(i.recordType)}: ${s(i.error || i.reason)}`;
      default: return null;
    }
  },
  sample: (a) =>
    ((a.keywords as string[] | undefined) ?? ['example keyword']).slice(0, 5).map((k, idx) => ({ recordType: 'rank', keyword: k.split('|')[0]!.trim(), location: 'GB', device: 'desktop', provider: 'sample', domain: (a.targetDomains as string[])[0], position: idx + 3, url: `https://${(a.targetDomains as string[])[0]}/`, previousPosition: idx + 5, change: 2, status: 'up', targetCitedInAiOverview: idx === 0, isSampleData: true })),
  examples: ["Where does acme.co.uk rank in the UK for 'running shoes' on mobile and desktop, compared with rival.com?", 'Which of my keywords show an AI Overview, and does it cite my site?'],
  costHint: 'Per keyword check; provider costs billed by the provider to your key.',
};

/* ---------------------------------------------------------------- search_traffic_diagnose */
export const searchTrafficDiagnose: DataToolSpec = {
  name: 'search_traffic_diagnose',
  title: 'Diagnose organic traffic from Search Console and GA4',
  folder: 'gsc-ga4-analyst',
  actor: 'siteverdict-gsc-ga4-analyst',
  toolsets: ['marketing'],
  annotations: READ_ONLY,
  runTimeoutSecs: 900,
  memoryMbytes: 1024,
  maxItems: 10,
  secrets: [
    { name: 'GOOGLE_SERVICE_ACCOUNT_JSON', label: 'Google service-account JSON', help: 'Service account added as a user on your Search Console property and GA4 property.' },
    { name: 'GOOGLE_OAUTH_CLIENT_ID', label: 'Google OAuth client ID', help: 'Alternative to a service account.' },
    { name: 'GOOGLE_OAUTH_CLIENT_SECRET', label: 'Google OAuth client secret', help: 'Pairs with the client ID.' },
    { name: 'GOOGLE_OAUTH_REFRESH_TOKEN', label: 'Google OAuth refresh token', help: 'Scopes: webmasters.readonly, analytics.readonly.' },
  ],
  description:
    "Diagnoses a website's Google organic performance from its OWN Google Search Console and GA4 data (the user's Google credentials must be configured on the server; otherwise it returns fictional SAMPLE data and says so). Compares a current period with the previous period or the same period last year. Per property: headline deltas (clicks, impressions, CTR, position, sessions, organic sessions, key events, revenue), why clicks changed per losing page (ranking lost / CTR dropped / demand fell / page deindexed, confirmed via URL Inspection), striking-distance queries (positions 5-20), low-CTR pages, cannibalisation, sitemap errors, GA4 breakdowns, revenue at risk, tracking/consent red flags (e.g. GA4 organic sessions collapsing while Google clicks hold) and a ranked top-10 action list. Deterministic and rule-based. Use for \"why did our organic traffic drop?\", \"SEO quick wins?\" or \"is our GA4 tracking broken?\". Not legal advice. " +
    COST_NOTE,
  inputSchema: z.object({
    properties: z
      .array(z.object({ label: str(100).optional(), gscSiteUrl: str(300).optional().describe('sc-domain:example.com, https://www.example.com/ or example.com'), ga4PropertyId: z.string().regex(/^(properties\/)?\d{5,15}$/).optional().describe('Numeric GA4 Property ID (not the G- measurement ID)') }))
      .min(1)
      .max(10),
    comparison: z.enum(['previous_period', 'year_over_year', 'custom']).default('previous_period'),
    periodDays: z.number().int().min(7).max(180).default(28),
    currentStartDate: isoDate().optional(),
    currentEndDate: isoDate().optional(),
    previousStartDate: isoDate().optional(),
    previousEndDate: isoDate().optional(),
    searchType: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).default('web'),
    brandTerms: strList(20).optional().describe('Brand words, excluded from opportunities and reported separately.'),
    maxUrlInspections: z.number().int().min(0).max(50).default(10),
  }),
  buildInput: (a, ctx) => {
    const sec = ctx.secrets;
    const oauth = sec.GOOGLE_OAUTH_CLIENT_ID && sec.GOOGLE_OAUTH_CLIENT_SECRET && sec.GOOGLE_OAUTH_REFRESH_TOKEN;
    const authMethod = sec.GOOGLE_SERVICE_ACCOUNT_JSON ? 'serviceAccount' : oauth ? 'oauth' : 'sample';
    if (authMethod === 'sample') ctx.notes.push('No Google credentials configured for this user: results are FICTIONAL sample data.');
    return compactObj({
      ...a,
      authMethod,
      serviceAccountJson: authMethod === 'serviceAccount' ? sec.GOOGLE_SERVICE_ACCOUNT_JSON : undefined,
      oauthClientId: authMethod === 'oauth' ? sec.GOOGLE_OAUTH_CLIENT_ID : undefined,
      oauthClientSecret: authMethod === 'oauth' ? sec.GOOGLE_OAUTH_CLIENT_SECRET : undefined,
      oauthRefreshToken: authMethod === 'oauth' ? sec.GOOGLE_OAUTH_REFRESH_TOKEN : undefined,
      maxTableRows: 15,
      includeGa4Realtime: true,
    });
  },
  shape: (i) => ({
    ...pick(i, ['label', 'status', 'sampleData', 'gscSiteUrl', 'ga4PropertyId', 'periods', 'summary', 'gsc', 'ga4', 'dropCauses', 'topActions', 'notes', 'errors', 'reportUrl', 'dataUrl']),
    findings: Array.isArray(i.findings) ? (i.findings as Obj[]).slice(0, 25).map((f) => ({ ...pick(f, ['id', 'category', 'severity', 'title', 'action', 'impactClicks']), detail: clip(f.detail, 400) })) : [],
    isSampleData: i.sampleData === true || i.isSampleData === true,
  }),
  line: (i) => `${s(i.label || i.gscSiteUrl || i.ga4PropertyId)} (${s(i.status)}): ${s(i.summary)}`,
  sample: (a) =>
    (a.properties as Obj[]).slice(0, 2).map((p) => ({
      label: p.label ?? p.gscSiteUrl ?? 'property', status: 'ok', sampleData: true, gscSiteUrl: p.gscSiteUrl ?? null, ga4PropertyId: p.ga4PropertyId ?? null,
      summary: 'SAMPLE DATA: clicks -18% vs previous 28 days, mostly ranking lost on 3 product pages; GA4 organic sessions -41% while clicks -18% suggests a consent/tracking break since 2026-09-20.',
      gsc: { clicks: { previous: 12400, current: 10170, changePct: -18 } }, dropCauses: [{ cause: 'ranking_lost', causeLabel: 'Ranking lost', pages: 3, clicksLost: 1650 }],
      topActions: [{ rank: 1, priority: 'critical', action: 'Fix GA4 consent default (organic sessions collapsed 20 Sep)', why: 'Tracking gap', findingId: 'ga4-gap' }],
      findings: [], isSampleData: true,
    })),
  examples: ['Why did organic traffic to example.com drop last month?', 'GA4 sessions fell but Search Console looks fine. Is our tracking broken, and since when?'],
  costHint: 'property-analysed per property + url-inspected per inspection.',
};

/* ---------------------------------------------------------------- google_ads_transparency */
const ADS_GUIDE = 'Data comes from Google\'s official public BigQuery datasets (no scraping). It does NOT include ad text, images, landing pages, or non-political ads outside the EEA/Turkey — never claim otherwise.';
export const googleAdsTransparency: DataToolSpec = {
  name: 'google_ads_transparency',
  title: 'Query Google ad transparency data (BigQuery)',
  folder: 'google-ads-transparency',
  actor: 'siteverdict-google-ads-transparency',
  toolsets: ['marketing'],
  annotations: READ_ONLY,
  runTimeoutSecs: 900,
  memoryMbytes: 1024,
  maxItems: 60,
  secrets: [{ name: 'GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON', label: 'Google Cloud service-account JSON (BigQuery Job User)', help: "BigQuery bills the user's own project." }],
  description:
    "Queries Google's OFFICIAL public ad-transparency datasets on BigQuery: which ads an advertiser runs on Google in the EEA and Turkey (creative IDs, format, first/last shown, regions, impression ranges, topic, payer), one summary per advertiser, or political/election ads with impression buckets, spend ranges and spend summaries by advertiser or region. Needs the user's Google Cloud service-account JSON configured on the server (BigQuery bills the user's project); without it returns fictitious SAMPLE rows (isSample true). ALWAYS call with estimateOnly:true first and tell the user the estimated GB/cost (1 TiB/month free tier) before a real run; if withinBudget is false, narrow the query rather than retrying. " +
    ADS_GUIDE + ' ' + COST_NOTE,
  inputSchema: z.object({
    mode: z.enum(['creatives', 'advertisers', 'politicalCreatives', 'politicalSpend']).default('creatives'),
    billingProjectId: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/).optional(),
    advertiserNames: strList(20).optional().describe('contains-match on advertiser name'),
    advertiserIds: z.array(z.string().regex(/^AR\d{10,30}$/)).max(50).optional(),
    domains: strList(20, 253).optional().describe('heuristic: converted to a brand-name search'),
    regions: strList(30, 10).optional().describe('ISO codes, e.g. FR, DE, EEA; political: GB, US, US-CA'),
    dateFrom: isoDate().optional(),
    dateTo: isoDate().optional(),
    formats: z.array(z.enum(['TEXT', 'IMAGE', 'VIDEO'])).max(3).optional(),
    topics: strList(20).optional(),
    advertiserLocations: strList(20, 10).optional(),
    politicalGroupBy: z.enum(['advertiser', 'country', 'subdivision']).optional(),
    currency: z.enum(['USD', 'EUR', 'GBP', 'INR', 'AUD', 'NZD', 'BRL', 'MXN', 'ZAR', 'ILS', 'TWD', 'ARS', 'CLP', 'BGN', 'CZK', 'DKK', 'HUF', 'PLN', 'RON', 'SEK']).optional(),
    maxRows: z.number().int().min(1).max(5000).default(100),
    maxGbBilled: z.number().min(0.01).max(5000).default(50),
    maxEstimatedCostUsd: z.number().min(0).optional(),
    estimateOnly: z.boolean().default(true).describe('Default true: dry-run the query and report GB/cost first.'),
  }),
  buildInput: (a, ctx) => {
    const sa = ctx.secrets.GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON;
    if (!sa) ctx.notes.push('No Google Cloud service account configured for this user: rows are FICTITIOUS samples.');
    return compactObj({ ...a, serviceAccountJson: sa, sampleMode: !sa });
  },
  shape: (i) => i,
  line: (i) => {
    switch (i.recordType) {
      case 'costEstimate': return `Estimate: ${s(i.estimatedGb)} GB, ~$${s(i.estimatedCostUsd)} (${i.withinBudget ? 'within budget' : 'OVER budget'})`;
      case 'creative': return `${s(i.advertiserName)} ${s(i.format)} ${s(i.creativeId)}: ${s(i.firstShown)}→${s(i.lastShown)} ${(Array.isArray(i.regions) ? (i.regions as string[]) : []).join(',')}`;
      case 'advertiser': return `${s(i.advertiserName)}: ${s(i.creativeCount)} creatives (${s(i.creativesShownLast30d)} in last 30d)`;
      case 'politicalCreative': return `${s(i.advertiserName)}: ${s(i.impressionsRange)} impressions, spend ${s(i.spendMin)}-${s(i.spendMax)} ${s(i.spendCurrency)}`;
      default: return i.recordType ? `${s(i.recordType)}: ${s(i.advertiserName || i.region)} ${s(i.lifetimeSpend)} ${s(i.spendCurrency)}` : null;
    }
  },
  disclaimer: ADS_GUIDE,
  sample: (a) => [
    { recordType: 'costEstimate', query: 'SAMPLE', tables: ['bigquery-public-data.google_ads_transparency_center.creative_stats'], estimatedGb: 3.2, estimatedCostUsd: 0.02, withinBudget: true, message: 'SAMPLE estimate', isSample: true },
    ...(a.estimateOnly === false ? [{ recordType: 'creative', advertiserId: 'AR00000000000000000001', advertiserName: 'SAMPLE ADVERTISER LTD', creativeId: 'CR00000000000000000001', format: 'VIDEO', firstShown: '2026-07-02', lastShown: '2026-10-09', regions: ['DE'], isSample: true }] : []),
  ],
  examples: ['What video ads has Booking.com been running in Germany since July? Estimate the BigQuery cost first.', 'Which advertisers spent the most on UK political ads between July and September 2026, in GBP?'],
  costHint: 'Per row returned; BigQuery bills your own Google Cloud project.',
};

/* ---------------------------------------------------------------- reviews_monitor */
export const reviewsMonitor: DataToolSpec = {
  name: 'reviews_monitor',
  title: "Monitor your own business's reviews",
  folder: 'reviews-monitor',
  actor: 'siteverdict-reviews-monitor',
  toolsets: ['marketing'],
  annotations: STATEFUL,
  runTimeoutSecs: 900,
  memoryMbytes: 1024,
  maxItems: 60,
  secrets: [
    { name: 'GOOGLE_BP_CLIENT_ID', label: 'Google Business Profile OAuth client ID', help: 'Your Google Cloud OAuth client with Business Profile API access.' },
    { name: 'GOOGLE_BP_CLIENT_SECRET', label: 'Google Business Profile OAuth client secret', help: '' },
    { name: 'GOOGLE_BP_REFRESH_TOKEN', label: 'Google Business Profile refresh token', help: '' },
    { name: 'TRUSTPILOT_API_KEY', label: 'Trustpilot API key', help: '' },
    { name: 'TRUSTPILOT_API_SECRET', label: 'Trustpilot API secret', help: '' },
    { name: 'YELP_API_KEY', label: 'Yelp Fusion API key', help: '' },
    { name: 'FACEBOOK_PAGE_ACCESS_TOKEN', label: 'Facebook Page access token', help: 'Legacy API ending 21 Jan 2027.' },
    { name: 'YOTPO_APP_KEY', label: 'Yotpo app key', help: '' },
    { name: 'YOTPO_SECRET_KEY', label: 'Yotpo secret key', help: '' },
  ],
  description:
    "Fetches reviews of the user's OWN business from official APIs (Google Business Profile, Trustpilot, Feefo, Yotpo, Yelp excerpts, legacy Facebook recommendations), using the user's credentials configured on the server (none configured = fictional SAMPLE data, flagged isSampleData). Returns new/updated reviews since the last check (state saved in the caller's Apify storage) or within a lookback window, normalised to 1-5 stars with reply status and a low-star flag, a template DRAFT reply for each unanswered review (never posted), and one analytics summary per location: star distribution, 30-day trend, response rate and median reply time, unanswered low-star count, top keywords and topic counts with average rating. Deterministic (no AI). Only the user's own businesses — refuse requests to monitor competitors. Nothing is ever posted. Reviewer names are omitted unless asked. Yelp rows are excerpts. Not legal advice. " +
    COST_NOTE,
  inputSchema: z.object({
    mode: z.enum(['monitor', 'backfill']).default('monitor').describe('monitor = only new/changed since the last check; backfill = everything in the window'),
    lookbackDays: z.number().int().min(0).max(730).default(30),
    sinceDate: isoDate().optional(),
    platforms: z.array(z.enum(['google', 'trustpilot', 'feefo', 'yotpo', 'yelp', 'facebook'])).max(6).optional().describe('Restrict to these platforms (default: all configured)'),
    googleLocations: z.array(z.string().regex(/^accounts\/[^/]+\/locations\/[^/]+$/)).max(25).optional(),
    trustpilotBusinessUnits: strList(10, 100).optional().describe('Domain (example.com) or 24-character business-unit ID'),
    feefoMerchantIds: strList(10, 100).optional(),
    yelpBusinessIds: strList(10, 100).optional(),
    facebookPageId: z.string().regex(/^\d{5,25}$/).optional(),
    lowStarThreshold: z.number().int().min(1).max(4).default(2),
    includeReviewText: z.boolean().default(true),
    includeReviewerNames: z.boolean().default(false).describe('Personal data; only when the user explicitly asks'),
    generateDraftReplies: z.boolean().default(true),
    businessName: str(100).optional(),
    draftContactLine: str(200).optional(),
    customTopics: strList(20, 200).optional().describe("Lines like 'Vegan menu: vegan, plant based'"),
    locationSummaries: z.enum(['changed', 'always', 'off']).default('always'),
    maxReviewsPerLocation: z.number().int().min(1).max(2000).default(200),
    stateName: z.string().regex(/^[a-z0-9-]{1,40}$/).default('default').describe('Brand/project name for "new since last time" state.'),
  }),
  buildInput: (a, ctx) => {
    const sec = ctx.secrets;
    const want = (p: string) => !a.platforms || (a.platforms as string[]).includes(p);
    const creds = compactObj({
      googleClientId: want('google') ? sec.GOOGLE_BP_CLIENT_ID : undefined,
      googleClientSecret: want('google') ? sec.GOOGLE_BP_CLIENT_SECRET : undefined,
      googleRefreshToken: want('google') ? sec.GOOGLE_BP_REFRESH_TOKEN : undefined,
      trustpilotApiKey: want('trustpilot') ? sec.TRUSTPILOT_API_KEY : undefined,
      trustpilotApiSecret: want('trustpilot') ? sec.TRUSTPILOT_API_SECRET : undefined,
      yelpApiKey: want('yelp') ? sec.YELP_API_KEY : undefined,
      facebookPageAccessToken: want('facebook') ? sec.FACEBOOK_PAGE_ACCESS_TOKEN : undefined,
      yotpoAppKey: want('yotpo') ? sec.YOTPO_APP_KEY : undefined,
      yotpoSecretKey: want('yotpo') ? sec.YOTPO_SECRET_KEY : undefined,
    });
    const live = Object.keys(creds).length > 0 || Boolean(a.feefoMerchantIds);
    if (!live) ctx.notes.push('No review-platform credentials configured for this user: reviews are FICTIONAL sample data.');
    const { stateName, platforms: _p, ...rest } = a;
    return compactObj({ ...rest, ...creds, executionMode: live ? 'live' : 'sample', stateName: ctx.stateName(String(stateName ?? 'default')), keywordsPerLocation: 10 });
  },
  shape: (i) => (i.recordType === 'review' ? { ...pick(i, ['recordType', 'platform', 'locationName', 'reviewId', 'changeType', 'rating', 'recommendation', 'isLowStar', 'title', 'textIsExcerpt', 'language', 'createdAt', 'hasReply', 'responseTimeHours', 'reviewUrl', 'draftReply', 'reviewerName', 'isSampleData']), text: clip(i.text, 600), replyText: clip(i.replyText, 300) } : pick(i, ['recordType', 'platform', 'locationName', 'platformAverageRating', 'platformTotalReviews', 'averageRating', 'starDistribution', 'volume', 'trend', 'response', 'textAnalytics', 'reason', 'message', 'hint', 'isSampleData'])),
  sort: (a, b) => (b.isLowStar === true ? 1 : 0) - (a.isLowStar === true ? 1 : 0),
  line: (i) => {
    if (i.recordType === 'review') return `${s(i.platform)} ${'★'.repeat(Number(i.rating ?? 0))} ${s(i.locationName)}: ${s(clip(i.text, 140))}${i.hasReply ? '' : ' [unanswered]'}`;
    if (i.recordType === 'location-summary') return `${s(i.platform)} ${s(i.locationName)}: avg ${s(i.averageRating)}, trend ${s((i.trend as Obj | undefined)?.direction)}, response rate ${s((i.response as Obj | undefined)?.responseRatePct)}%`;
    if (i.recordType === 'error') return `Error ${s(i.platform)}: ${s(i.message)}${i.hint ? ` (${s(i.hint)})` : ''}`;
    return null;
  },
  disclaimer: 'Draft replies are drafts only — nothing was posted.',
  sample: () => [
    { recordType: 'review', platform: 'google', locationName: 'SAMPLE Café Plymouth', reviewId: 'r1', changeType: 'new', rating: 2, isLowStar: true, text: 'SAMPLE DATA: Slow service at lunchtime and my order was wrong.', hasReply: false, createdAt: '2026-10-10T12:00:00Z', draftReply: { status: 'DRAFT - not posted', band: 'low', text: 'Thank you for your feedback — we are sorry…' }, isSampleData: true },
    { recordType: 'location-summary', platform: 'google', locationName: 'SAMPLE Café Plymouth', averageRating: 4.3, trend: { direction: 'down', delta: -0.2 }, response: { responseRatePct: 62, medianResponseHours: 30, unansweredLowStar: 3 }, isSampleData: true },
  ],
  examples: ['Did we get any 1- or 2-star reviews since yesterday? Draft replies for them.', "What's our Trustpilot response rate and median reply time?"],
  costHint: 'Per review returned; summaries cheap; errors free.',
};
