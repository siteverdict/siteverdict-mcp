import * as z from 'zod/v4';
import { UserInputError } from '../../lib/errors.js';
import { COST_NOTE, READ_ONLY, compactObj, isoDate, money, pick, s, str, strList } from '../helpers.js';
import type { DataToolSpec, Obj } from '../types.js';

/* ---------------------------------------------------------------- check_flight_compensation */
const COMP_DISCLAIMER = 'Rules-based guidance, not legal advice. It cannot verify the airline\'s stated cause ("extraordinary circumstances") and never presents that classification as fact.';
const claimSchema = z.object({
  reference: str(100).optional(),
  flightNumber: str(10).optional().describe('e.g. BA117, U2 8123 (only used with a flight-data provider key)'),
  date: isoDate().optional().describe('Local departure date'),
  departureAirport: z.string().regex(/^[A-Za-z]{3,4}$/).optional().describe('IATA (LHR) or ICAO (EGLL)'),
  arrivalAirport: z.string().regex(/^[A-Za-z]{3,4}$/).optional(),
  operatingCarrier: z.string().regex(/^[A-Za-z0-9]{2,3}$/).optional().describe('IATA or (better) ICAO code of the OPERATING airline, e.g. EZY, BAW'),
  carrierLicence: z.enum(['UK', 'EU', 'EEA_CH', 'OTHER']).optional(),
  disruption: z.enum(['auto', 'delay', 'cancellation', 'denied_boarding', 'diversion']).optional(),
  arrivalDelayMinutes: z.number().min(0).max(100000).optional(),
  scheduledArrival: str(30).optional().describe('Local time at arrival airport, e.g. 2026-09-14T13:05'),
  actualArrival: str(30).optional(),
  scheduledDeparture: str(30).optional(),
  actualDeparture: str(30).optional(),
  journeyOrigin: str(4).optional(),
  finalDestination: str(4).optional(),
  finalArrivalDelayMinutes: z.number().min(0).optional(),
  cancellationNoticeDays: z.number().min(0).optional(),
  rerouteOffered: z.boolean().optional(),
  rerouteDepartedMinutesEarly: z.number().min(0).optional(),
  rerouteArrivalDelayMinutes: z.number().min(0).optional(),
  deniedBoardingVoluntary: z.boolean().optional(),
  deniedBoardingReason: z.enum(['overbooking', 'operational', 'health', 'safety', 'security', 'travel_documents', 'unknown']).optional(),
  airlineReason: z.enum(['unknown', 'none_given', 'weather', 'atc_restriction', 'security', 'political_instability', 'bird_strike', 'volcanic_ash', 'strike_third_party', 'strike_own_staff', 'technical_fault', 'hidden_manufacturing_defect', 'runway_debris_damage', 'airport_equipment_collision', 'disruptive_passenger', 'medical_emergency', 'crew_sudden_illness_or_death', 'crew_shortage', 'knock_on_previous_flight', 'airport_fuel_supply_failure', 'overbooking', 'other']).optional(),
  passengers: z.number().int().min(1).max(50).optional(),
  jurisdiction: z.enum(['england-wales', 'scotland', 'northern-ireland', 'eu-de', 'eu-fr', 'eu-ie', 'eu-es', 'eu-other']).optional(),
  checkedInOnTime: z.boolean().default(true),
  freeOrNonPublicFare: z.boolean().default(false),
  alreadyCompensatedElsewhere: z.boolean().default(false),
});

export const checkFlightCompensation: DataToolSpec = {
  name: 'check_flight_compensation',
  title: 'Check UK261 / EU261 flight delay compensation',
  folder: 'flight-compensation',
  actor: 'siteverdict-flight-compensation',
  toolsets: ['travel'],
  annotations: READ_ONLY,
  runTimeoutSecs: 300,
  memoryMbytes: 512,
  maxItems: 50,
  secrets: [{ name: 'FLIGHT_DATA_API_KEY', label: 'Flight-data provider key (AeroDataBox, FlightAware AeroAPI, Aviationstack or OAG)', help: "The user's own provider key; only needed to look up times by flight number." }],
  description:
    'Decides whether a disrupted flight is owed fixed compensation under UK261 (UK) or EU261 (EU/EEA/Switzerland). Give airports, the operating airline and the arrival delay, the cancellation notice or the denied-boarding facts (provider "none", default). Or give a flight number and date with provider set to the user\'s flight-data service (their own key must be configured on the server) to look up the times. Returns yes/no/maybe, the amount (GBP £220/£350/£520 or EUR €250/€400/€600, incl. 50% reductions), the regime to claim under, reasons with cited articles and court cases, right to care, the claim deadline and links to the airline claim page and CAA/ADR guidance. Relay headline and reasons; on "maybe" ask for what the reasons say is missing. Use ICAO airline codes (EZY, BAW) when an IATA code is shared. Never scrapes websites. ' +
    COMP_DISCLAIMER + ' ' + COST_NOTE,
  inputSchema: z.object({
    claims: z.array(claimSchema).min(1).max(50),
    provider: z.enum(['none', 'aerodatabox', 'aeroapi', 'aviationstack', 'oag']).default('none').describe('"none" = use the facts given. Other values need the user\'s provider key configured on the server.'),
    aerodataboxGateway: z.enum(['rapidapi', 'apimarket', 'direct']).default('rapidapi'),
  }),
  buildInput: (a, ctx) => {
    const key = ctx.secrets.FLIGHT_DATA_API_KEY;
    if (a.provider !== 'none' && !key) {
      throw new UserInputError(`provider "${String(a.provider)}" needs your own flight-data API key configured on the server (SITEVERDICT_SECRET_FLIGHT_DATA_API_KEY). Or call again with provider "none" and the delay facts.`);
    }
    return compactObj({ claims: a.claims, provider: a.provider, aerodataboxGateway: a.provider === 'aerodatabox' ? a.aerodataboxGateway : undefined, apiKey: a.provider !== 'none' ? key : undefined });
  },
  shape: (i) => pick(i, ['reference', 'eligible', 'headline', 'primaryRegime', 'amountPerPassenger', 'currency', 'totalAmount', 'reducedBy50', 'amountIfAirlineReduces', 'distanceKm', 'arrivalDelayMinutes', 'arrivalDelayBasis', 'reasons', 'warnings', 'extraordinaryCircumstances', 'rightToCare', 'claimTimeLimit', 'links', 'citations', 'flight', 'error', 'disclaimer', 'isSampleData']),
  line: (i) => `${i.reference ? `${s(i.reference)}: ` : ''}${s(i.eligible).toUpperCase()} — ${s(i.headline)}${i.totalAmount ? ` (${money(i.totalAmount, i.currency)})` : ''}`,
  disclaimer: COMP_DISCLAIMER,
  sample: (a) =>
    (a.claims as Obj[]).slice(0, 5).map((c, idx) => ({
      reference: c.reference ?? `claim-${idx + 1}`, eligible: 'yes', headline: 'SAMPLE DATA: Likely owed £350 per passenger under UK261 (arrival delay 3h25, 1,500–3,500 km).',
      primaryRegime: 'UK261', amountPerPassenger: 350, currency: 'GBP', totalAmount: 350 * Number(c.passengers ?? 1), reducedBy50: 'no', distanceKm: 1720,
      reasons: ['Arrival delay of 3 hours or more (Sturgeon, C-402/07)', 'Departure from a UK airport (UK261 Art. 3(1)(a))'],
      claimTimeLimit: { label: 'England & Wales: 6 years', deadline: '2032-09-14', status: 'open' }, disclaimer: COMP_DISCLAIMER, isSampleData: true,
    })),
  examples: ['My easyJet flight from Gatwick to Faro on 14 Sept landed at 13:15 instead of 09:50. Two of us were on it. Are we owed anything?', 'Ryanair cancelled my Stansted–Barcelona flight 3 days before. What can I claim?'],
  costHint: 'Per claim assessed.',
};

/* ---------------------------------------------------------------- flight_deal_alerts */
const DEAL_SOURCES = ['fly4free', 'travel-dealz', 'theflightdeal', 'holidaypirates', 'headforpoints', 'turningleftforless', 'livefromalounge', 'et-travelworld'];
export const flightDealAlerts: DataToolSpec = {
  name: 'flight_deal_alerts',
  title: 'Find current flight deals and error fares from public deal feeds',
  folder: 'flight-deal-alerts',
  actor: 'siteverdict-flight-deal-alerts',
  toolsets: ['travel'],
  annotations: READ_ONLY,
  runTimeoutSecs: 300,
  memoryMbytes: 512,
  maxItems: 40,
  description:
    'Finds current cheap flight deals and mistake (error) fares from public deal-site feeds (Fly4free, The Flight Deal, Travel-Dealz, HolidayPirates, Head for Points, Turning Left for Less, Live from a Lounge, ET TravelWorld, optionally Secret Flying). Filter by departure airports, cities or countries (LON, MAN, DEL, "India"), destinations or regions, cabin and max price. Each deal has the route, posted price and currency, cabin, trip type, sample dates/months when stated, an error-fare flag, a 0-100 plausibility score and a link to the original post with the publisher credited; duplicates across sites are merged. Prices are as posted and may have expired: always tell the user to open the original post and check before booking. Show the summary, the link and the source name; do not reproduce article text. ' +
    COST_NOTE,
  inputSchema: z.object({
    origins: strList(20, 60).optional().describe('Departure IATA city/airport codes, city or country names, ISO country codes. Empty = anywhere.'),
    destinations: strList(20, 60).optional(),
    destinationRegions: z.array(z.enum(['uk', 'europe', 'n_africa', 'middle_east', 'south_asia', 'se_asia', 'east_asia', 'oceania', 'africa', 'n_america', 'caribbean', 'latam', 'central_asia', 'indian_ocean'])).max(14).optional(),
    cabins: z.array(z.enum(['economy', 'premium_economy', 'business', 'first'])).max(4).optional(),
    maxPrice: z.number().int().min(1).optional(),
    currency: z.enum(['GBP', 'EUR', 'USD', 'INR', 'CAD', 'AUD', 'AED', 'SGD']).default('GBP'),
    errorFaresOnly: z.boolean().default(false),
    minScore: z.number().int().min(0).max(100).default(0),
    maxAgeDays: z.number().int().min(1).max(60).default(7),
    maxDeals: z.number().int().min(1).max(100).default(20),
    includeSecretFlying: z.boolean().default(false).describe('Adds Secret Flying to the default sources.'),
  }),
  buildInput: (a) =>
    compactObj({ ...pick(a, ['origins', 'destinations', 'destinationRegions', 'cabins', 'maxPrice', 'currency', 'errorFaresOnly', 'minScore', 'maxAgeDays', 'maxDeals']), mode: 'latest', sources: a.includeSecretFlying ? [...DEAL_SOURCES, 'secretflying'] : undefined }),
  shape: (i) => pick(i, ['id', 'headline', 'summary', 'url', 'source', 'attribution', 'alsoReportedBy', 'route', 'cabin', 'tripType', 'price', 'priceApprox', 'priceSignal', 'travelDates', 'airline', 'isErrorFare', 'score', 'scoreLabel', 'publishedAt', 'disclaimer', 'isSampleData']),
  line: (i) => `${s(i.route)} ${s(i.cabin)} ${i.price ? money((i.price as Obj).amount, (i.price as Obj).currency) : ''}${i.isErrorFare ? ' [error fare]' : ''} — ${s(i.summary)} (${s((i.source as Obj | undefined)?.name)}: ${s(i.url)})`,
  disclaimer: 'Prices are as posted by the publisher and may have expired; check the original post before booking. Deals are credited to their publishers.',
  sample: () => [
    { id: 'sample-1', headline: 'SAMPLE: London to Bangkok from £389 return', summary: 'SAMPLE DATA: return fares LON–BKK around £389 in economy for January dates.', url: 'https://example.com/deal', source: { id: 'sample', name: 'Sample Deals Blog', homepage: 'https://example.com' }, route: 'LON → BKK', cabin: 'economy', tripType: 'return', price: { amount: 389, currency: 'GBP' }, priceSignal: 'good', isErrorFare: false, score: 72, scoreLabel: 'high', publishedAt: new Date().toISOString(), isSampleData: true },
  ],
  examples: ['Any cheap flights from London or Manchester to Asia this week under £500?', 'Are there any mistake fares right now?'],
  costHint: 'One deal event per deal returned (keep maxDeals modest).',
};

/* ---------------------------------------------------------------- flight fare intelligence (scan + estimate) */
const FARE_DISCLAIMER = 'Search only — no booking. Calendar prices are cached (up to ~7 days old); live offers can change within minutes, so re-check before buying. Not financial advice.';
const fareInput = z.object({
  routes: z.array(z.string().regex(/^[A-Za-z]{3}-[A-Za-z]{3}$/)).min(1).max(10).describe('IATA airport or city pairs, e.g. LHR-JFK, LON-BKK.'),
  tripType: z.enum(['return', 'one-way']).default('return'),
  startMonth: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('First departure month (YYYY-MM); default next month.'),
  monthsAhead: z.number().int().min(1).max(12).default(3),
  cabins: z.array(z.enum(['economy', 'premium_economy', 'business', 'first'])).min(1).default(['economy']),
  exactDates: strList(10, 40).optional().describe('Live searches: "LHR-JFK 2026-12-10 2026-12-17" or "LHR-JFK 2026-12-10".'),
  liveCheckCheapestDates: z.boolean().default(true).describe('Confirm the cheapest calendar dates with live offers (needs the user\'s Duffel token).'),
  maxLiveSearches: z.number().int().min(0).max(20).default(5),
  directOnly: z.boolean().default(false),
  currency: z.string().regex(/^[A-Z]{3}$/).default('GBP'),
});
const FARE_SECRETS = [
  { name: 'TRAVELPAYOUTS_TOKEN', label: 'Travelpayouts API token', help: "The user's OWN Travelpayouts Data API token (never the operator's)." },
  { name: 'DUFFEL_ACCESS_TOKEN', label: 'Duffel access token', help: "The user's OWN Duffel token for live offers." },
];
function fareBuild(a: Obj, ctx: Parameters<DataToolSpec['buildInput']>[1], estimate: boolean): Obj {
  const tp = ctx.secrets.TRAVELPAYOUTS_TOKEN;
  const duffel = ctx.secrets.DUFFEL_ACCESS_TOKEN;
  const sample = !tp && !duffel;
  if (sample && !estimate) ctx.notes.push('No Travelpayouts/Duffel token configured for this user: the Actor returns SAMPLE fares (isSampleData true). The operator\'s keys are never used.');
  return compactObj({
    ...pick(a, ['routes', 'tripType', 'startMonth', 'monthsAhead', 'cabins', 'directOnly', 'currency']),
    duffelExactDates: a.exactDates,
    duffelMode: a.liveCheckCheapestDates && duffel ? 'verify-cheapest-dates' : 'off',
    maxDuffelOfferRequests: a.maxLiveSearches,
    travelpayoutsToken: tp,
    duffelAccessToken: duffel,
    executionMode: estimate ? 'estimate' : sample ? 'sample' : 'auto',
    saveHistory: false,
    maxOffersPerRequest: 3,
    maxTravelpayoutsCalls: 60,
    maxAlerts: 10,
    survivalRecheck: false,
  });
}
const fareShape = (i: Obj): Obj => {
  if (i.recordType === 'route-month' && Array.isArray(i.calendar)) {
    const cal = [...(i.calendar as Obj[])].sort((x, y) => Number(x.price) - Number(y.price)).slice(0, 5);
    return { ...i, calendar: cal, calendarTrimmedTo: 5 };
  }
  return i;
};
const fareLine = (i: Obj): string | null => {
  switch (i.recordType) {
    case 'route-month': return `${s(i.route)} ${s(i.month)}: cheapest ${money(i.cheapestPrice, i.currency)} on ${s(i.cheapestDate)}${i.pctVsBaseline !== null && i.pctVsBaseline !== undefined ? ` (${s(i.pctVsBaseline)}% vs usual)` : ''}`;
    case 'offer': return `Offer ${s(i.route)} ${s(i.depart)}${i.return ? `→${s(i.return)}` : ''} ${s(i.cabinRequested)}: ${money(i.pricePerAdult, i.currency)} pp (${s(i.airlineName || i.airline)})`;
    case 'anomaly': return `${s(i.strength)} anomaly ${s(i.route)} ${s(i.cabin)}: ${money(i.price, i.currency)} — ${s(i.why)}`;
    case 'estimate': return `Estimate: max ${s((i.costUsd as Obj | undefined)?.max)} USD; Travelpayouts calls ${s((i.travelpayouts as Obj | undefined)?.calls)}, live searches ${s((i.duffel as Obj | undefined)?.offerRequests)}`;
    case 'error': return `Error (${s(i.stage)}): ${s(i.message)}`;
    default: return null;
  }
};

export const flightFareScan: DataToolSpec = {
  name: 'flight_fare_scan',
  title: 'Scan flight prices and spot unusually cheap fares',
  folder: 'flight-fare-intelligence',
  actor: 'siteverdict-flight-fare-intelligence',
  toolsets: ['travel'],
  annotations: READ_ONLY,
  runTimeoutSecs: 900,
  memoryMbytes: 1024,
  maxItems: 60,
  secrets: FARE_SECRETS,
  description:
    'Scans flight prices for one or more routes over the coming months: per route and departure month the cheapest fare, the cheapest departure dates (top 5 calendar days) and how the price compares with the route\'s usual level. With the user\'s own Duffel token it also returns live airline offers in any cabin for the cheapest dates or exact dates, and flags unusually cheap fares (30%+ below normal, STRONG at 45%, or business at <=1.3x economy). Uses the END USER\'s own Travelpayouts/Duffel tokens configured on the server; without them the Actor returns clearly labelled SAMPLE data. Use flight_fare_estimate first for large scans. ' +
    FARE_DISCLAIMER + ' ' + COST_NOTE,
  inputSchema: fareInput,
  buildInput: (a, ctx) => fareBuild(a, ctx, false),
  shape: fareShape,
  line: fareLine,
  disclaimer: FARE_DISCLAIMER,
  sample: (a) =>
    (a.routes as string[]).slice(0, 3).map((r) => ({ recordType: 'route-month', route: r.toUpperCase(), month: '2026-11', trip: 'rt', currency: 'GBP', cheapestPrice: 412, cheapestDate: '2026-11-12', cheapestReturn: '2026-11-19', cheapestAirline: 'XX', calendarMedian: 520, baselineMedian: 560, pctVsBaseline: -26, calendar: [{ date: '2026-11-12', price: 412 }, { date: '2026-11-13', price: 431 }], isSampleData: true })),
  examples: ['When is the cheapest week to fly London to Bangkok between January and April?', 'Scan MAN-DXB and LHR-SIN for the next 6 months and flag anything unusually cheap.'],
  costHint: 'route-scan per route-month, offer per live offer, alert per anomaly.',
};

export const flightFareEstimate: DataToolSpec = {
  name: 'flight_fare_estimate',
  title: 'Estimate the cost of a flight fare scan (no searches)',
  folder: 'flight-fare-intelligence',
  actor: 'siteverdict-flight-fare-intelligence',
  toolsets: ['travel'],
  annotations: { ...READ_ONLY, idempotentHint: true },
  runTimeoutSecs: 120,
  memoryMbytes: 256,
  maxItems: 5,
  secrets: FARE_SECRETS,
  description:
    'Before a flight_fare_scan, shows how many API calls and live searches it would make and the maximum charge. No fare searches are made. Same input as flight_fare_scan. ' + COST_NOTE,
  inputSchema: fareInput,
  buildInput: (a, ctx) => fareBuild(a, ctx, true),
  line: fareLine,
  sample: (a) => [{ recordType: 'estimate', travelpayouts: { calls: (a.routes as string[]).length * Number(a.monthsAhead ?? 3), cap: 60 }, duffel: { offerRequests: Number(a.maxLiveSearches ?? 5), cap: 20, note: 'needs your Duffel token' }, costUsd: { max: 0.42 }, warnings: [], isSampleData: true }],
  examples: ['How much would scanning 10 routes for 12 months with live checks cost?'],
  costHint: 'Estimate only.',
};

/* ---------------------------------------------------------------- visa_entry_check */
const VISA_DISCLAIMER = 'Not immigration advice: always confirm with the official source and the airline before travelling.';
export const visaEntryCheck: DataToolSpec = {
  name: 'visa_entry_check',
  title: 'Check visa and entry requirements from official sources',
  folder: 'visa-entry-requirements',
  actor: 'siteverdict-visa-entry-requirements',
  toolsets: ['travel'],
  annotations: READ_ONLY,
  runTimeoutSecs: 600,
  memoryMbytes: 1024,
  maxItems: 60,
  description:
    'Checks whether a traveller needs a visa, eVisa, visa on arrival or an electronic travel authorisation (ETA/eTA/ESTA/ETIAS-type) to enter a country, using only official government sources. Covers British citizens for ~226 destinations (GOV.UK FCDO) and any nationality for the UK, the 30 countries applying the EU visa list (Schengen + Cyprus), Canada, Australia and India. Returns the requirement category, maximum stay, what to apply for with the official link, passport-validity/transit/health notes, the official source URL with fetched date and content hash, and a confidence level. Returns category "unknown" when no official source covers the pair (tell the user to check the embassy — never fill the gap from memory). Give either checks (pairs) or trip (travellers + itinerary with transit stops). Quote summary and the source link. ' +
    VISA_DISCLAIMER + ' ' + COST_NOTE,
  inputSchema: z.object({
    checks: z
      .array(
        z.object({
          nationality: str(60).describe('Passport nationality: country name, demonym or ISO alpha-2 ("India", "Indian", "IN"). "GB" = British citizen; "GB-BNO" = British National (Overseas).'),
          destination: str(60).describe('Destination country name or ISO alpha-2.'),
          purpose: z.enum(['tourism', 'business', 'family', 'transit', 'study', 'work']).default('tourism'),
          durationDays: z.number().int().min(1).max(3650).optional(),
        }),
      )
      .max(50)
      .optional(),
    trip: z
      .object({
        startDate: isoDate().optional(),
        purpose: z.enum(['tourism', 'business', 'family', 'study', 'work']).optional(),
        travellers: z.array(z.object({ name: str(60).optional().describe('Optional label, e.g. "Traveller 1"'), nationality: str(60), passportExpiry: isoDate().optional() })).min(1).max(10),
        itinerary: z.array(z.object({ country: str(60), role: z.enum(['destination', 'transit']).default('destination'), days: z.number().int().min(0).max(3650).optional() })).min(1).max(15),
      })
      .optional()
      .describe('Alternative to checks: per-traveller checklist for an itinerary.'),
  }),
  async validate(args) {
    if (!args.checks && !args.trip) throw new UserInputError('Give either "checks" (nationality + destination pairs) or "trip" (travellers + itinerary).');
    return args;
  },
  buildInput: (a) => (a.trip ? { mode: 'trip', trip: a.trip, includeOfficialText: false } : { mode: 'check', checks: a.checks, includeOfficialText: false }),
  shape: (i) => pick(i, ['type', 'nationality', 'destination', 'role', 'purpose', 'category', 'categoryLabel', 'summary', 'maxStayDays', 'stayRule', 'exceedsMaxStay', 'purposeCovered', 'authorisation', 'conditions', 'notes', 'passportValidity', 'transit', 'health', 'confidence', 'sources', 'disclaimer', 'traveller', 'status', 'actions', 'warnings', 'legs', 'schengenDaysPlanned', 'isSampleData']),
  line: (i) => (i.type === 'trip-checklist' ? `${s(i.traveller || i.nationality)}: ${s(i.status)} — ${(Array.isArray(i.actions) ? (i.actions as string[]) : []).join('; ')}` : `${s(i.nationality)} → ${s(i.destination)}: ${s(i.categoryLabel || i.category)} (${s(i.confidence)}) — ${s(i.summary)}`),
  disclaimer: VISA_DISCLAIMER,
  sample: (a) =>
    ((a.checks as Obj[] | undefined) ?? [{ nationality: 'IN', destination: 'GB' }]).slice(0, 5).map((c) => ({
      type: 'answer', nationality: c.nationality, destination: c.destination, role: 'destination', purpose: c.purpose ?? 'tourism', category: 'visa_required', categoryLabel: 'Visa required',
      summary: 'SAMPLE DATA: a Standard Visitor visa is required (source: GOV.UK, fetched 2026-10-11).', maxStayDays: 180, authorisation: { name: 'Standard Visitor visa', applyUrl: 'https://www.gov.uk/standard-visitor', note: null },
      confidence: 'high', sources: [{ name: 'Check if you need a UK visa', publisher: 'GOV.UK', url: 'https://www.gov.uk/check-uk-visa', licence: 'OGL v3.0' }], disclaimer: VISA_DISCLAIMER, isSampleData: true,
    })),
  examples: ['Does my Indian passport need a visa for a 2-week holiday in London?', 'Family of four (two British, two Indian passports) flying via Amsterdam to Toronto — what does each of us need?'],
  costHint: '$0.01 per answered pair; unknown answers free.',
};
