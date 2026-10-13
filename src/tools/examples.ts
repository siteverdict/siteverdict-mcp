/**
 * One valid example call per tool. Used by the unit tests, the stdio/HTTP smoke test (dry-run) and the
 * directory submission test cases, so every tool is exercised end-to-end without network access.
 */
export const EXAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  // web — audits
  full_website_audit: { url: 'https://example.com' },
  audit_tracking_consent: { url: 'example.com', scanMode: 'quick' },
  scan_speed_and_revenue: { url: 'https://example.com', monthlyVisitors: 20000, averageOrderValue: 60, conversionRatePct: 2 },
  audit_accessibility_wcag: { url: 'https://example.com', wcagLevel: 'AA' },
  check_domain_email_health: { domain: 'example.com' },
  check_ai_search_readiness: { url: 'https://example.com' },
  // web — data
  detect_tech_stack: { urls: ['example.com', 'https://example.org'] },
  monitor_website_changes: { urls: ['https://example.com/pricing'], stateStoreName: 'pricing-watch' },
  fetch_clean_markdown: { urls: ['https://example.com/docs'] },
  // marketing
  seo_rank_check: { keywords: ['running shoes', 'trail running shoes'], targetDomains: ['example.com'], competitorDomains: ['example.org'] },
  search_traffic_diagnose: { properties: [{ label: 'Example', gscSiteUrl: 'sc-domain:example.com', ga4PropertyId: '123456789' }] },
  google_ads_transparency: { mode: 'creatives', advertiserNames: ['Example Travel'], regions: ['DE'], estimateOnly: true },
  reviews_monitor: { mode: 'backfill', lookbackDays: 30, trustpilotBusinessUnits: ['example.com'] },
  // leads
  find_local_businesses: { queries: ['cafes in Plymouth'], countryCode: 'GB', maxResultsPerQuery: 20 },
  company_registry_lookup: { queries: ['ticker:MSFT'], maxFilingsPerCompany: 3 },
  sec_filing_watch: { companies: ['AAPL'], forms: ['8-K'], watchName: 'apple-8k', lookbackDays: 7 },
  sec_full_text_search: { query: '"going concern" aviation', forms: ['10-K'], from: '2026-01-01' },
  find_public_tenders: { keywords: ['website'], cpvKeywords: ['website'], openOnly: true, sources: ['fts'], maxResults: 10 },
  // compliance
  sanctions_screen: { queries: [{ name: 'Example Trading LLC', type: 'entity', country: 'GB' }, { name: 'Jane Example', type: 'person', dob: '1970' }] },
  validate_vat_or_company_number: { numbers: ['DE136695976 | Example GmbH | INV-7', 'IE6388047V'] },
  extract_pdf_invoice: { pdfUrls: ['https://example.com/invoice-0001.pdf'] },
  // travel
  flight_fare_scan: { routes: ['LON-BKK'], monthsAhead: 2 },
  flight_fare_estimate: { routes: ['LON-BKK', 'MAN-DXB'], monthsAhead: 6, maxLiveSearches: 4 },
  flight_deal_alerts: { origins: ['LON', 'MAN'], destinationRegions: ['se_asia'], maxPrice: 500, maxDeals: 10 },
  check_flight_compensation: { claims: [{ reference: 'trip-1', departureAirport: 'LGW', arrivalAirport: 'FAO', operatingCarrier: 'EZY', arrivalDelayMinutes: 205, passengers: 2, date: '2026-09-14' }] },
  visa_entry_check: { checks: [{ nationality: 'IN', destination: 'GB', purpose: 'tourism', durationDays: 14 }] },
  // property
  uk_property_data: { searches: ['PL4'], summaryOnly: true, includePlanning: false },
};

/** Negative cases every directory review asks for: inputs that must be refused safely. */
export const NEGATIVE_ARGS: { tool: string; args: Record<string, unknown>; why: string }[] = [
  { tool: 'scan_speed_and_revenue', args: { url: 'http://169.254.169.254/latest/meta-data' }, why: 'cloud metadata IP (SSRF guard)' },
  { tool: 'detect_tech_stack', args: { urls: ['http://localhost:8080'] }, why: 'internal host (SSRF guard)' },
  { tool: 'check_flight_compensation', args: { claims: [{ flightNumber: 'BA117', date: '2026-09-14' }], provider: 'aerodatabox' }, why: 'provider lookup without the user\'s own key' },
  { tool: 'visa_entry_check', args: {}, why: 'neither checks nor trip given' },
];
