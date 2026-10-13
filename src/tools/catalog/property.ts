import * as z from 'zod/v4';
import { COST_NOTE, READ_ONLY, compactObj, isoDate, s, str } from '../helpers.js';
import type { DataToolSpec, Obj } from '../types.js';

const PROPERTY_DISCLAIMER =
  'Not valuation, legal or financial advice. "No planning constraint found" is not a guarantee — confirm with the local planning authority. Sold prices cover England & Wales only. Contains HM Land Registry data © Crown copyright and database right (OGL v3.0).';

export const ukPropertyData: DataToolSpec = {
  name: 'uk_property_data',
  title: 'UK sold prices, house price index and planning constraints',
  folder: 'uk-property-data',
  actor: 'siteverdict-uk-property-data',
  toolsets: ['property'],
  annotations: READ_ONLY,
  runTimeoutSecs: 900,
  memoryMbytes: 1024,
  maxItems: 60,
  secrets: [{ name: 'EPC_API_TOKEN', label: 'EPC API bearer token', help: 'From get-energy-performance-data.communities.gov.uk (your own account).' }],
  description:
    'Official UK property data for a postcode, outcode, street, town/district/county or map point: HM Land Registry Price Paid sold prices (England & Wales) with price, date, address, type, tenure and new-build flag; a free summary per search (median/mean/quartiles, splits by type/tenure/new-build, monthly trend, local UK House Price Index context); planning constraints (England) for a full postcode or point — conservation area, listed buildings within a radius, Article 4, flood zone 2/3, tree preservation, green belt, AONB/National Landscape, World Heritage Site; and optional EPC certificates when the user\'s own EPC token is configured and a permitted purpose is given (EPC address data may only be used for energy-efficiency purposes). Prefer summaryOnly:true for "what do houses sell for in X" (cheaper). Report coverage dates and notes. Never use it to profile or contact individual homeowners (the data has no owner names). ' +
    PROPERTY_DISCLAIMER + ' ' + COST_NOTE,
  inputSchema: z.object({
    searches: z.array(str(120)).min(1).max(20).describe("Postcode 'PL4 7LG', sector 'PL4 7', outcode 'PL4', 'Street, Town', 'town:NAME' / 'district:NAME' / 'county:NAME', or 'point:lat,lng'."),
    dateFrom: isoDate().optional().describe('Default: 2 years ago'),
    dateTo: isoDate().optional().describe('Default: yesterday'),
    propertyTypes: z.array(z.enum(['D', 'S', 'T', 'F', 'O'])).max(5).optional().describe('D detached, S semi, T terraced, F flat, O other'),
    tenure: z.array(z.enum(['F', 'L'])).max(2).optional(),
    newBuild: z.enum(['any', 'new', 'established']).default('any'),
    minPrice: z.number().int().min(0).optional(),
    maxPrice: z.number().int().min(0).optional(),
    maxTransactionsPerSearch: z.number().int().min(1).max(2000).default(100),
    summaryOnly: z.boolean().default(false).describe('Only summaries (free) and planning checks; no individual sales.'),
    includePlanning: z.boolean().default(true),
    planningRadiusMetres: z.number().int().min(0).max(1000).default(50),
    includeEpc: z.boolean().default(false),
    epcPurpose: z.enum(['property-management-energy-efficiency', 'energy-efficiency-research', 'improvement-impact-research', 'government-scheme-promotion', 'sale-rental-market-energy-information', 'enforcement', 'building-control', 'crime-prevention-legal-proceedings', 'non-commercial-research-private-study']).optional(),
  }),
  buildInput: (a, ctx) => {
    const token = ctx.secrets.EPC_API_TOKEN;
    let includeEpc = Boolean(a.includeEpc);
    if (includeEpc && (!token || !a.epcPurpose)) {
      includeEpc = false;
      ctx.notes.push(!token ? 'EPC data skipped: no EPC token configured for this user (SITEVERDICT_SECRET_EPC_API_TOKEN).' : 'EPC data skipped: epcPurpose is required.');
    }
    const { summaryOnly, includeEpc: _i, ...rest } = a;
    return compactObj({ ...rest, outputTransactions: !summaryOnly, includeEpc, epcToken: includeEpc ? token : undefined, epcPurpose: includeEpc ? a.epcPurpose : undefined });
  },
  shape: (i) => {
    if (i.recordType === 'summary') {
      const out = { ...i };
      const hpi = i.hpi as Obj | null | undefined;
      if (hpi && Array.isArray(hpi.series)) out.hpi = { ...hpi, series: (hpi.series as unknown[]).slice(-12) };
      if (Array.isArray(i.monthlyTrend)) out.monthlyTrend = (i.monthlyTrend as unknown[]).slice(-24);
      return out;
    }
    return i;
  },
  sort: (a, b) => (b.recordType === 'summary' ? 1 : 0) - (a.recordType === 'summary' ? 1 : 0),
  line: (i) => {
    switch (i.recordType) {
      case 'summary': {
        const ps = (i.priceStats as Obj | undefined) ?? {};
        return `${s(i.search)}: ${s(ps.count)} sales, median £${Number(ps.median ?? 0).toLocaleString('en-GB')}${(i.hpi as Obj | null)?.annualChangePct !== undefined ? `, HPI ${s((i.hpi as Obj).annualChangePct)}% y/y` : ''}`;
      }
      case 'transaction': return `${s(i.date)} £${Number(i.price ?? 0).toLocaleString('en-GB')} ${s(i.propertyTypeLabel || i.propertyType)} ${s(i.tenure)} — ${s(i.address)}`;
      case 'planning-check': return `Planning ${s(i.lat)},${s(i.lng)}: conservation ${i.inConservationArea ? 'YES' : 'no'}, flood zone ${s(i.floodZone) || 'none found'}, listed within ${s(i.radiusMetres)}m: ${s(i.listedBuildingsWithinRadius)}, green belt ${i.greenBelt ? 'YES' : 'no'}`;
      case 'epc': return `EPC ${s(i.address)}: ${s(i.currentBand)} (potential ${s(i.potentialBand)})`;
      case 'error': return `Error for ${s(i.search)}: ${s(i.message)}`;
      default: return null;
    }
  },
  disclaimer: PROPERTY_DISCLAIMER,
  sample: (a) =>
    (a.searches as string[]).slice(0, 3).flatMap((q) => [
      { recordType: 'summary', search: q, searchType: 'outcode', coverage: { dateFrom: '2024-10-11', dateTo: '2026-10-10', truncated: false, transactionsFetched: 214 }, priceStats: { count: 214, median: 235000, mean: 251300, min: 82000, max: 690000, p25: 180000, p75: 300000 }, hpi: { region: 'Plymouth', latestMonth: '2026-07', averagePrice: 228000, annualChangePct: 2.4 }, notes: ['SAMPLE DATA'], disclaimer: PROPERTY_DISCLAIMER, isSampleData: true },
      ...(a.summaryOnly ? [] : [{ recordType: 'transaction', search: q, transactionId: 'SAMPLE-1', price: 245000, date: '2026-08-29', address: '1 SAMPLE ROAD, PLYMOUTH', postcode: 'PL4 7AA', propertyType: 'T', propertyTypeLabel: 'Terraced', tenure: 'freehold', newBuild: false, isSampleData: true }]),
    ]),
  examples: ['What have terraced houses sold for in PL4 over the last 12 months, and how does that compare with the Plymouth HPI?', 'Check flood zone and green belt for postcode GL20 5AA.'],
  costHint: 'transaction $0.002, planning-check $0.01, epc-record $0.004; summaries free.',
};
