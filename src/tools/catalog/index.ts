import type { DataToolSpec } from '../types.js';
import { extractPdfInvoice, sanctionsScreen, validateVat } from './compliance.js';
import { companyRegistryLookup, findLocalBusinesses, findPublicTenders, secFilingWatch, secFullTextSearch } from './leads.js';
import { googleAdsTransparency, reviewsMonitor, searchTrafficDiagnose, seoRankCheck } from './marketing.js';
import { ukPropertyData } from './property.js';
import { checkFlightCompensation, flightDealAlerts, flightFareEstimate, flightFareScan, visaEntryCheck } from './travel.js';
import { detectTechStack, fetchCleanMarkdown, monitorWebsiteChanges } from './web.js';

/**
 * Every finished Actor with an MCP-TOOL.md (11 Oct 2026): 18 Actors -> 21 tools.
 * Folders without MCP-TOOL.md are unfinished and deliberately not listed.
 */
export const DATA_TOOLS: readonly DataToolSpec[] = [
  detectTechStack, monitorWebsiteChanges, fetchCleanMarkdown,
  seoRankCheck, searchTrafficDiagnose, googleAdsTransparency, reviewsMonitor,
  findLocalBusinesses, companyRegistryLookup, secFilingWatch, secFullTextSearch, findPublicTenders,
  sanctionsScreen, validateVat, extractPdfInvoice,
  flightFareScan, flightFareEstimate, flightDealAlerts, checkFlightCompensation, visaEntryCheck,
  ukPropertyData,
];

export const DATA_TOOL_BY_NAME: Record<string, DataToolSpec> = Object.fromEntries(DATA_TOOLS.map((t) => [t.name, t]));

/** Actor env-override key, e.g. SITEVERDICT_ACTOR_COMPANY_REGISTRIES. */
export const actorEnvKey = (spec: DataToolSpec) => `ACTOR_${spec.folder.toUpperCase().replace(/-/g, '_')}`;
