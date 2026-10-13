import * as z from 'zod/v4';
import { COST_NOTE, READ_ONLY, compactObj, money, pick, s, str, strList } from '../helpers.js';
import type { DataToolSpec, Obj } from '../types.js';

/* ---------------------------------------------------------------- sanctions_screen */
const SANCTIONS_DISCLAIMER =
  'Decision support only — never say someone "is sanctioned" or "is cleared". Say "potential match, needs human review" or "no match against <list versions>". Does not cover PEPs, adverse media or ownership/control. Not legal advice.';

export const sanctionsScreen: DataToolSpec = {
  name: 'sanctions_screen',
  title: 'Screen names against UK, UN, EU and US sanctions lists',
  folder: 'sanctions-screening',
  actor: 'siteverdict-sanctions-screening',
  toolsets: ['compliance'],
  annotations: READ_ONLY,
  runTimeoutSecs: 600,
  memoryMbytes: 2048,
  maxItems: 100,
  description:
    'Screens people, companies, vessels or aircraft against the official UK Sanctions List (FCDO), UN Security Council Consolidated List, EU consolidated financial sanctions list and US OFAC SDN + non-SDN lists. Returns per input a status (STRONG_POTENTIAL_MATCH / POTENTIAL_MATCH / NO_MATCH), the best scores, matched designations with programme, listing date, DOB, nationality, identifiers and a plain-English explanation, plus the list versions used (always cite listsScreened). Pass DOB and country when known to reduce false positives. For KYC/KYB/supplier/vessel checks. ' +
    SANCTIONS_DISCLAIMER + ' ' + COST_NOTE,
  inputSchema: z.object({
    queries: z
      .array(
        z.object({
          name: str(300).describe('Full name of the person, company, vessel or aircraft (any script).'),
          type: z.enum(['person', 'entity', 'vessel', 'aircraft', 'any']).default('any'),
          dob: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional().describe('YYYY-MM-DD, YYYY-MM or YYYY (persons).'),
          country: str(60).optional().describe('Nationality / residence / registration country, name or ISO code.'),
          identifiers: strList(10, 60).optional().describe('Passport, national ID, IMO, company registration numbers.'),
          ref: str(100).optional().describe('Caller reference echoed back.'),
        }),
      )
      .min(1)
      .max(500),
    lists: z.array(z.enum(['UK', 'UN', 'EU', 'OFAC_SDN', 'OFAC_CONS'])).min(1).default(['UK', 'UN', 'EU', 'OFAC_SDN', 'OFAC_CONS']),
    matchPreset: z.enum(['strict', 'balanced', 'broad']).default('balanced'),
    maxMatchesPerName: z.number().int().min(1).max(10).default(3),
  }),
  buildInput: (a) => compactObj({ mode: 'screen', ...a, includeNoMatchRows: true, includeRecordDetails: false }),
  shape: (i) => ({
    ...pick(i, ['ref', 'inputName', 'status', 'reviewRequired', 'bestScore', 'bestMatchName', 'bestMatchList', 'listsScreened', 'coverageComplete', 'disclaimer', 'isSampleData']),
    matches: Array.isArray(i.matches) ? (i.matches as Obj[]).slice(0, 5).map((m) => pick(m, ['score', 'strength', 'list', 'sourceId', 'entityType', 'primaryName', 'matchedName', 'identifierMatch', 'programmes', 'listedDate', 'dob', 'nationalities', 'explanation', 'referenceUrl'])) : [],
  }),
  sort: (a, b) => Number(b.bestScore ?? 0) - Number(a.bestScore ?? 0),
  line: (i) => `${s(i.inputName)}: ${s(i.status)}${i.bestMatchName ? ` — best match "${s(i.bestMatchName)}" (${s(i.bestMatchList)}, score ${s(i.bestScore)})` : ''}`,
  disclaimer: SANCTIONS_DISCLAIMER,
  sample: (a) =>
    (a.queries as Obj[]).slice(0, 5).map((q, idx) =>
      idx === 0
        ? { inputName: q.name, status: 'POTENTIAL_MATCH', reviewRequired: true, bestScore: 0.91, bestMatchName: 'SAMPLE LISTED PERSON', bestMatchList: 'UK', matches: [{ score: 0.91, strength: 'potential', list: 'UK', primaryName: 'SAMPLE LISTED PERSON', programmes: ['Russia'], listedDate: '2022-03-15', explanation: ['SAMPLE DATA: name similarity 0.91; DOB not supplied'] }], listsScreened: ['UK@SAMPLE sha256:000'], coverageComplete: true, isSampleData: true }
        : { inputName: q.name, status: 'NO_MATCH', reviewRequired: false, bestScore: 0.42, matches: [], listsScreened: ['UK@SAMPLE sha256:000'], coverageComplete: true, isSampleData: true },
    ),
  examples: ["Screen our new supplier 'Example Trading LLC' against UK, EU, UN and US sanctions lists.", 'Is the vessel with IMO 9562233 on any sanctions list?'],
  costHint: '$0.02 per call + $0.004 per name.',
};

/* ---------------------------------------------------------------- validate_vat_or_company_number */
export const validateVat: DataToolSpec = {
  name: 'validate_vat_or_company_number',
  title: 'Validate VAT numbers, UK company numbers and LEIs',
  folder: 'vat-validator',
  actor: 'siteverdict-vat-validator',
  toolsets: ['compliance'],
  annotations: READ_ONLY,
  runTimeoutSecs: 900,
  memoryMbytes: 512,
  maxItems: 100,
  secrets: [
    { name: 'HMRC_CLIENT_ID', label: 'HMRC Developer Hub client ID', help: 'Needed for GB VAT numbers (developer.service.hmrc.gov.uk).' },
    { name: 'HMRC_CLIENT_SECRET', label: 'HMRC client secret', help: 'Pairs with HMRC_CLIENT_ID.' },
    { name: 'COMPANIES_HOUSE_API_KEY', label: 'Companies House API key', help: 'Needed to check UK company numbers (developer.company-information.service.gov.uk).' },
  ],
  description:
    'Validates EU, UK (GB) and Northern Ireland (XI) VAT numbers, UK company numbers (Companies House) and LEIs. Format and check digits are checked locally first; plausible numbers go to the official registry: EU VIES (27 states + XI), HMRC for GB and Companies House for UK companies (both need the user\'s own credentials configured on the server; without them those numbers come back not_checked), GLEIF for LEIs. Returns registry_status (valid | invalid | unavailable | error | not_checked), the registered name and address, name_match_score when you pass the counterparty name, a consultation number when the user\'s own VAT number is given, and a timestamped evidence record. "unavailable" = a member-state database was down: not charged, retry later, do NOT treat as invalid. A valid checksum does NOT mean registered — only registry_status valid does. checkMode "format_only" = cheap bulk clean-up with no registry calls. Use only for counterparties the user has a legitimate reason to verify (sole-trader names are personal data). Not legal or tax advice. ' +
    COST_NOTE,
  inputSchema: z.object({
    numbers: strList(1000, 200).min(1).describe('One per entry: "NUMBER | optional name | optional reference", e.g. "DE136695976 | Acme GmbH | INV-7". VAT numbers need a country prefix (EL for Greece, GB, XI) unless defaultCountry is set.'),
    checkMode: z.enum(['registry', 'format_only']).default('registry'),
    numberType: z.enum(['auto', 'vat', 'uk_company', 'lei']).default('auto'),
    defaultCountry: z.enum(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'GB', 'XI']).optional().describe('VAT prefix for numbers without one'),
    viesRequesterVat: z.string().regex(/^[A-Z]{2}[A-Z0-9]{2,13}$/).optional().describe("User's own EU/XI VAT number, to obtain VIES consultation numbers"),
    hmrcRequesterVrn: z.string().regex(/^\d{9}$/).optional().describe("User's own UK VRN, to obtain HMRC consultation numbers"),
    leiEnrichment: z.boolean().default(false),
    includeRegisteredDetails: z.boolean().default(true),
  }),
  buildInput: (a, ctx) => {
    const sec = ctx.secrets;
    if (!sec.HMRC_CLIENT_ID || !sec.HMRC_CLIENT_SECRET) ctx.notes.push('No HMRC credentials configured: GB VAT numbers are format-checked only (registry_status not_checked).');
    if (!sec.COMPANIES_HOUSE_API_KEY) ctx.notes.push('No Companies House key configured: UK company numbers are format-checked only.');
    return compactObj({ ...a, hmrcClientId: sec.HMRC_CLIENT_ID, hmrcClientSecret: sec.HMRC_CLIENT_SECRET, companiesHouseApiKey: sec.COMPANIES_HOUSE_API_KEY, storeEvidence: true });
  },
  shape: (i) => pick(i, ['input', 'reference', 'number_type', 'normalised_number', 'country', 'format_valid', 'checksum_valid', 'registry_status', 'active', 'registered_name', 'registered_address', 'supplied_name', 'name_match_score', 'name_match', 'vies_trader_name_match', 'consultation_number', 'source', 'source_url', 'checked_at', 'company_status', 'lei', 'lei_status', 'problem', 'error_message', 'retry_advice', 'evidence', 'attribution', 'isSampleData']),
  line: (i) => `${s(i.normalised_number || i.input)}: ${s(i.registry_status)}${i.registered_name ? ` — ${s(i.registered_name)}` : ''}${i.name_match ? ` (name ${s(i.name_match)})` : ''}${i.problem ? ` [${s(i.problem)}]` : ''}`,
  disclaimer: 'Registry answers as returned by VIES/HMRC/Companies House/GLEIF at checked_at. Not legal or tax advice.',
  sample: (a) =>
    (a.numbers as string[]).slice(0, 5).map((raw) => {
      const num = raw.split('|')[0]!.trim().replace(/\s+/g, '').toUpperCase();
      return { input: raw, number_type: 'vat', normalised_number: num, country: num.slice(0, 2), format_valid: true, checksum_valid: true, registry_status: 'valid', active: true, registered_name: 'SAMPLE TRADING GMBH', registered_address: 'SAMPLE STRASSE 1, 10115 BERLIN', source: 'VIES', checked_at: new Date().toISOString(), isSampleData: true };
    }),
  examples: ['Check these supplier VAT numbers before I pay: IE6388047V, DE136695976, FR40303265045.', 'Clean this list of EU VAT IDs — format only, no registry queries.'],
  costHint: 'vat-checked per registry lookup; format-checked cheaper; unavailable free.',
};

/* ---------------------------------------------------------------- extract_pdf_invoice */
export const extractPdfInvoice: DataToolSpec = {
  name: 'extract_pdf_invoice',
  title: 'Extract invoice data and tables from PDFs',
  folder: 'pdf-invoice-extractor',
  actor: 'siteverdict-pdf-invoice-extractor',
  toolsets: ['compliance'],
  annotations: READ_ONLY,
  runTimeoutSecs: 900,
  memoryMbytes: 2048,
  maxItems: 50,
  description:
    'Extracts structured data from PDF invoices, receipts, credit notes and reports given their URLs: supplier name, supplier VAT number (format/check digit validated, not a registry lookup), invoice number, issue/due dates (ISO), currency, net/VAT/gross totals, line items (description, quantity, unit price, VAT rate, amount), a 0-1 confidence per field, arithmetic checks (line sum = net, net + VAT = gross, qty x price = amount), validation issues, and detected tables as Markdown. Deterministic (no LLM); UK and EU number/date formats; labels in English, German, French, Dutch, Spanish and Italian. Scanned PDFs need enableOcr:true (slower). Password-protected or corrupt files are reported, not charged. Check issues and fieldConfidence before trusting values; use validate_vat_or_company_number to confirm a VAT number is registered. URLs must be public or pre-signed http(s) links. ' +
    COST_NOTE,
  inputSchema: z.object({
    pdfUrls: strList(100, 4096).min(1).describe('Public or pre-signed http(s) URLs of PDF files.'),
    invoiceMode: z.enum(['auto', 'always', 'off']).default('auto').describe('auto = invoice fields only for invoice-like documents; off = text and tables only.'),
    extractTables: z.boolean().default(true),
    includeText: z.boolean().default(false).describe('Return full layout text (can be long).'),
    enableOcr: z.boolean().default(false).describe('OCR scanned pages (slower, higher price).'),
    ocrLanguages: z.string().regex(/^[a-z]{3}(\+[a-z]{3})*$/).default('eng').describe('e.g. eng, eng+deu'),
    numberFormat: z.enum(['auto', 'uk', 'eu']).default('auto'),
    dateOrder: z.enum(['DMY', 'MDY']).default('DMY'),
    maxPagesPerDocument: z.number().int().min(1).max(200).default(20),
  }),
  async validate(args, check) {
    return { ...args, pdfUrls: await Promise.all((args.pdfUrls as string[]).map((u) => check.url(u))) };
  },
  buildInput: (a) => compactObj({ ...pick(a, ['invoiceMode', 'extractTables', 'includeText', 'enableOcr', 'ocrLanguages', 'numberFormat', 'dateOrder', 'maxPagesPerDocument']), pdfUrls: (a.pdfUrls as string[]).map((url) => ({ url })), writeLineItemsCsv: false, maxTextChars: 20000 }),
  shape: (i) => {
    const out = pick(i, ['source', 'status', 'error', 'documentType', 'supplierName', 'supplierVatNumber', 'supplierVatChecksumValid', 'invoiceNumber', 'purchaseOrder', 'issueDate', 'dueDate', 'currency', 'netTotal', 'vatTotal', 'grossTotal', 'amountDue', 'vatRates', 'lineItems', 'totalsConsistent', 'checks', 'issues', 'fieldConfidence', 'overallConfidence', 'pageCount', 'pagesProcessed', 'ocrPages', 'text', 'isSampleData']);
    if (Array.isArray(i.tables)) out.tables = (i.tables as Obj[]).slice(0, 10).map((t) => pick(t, ['page', 'headers', 'markdown', 'confidence']));
    return out;
  },
  line: (i) => `${s(i.source)}: ${s(i.status)}${i.supplierName ? ` — ${s(i.supplierName)} #${s(i.invoiceNumber)}, gross ${money(i.grossTotal, i.currency)}` : ''}${i.totalsConsistent === false ? ' [totals do NOT add up]' : ''}`,
  sample: (a) =>
    (a.pdfUrls as string[]).slice(0, 3).map((u) => ({
      source: u, status: 'ok', documentType: 'invoice', supplierName: 'SAMPLE Supplies Ltd', supplierVatNumber: 'GB123456789', supplierVatChecksumValid: true, invoiceNumber: 'INV-0001', issueDate: '2026-09-30', dueDate: '2026-10-30', currency: 'GBP', netTotal: 100, vatTotal: 20, grossTotal: 120, vatRates: [20],
      lineItems: [{ index: 1, description: 'SAMPLE widget', quantity: 2, unitPrice: 50, vatRate: 20, amount: 100, arithmeticOk: true, confidence: 0.95 }], totalsConsistent: true, issues: [], overallConfidence: 0.93, pageCount: 1, pagesProcessed: 1, ocrPages: 0, isSampleData: true,
    })),
  examples: ['Pull the supplier, invoice number, VAT and total out of these three invoice PDFs and flag any that do not add up.', 'Convert the tables in this quarterly report PDF to Markdown.'],
  costHint: 'About $0.012 per one-page digital invoice; $0.01 per OCR page; failed documents free.',
};
