import * as z from 'zod/v4';
import { COST_NOTE, READ_ONLY, STATEFUL, clip, compactObj, country2, isoDate, money, pick, s, str, strList } from '../helpers.js';
import type { DataToolSpec, Obj } from '../types.js';

/* ---------------------------------------------------------------- find_local_businesses */
export const findLocalBusinesses: DataToolSpec = {
  name: 'find_local_businesses',
  title: 'Find local businesses by category and place',
  folder: 'local-business-leads',
  actor: 'siteverdict-local-business-leads',
  toolsets: ['leads'],
  annotations: READ_ONLY,
  runTimeoutSecs: 900,
  memoryMbytes: 1024,
  maxItems: 60,
  secrets: [{ name: 'GOOGLE_MAPS_API_KEY', label: 'Google Maps Platform API key', help: 'Your own key from console.cloud.google.com (Places API (New) enabled). Google bills this key.' }],
  description:
    'Finds local businesses by category and place, e.g. "plumbers in Bristol" or "cafes near PL1 1AA". Returns name, category, address, latitude/longitude, phone, website and domain, and (Google only) rating, review count, opening hours and business status. OpenStreetMap is the default source (free open data, ODbL — attribute "© OpenStreetMap contributors"). source "google" uses the official Google Places API (New) with the user\'s OWN Google Maps Platform key configured on the server (Google bills that key; respect googleBudgetUsd; show "Google Maps" attribution; do not store Google names/addresses beyond Google\'s terms). Without a key, Google requests return a cost estimate only. Never use this tool to collect personal data about individuals; e-mails and reviewer names are always off. ' +
    COST_NOTE,
  inputSchema: z.object({
    queries: strList(20, 200).min(1).describe('"<what> in <where>", e.g. "dentists in Leeds"'),
    source: z.enum(['osm', 'google', 'both']).default('osm'),
    countryCode: country2().optional().describe('ISO 3166-1 alpha-2, e.g. gb'),
    lat: z.string().regex(/^-?\d{1,2}(\.\d+)?$/).optional(),
    lng: z.string().regex(/^-?\d{1,3}(\.\d+)?$/).optional(),
    radiusMeters: z.number().int().min(50).max(50000).optional(),
    boundingBox: z.string().regex(/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/).optional().describe('south,west,north,east'),
    maxResultsPerQuery: z.number().int().min(1).max(1000).default(50),
    googleFieldPreset: z.enum(['ids', 'basic', 'contact', 'atmosphere']).default('contact'),
    googleBudgetUsd: z.number().min(0).max(100).default(2),
    googleDryRun: z.boolean().default(false).describe('Only estimate the Google cost; make no Google calls.'),
    minRating: z.number().min(0).max(5).optional(),
    minReviews: z.number().int().min(0).optional(),
    hasWebsite: z.boolean().optional(),
    noWebsiteOnly: z.boolean().optional(),
    hasPhone: z.boolean().optional(),
  }),
  buildInput: (a, ctx) => {
    const key = ctx.secrets.GOOGLE_MAPS_API_KEY;
    const wantsGoogle = a.source !== 'osm';
    if (wantsGoogle && !key) ctx.notes.push('No Google Maps key configured (SITEVERDICT_SECRET_GOOGLE_MAPS_API_KEY): Google results are a cost estimate only; OpenStreetMap results are real.');
    return compactObj({
      ...pick(a, ['queries', 'source', 'countryCode', 'lat', 'lng', 'radiusMeters', 'boundingBox', 'maxResultsPerQuery', 'googleFieldPreset', 'googleBudgetUsd', 'minRating', 'minReviews', 'hasWebsite', 'noWebsiteOnly', 'hasPhone']),
      googleApiKey: wantsGoogle ? key : undefined,
      googleDryRun: Boolean(a.googleDryRun) || (wantsGoogle && !key),
      includeEmails: false,
      includeReviewerNames: false,
      includeReviews: false,
      osmContact: ctx.contactEmail,
    });
  },
  shape: (i) => pick(i, ['source', 'name', 'primaryCategory', 'address', 'city', 'postcode', 'countryCode', 'lat', 'lng', 'phone', 'website', 'domain', 'hasWebsite', 'googleMapsUrl', 'osmUrl', 'rating', 'reviewCount', 'openingHours', 'businessStatus', 'attribution', 'isSampleData']),
  line: (i) => `${s(i.name)} — ${s(i.primaryCategory)}, ${s(i.address || i.city)}${i.website ? ` · ${s(i.website)}` : ' · no website'}${i.rating ? ` · ★${s(i.rating)} (${s(i.reviewCount)})` : ''}`,
  sample: () => [
    { source: 'osm', name: 'SAMPLE Bakery Ltd', primaryCategory: 'bakery', address: '1 Example Street, Plymouth PL1 1AA', city: 'Plymouth', postcode: 'PL1 1AA', countryCode: 'GB', lat: 50.3712, lng: -4.1426, phone: '+44 1752 000000', website: 'https://bakery.example', domain: 'bakery.example', hasWebsite: true, osmUrl: 'https://www.openstreetmap.org/node/1', attribution: '© OpenStreetMap contributors', isSampleData: true },
    { source: 'osm', name: 'SAMPLE Café', primaryCategory: 'cafe', address: '2 Example Street, Plymouth PL1 1AB', city: 'Plymouth', postcode: 'PL1 1AB', countryCode: 'GB', lat: 50.3715, lng: -4.1431, phone: null, website: null, domain: null, hasWebsite: false, attribution: '© OpenStreetMap contributors', isSampleData: true },
  ],
  examples: ['Find 30 cafés in Plymouth city centre that have their own website.', 'List accountants in Bath without a website.'],
  costHint: 'Per business returned; Google Places calls are billed by Google to your own key.',
};

/* ---------------------------------------------------------------- company registries (3 tools) */
const registryShape = (i: Obj): Obj => {
  switch (i.recordType) {
    case 'company': return pick(i, ['recordType', 'name', 'cik', 'lei', 'tickers', 'country', 'status', 'jurisdiction', 'industry', 'addresses', 'directParent', 'ultimateParent', 'crossReference', 'links', 'isSampleData']);
    case 'filing': return pick(i, ['recordType', 'cik', 'companyName', 'form', 'filingDate', 'reportDate', 'items', 'accessionNumber', 'urls', 'isNew', 'matchedDocuments']);
    case 'financials': return pick(i, ['recordType', 'cik', 'fiscalYear', 'periodEnd', 'currency', 'revenue', 'netIncome', 'totalAssets', 'sharesOutstanding', 'annual']);
    default: return i;
  }
};
const registryLine = (i: Obj): string | null => {
  switch (i.recordType) {
    case 'company': return `${s(i.name)} — CIK ${s(i.cik) || 'n/a'}, LEI ${s(i.lei) || 'n/a'}, ${s(i.country)} (${s(i.status)})`;
    case 'filing': return `${s(i.filingDate)} ${s(i.form)} — ${s(i.companyName)}${i.isNew ? ' [NEW]' : ''}`;
    case 'financials': return `FY${s(i.fiscalYear)} (${s(i.cik)}): revenue ${money(i.revenue, i.currency)}, net income ${money(i.netIncome, i.currency)}`;
    case 'corporate-tree': return `Corporate tree ${s(i.lei)}: parent ${s(i.directParentName)}, ultimate ${s(i.ultimateParentName)}, ${s(i.directChildrenTotal)} children`;
    case 'monitor-check': return `Watch: ${s(i.company ?? i.input)} — ${s(i.newFilings ?? 0)} new filing(s)`;
    case 'error': return `Error for "${s(i.input)}": ${s(i.message)}`;
    default: return null;
  }
};
const REGISTRY_DISCLAIMER = 'Data as published by SEC EDGAR and GLEIF (cite the links); not legal or financial advice.';
const registrySample = (q: string): Obj[] => [
  { recordType: 'company', name: `SAMPLE ${q.toUpperCase()} INC`, cik: '0000000001', lei: '5493000SAMPLE0000001', tickers: ['SMPL'], country: 'US', status: 'ACTIVE', isSampleData: true },
  { recordType: 'filing', cik: '0000000001', companyName: `SAMPLE ${q.toUpperCase()} INC`, form: '8-K', filingDate: '2026-10-01', items: ['2.02'], accessionNumber: '0000000001-26-000001', urls: { index: 'https://www.sec.gov/' }, isSampleData: true },
  { recordType: 'financials', cik: '0000000001', fiscalYear: 2025, currency: 'USD', revenue: 1200000000, netIncome: 95000000, isSampleData: true },
];

export const companyRegistryLookup: DataToolSpec = {
  name: 'company_registry_lookup',
  title: 'Look up companies in SEC EDGAR and GLEIF',
  folder: 'company-registries',
  actor: 'siteverdict-company-registries',
  toolsets: ['leads', 'compliance'],
  annotations: READ_ONLY,
  runTimeoutSecs: 600,
  memoryMbytes: 1024,
  maxItems: 60,
  description:
    'Looks up companies in official open registries — US SEC EDGAR and the global GLEIF LEI index — by name, stock ticker, SEC CIK or LEI. Returns a normalised profile (identifiers, legal name, country, status, legal/HQ address, SIC industry, UK company number if any), the LEI-CIK link with confidence, the GLEIF corporate tree (direct/ultimate parent, subsidiaries), recent SEC filings with links, and key XBRL financials (revenue, net income, assets, equity, cash, shares) with fiscal periods and units. Use for KYB/due diligence, "who owns X", "what is X\'s revenue" or "latest 8-K of X". ' +
    REGISTRY_DISCLAIMER + ' ' + COST_NOTE,
  inputSchema: z.object({
    queries: strList(20).min(1).describe('Company names, tickers (AAPL), CIKs (320193) or LEIs. Prefix name:/ticker:/cik:/lei: to force the type.'),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(20).optional().describe('ISO country filter for name searches.'),
    sources: z.array(z.enum(['sec', 'gleif'])).min(1).default(['sec', 'gleif']),
    maxResultsPerName: z.number().int().min(1).max(10).default(3),
    includeFilings: z.boolean().default(true),
    filingForms: strList(20, 20).optional().describe('e.g. ["8-K","10-K","10-Q"]; empty = all forms.'),
    maxFilingsPerCompany: z.number().int().min(0).max(50).default(5),
    includeFinancials: z.boolean().default(true),
    financialYears: z.number().int().min(1).max(10).default(3),
    includeCorporateTree: z.boolean().default(true),
    maxChildren: z.number().int().min(0).max(200).default(10),
  }),
  buildInput: (a, ctx) => compactObj({ mode: 'lookup', ...a, secContactEmail: ctx.contactEmail, concurrency: 3 }),
  shape: registryShape,
  line: registryLine,
  disclaimer: REGISTRY_DISCLAIMER,
  sample: (a) => registrySample(String((a.queries as string[])[0] ?? 'acme')),
  examples: ['Who is the ultimate parent of LEI 549300G81RQKP7XW2N18?', "Give me Microsoft's revenue and net income for the last three fiscal years."],
  costHint: 'company $0.004, filing $0.001, financials $0.008 per record.',
};

export const secFilingWatch: DataToolSpec = {
  name: 'sec_filing_watch',
  title: 'Watch companies for new SEC filings',
  folder: 'company-registries',
  actor: 'siteverdict-company-registries',
  toolsets: ['leads'],
  annotations: STATEFUL,
  runTimeoutSecs: 600,
  memoryMbytes: 1024,
  maxItems: 60,
  description:
    'Returns SEC filings (8-K, 10-K, 10-Q, 20-F, 6-K, S-1...) filed by the given companies since the previous call with the same watchName. The first call stores a baseline (optionally returning the last lookbackDays). Saves a private watch state in the caller\'s Apify storage. Use for "anything new from X?". ' +
    REGISTRY_DISCLAIMER + ' ' + COST_NOTE,
  inputSchema: z.object({
    companies: strList(50, 50).min(1).describe('Tickers or CIKs, e.g. ["TSLA","320193"]'),
    forms: strList(20, 20).optional().describe('Form types to watch; empty = all.'),
    watchName: z.string().regex(/^[a-z0-9-]{1,40}$/).default('default'),
    lookbackDays: z.number().int().min(0).max(90).default(0),
  }),
  buildInput: (a, ctx) =>
    compactObj({ mode: 'monitor', queries: a.companies, monitorForms: a.forms, monitorStateName: ctx.stateName(String(a.watchName)), monitorLookbackDays: a.lookbackDays, secContactEmail: ctx.contactEmail, concurrency: 3 }),
  shape: registryShape,
  line: registryLine,
  disclaimer: REGISTRY_DISCLAIMER,
  sample: (a) => [{ ...registrySample(String((a.companies as string[])[0]))[1], isNew: true }, { recordType: 'monitor-check', company: (a.companies as string[])[0], newFilings: 1, isSampleData: true }],
  examples: ['Has Apple filed anything new with the SEC since yesterday?'],
  costHint: 'filing $0.001 per new filing.',
};

export const secFullTextSearch: DataToolSpec = {
  name: 'sec_full_text_search',
  title: 'Search the full text of SEC filings',
  folder: 'company-registries',
  actor: 'siteverdict-company-registries',
  toolsets: ['leads'],
  annotations: READ_ONLY,
  runTimeoutSecs: 600,
  memoryMbytes: 1024,
  maxItems: 50,
  description:
    'Searches the text of SEC filings since 2001 for a word or "exact phrase", optionally by form type, date range and company. Returns one record per matching filing with links to the matching documents. ' + REGISTRY_DISCLAIMER + ' ' + COST_NOTE,
  inputSchema: z.object({
    query: str(300).describe('Word or "exact phrase", e.g. "going concern" aviation'),
    forms: strList(20, 20).optional(),
    from: isoDate().optional(),
    to: isoDate().optional(),
    companies: strList(20, 50).optional(),
    maxResults: z.number().int().min(1).max(500).default(50),
  }),
  buildInput: (a, ctx) =>
    compactObj({ mode: 'full-text-search', fullTextQuery: a.query, fullTextForms: a.forms, fullTextStartDate: a.from, fullTextEndDate: a.to, queries: a.companies, maxFullTextResults: a.maxResults, secContactEmail: ctx.contactEmail }),
  shape: registryShape,
  line: registryLine,
  disclaimer: REGISTRY_DISCLAIMER,
  sample: () => [{ ...registrySample('acme')[1], form: '10-K', matchedDocuments: [{ url: 'https://www.sec.gov/', snippet: 'SAMPLE: substantial doubt about … going concern' }] }],
  examples: ["Which 10-K filings this year mention 'going concern' and 'aviation'?"],
  costHint: 'filing $0.001 per match.',
};

/* ---------------------------------------------------------------- find_public_tenders */
export const findPublicTenders: DataToolSpec = {
  name: 'find_public_tenders',
  title: 'Search UK and EU public tenders and contract awards',
  folder: 'public-tenders',
  actor: 'siteverdict-public-tenders',
  toolsets: ['leads'],
  annotations: READ_ONLY,
  runTimeoutSecs: 900,
  memoryMbytes: 1024,
  maxItems: 50,
  description:
    'Searches official UK and EU public-sector procurement notices — tenders, planned procurements, contract awards and changes — from Find a Tender (Procurement Act 2023), Contracts Finder, Public Contracts Scotland, Sell2Wales and EU TED. Filter by keywords, CPV codes (or plain-English terms converted to CPV), buyer, UK region/NUTS/postcode, EU country, value range, notice type, open-now / closing-within-N-days and publication dates. Returns title, buyer, value, CPV, location, deadline, documents, notice URL, lots and award winners (organisations). mode "closingSoon" = deadlines in the next N days; noticeTypes ["award"] = who won what. Data is OGL / EU-reuse licensed: cite noticeUrl and attribution. Contact details of individuals are never returned. Not legal or procurement advice. For interactive use prefer sources ["fts"] and tight filters (multi-source searches can take minutes). ' +
    COST_NOTE,
  inputSchema: z.object({
    keywords: strList(20).optional(),
    keywordMatch: z.enum(['any', 'all']).default('any'),
    excludeKeywords: strList(20).optional(),
    cpvCodes: z.array(z.string().regex(/^\d{2,8}(-\d)?$/)).max(30).optional().describe('CPV codes; prefix match ("72" = all IT services).'),
    cpvKeywords: strList(20).optional().describe('Plain-English terms converted to CPV codes (e.g. "cleaning", "website").'),
    buyers: strList(20).optional(),
    regions: strList(20, 50).optional().describe('UK region names or NUTS/ITL codes (London, Scotland, UKI3, TLM, DE1).'),
    postcodes: strList(20, 10).optional(),
    tedCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(30).optional(),
    minValue: z.number().int().min(0).optional(),
    maxValue: z.number().int().min(0).optional(),
    noticeTypes: z.array(z.enum(['planning', 'tender', 'award', 'contract'])).min(1).default(['tender']),
    openOnly: z.boolean().default(false),
    closingWithinDays: z.number().int().min(1).max(365).optional(),
    mode: z.enum(['search', 'closingSoon']).default('search'),
    lookbackDays: z.number().int().min(1).max(365).default(7),
    publishedFrom: isoDate().optional(),
    publishedTo: isoDate().optional(),
    sources: z.array(z.enum(['fts', 'contractsFinder', 'scotland', 'wales', 'ted'])).min(1).default(['fts', 'contractsFinder', 'scotland', 'ted']),
    sortBy: z.enum(['publishedDate', 'deadline', 'relevance', 'value']).default('publishedDate'),
    maxResults: z.number().int().min(1).max(200).default(25),
  }),
  buildInput: (a) => compactObj({ ...a, includeContactDetails: false, maxDescriptionChars: 600, includeLots: true }),
  shape: (i) => ({ ...pick(i, ['uid', 'sourceName', 'noticeType', 'title', 'headline', 'buyer', 'value', 'cpv', 'location', 'procedure', 'publishedDate', 'deadline', 'daysUntilDeadline', 'isOpen', 'noticeUrl', 'awards', 'attribution', 'isSampleData']), description: clip(i.description, 600) }),
  line: (i) => `${s(i.title)} — ${s((i.buyer as Obj | undefined)?.name)}${(i.value as Obj | undefined)?.amount ? `, ${money((i.value as Obj).amount, (i.value as Obj).currency)}` : ''}${i.deadline ? `, deadline ${s(i.deadline).slice(0, 10)}` : ''} ${s(i.noticeUrl)}`,
  disclaimer: 'Contains public sector information licensed under the Open Government Licence v3.0 and EU TED data (© European Union). Not legal or procurement advice.',
  sample: () => [
    { uid: 'fts-SAMPLE-1', sourceName: 'Find a Tender', noticeType: 'tender', title: 'SAMPLE: Website redesign and hosting', buyer: { name: 'Example City Council' }, value: { amount: 85000, currency: 'GBP' }, cpv: [{ code: '72413000', label: 'World wide web (www) site design services' }], publishedDate: '2026-10-08', deadline: '2026-10-30T12:00:00Z', daysUntilDeadline: 19, isOpen: true, noticeUrl: 'https://www.find-tender.service.gov.uk/', attribution: 'OGL v3.0', isSampleData: true },
  ],
  examples: ['Find open UK tenders for website design under £100k closing in the next three weeks.', 'Which NHS trusts awarded cleaning contracts since July, and who won?'],
  costHint: 'Per notice returned (cap maxResults).',
};
