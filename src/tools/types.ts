import * as z from 'zod/v4';
import { RunInfoSchema } from '../report.js';
import type { ToolsetId } from '../toolsets.js';

export type Obj = Record<string, unknown>;

/** A credential the END USER supplies for a third-party API. Never a tool argument the model fills in. */
export interface SecretDef {
  /** Env suffix: stdio reads SITEVERDICT_SECRET_<name>; HTTP (API-key mode) reads header X-SiteVerdict-Secret-<name with dashes>. */
  name: string;
  label: string;
  /** Where to get it. */
  help: string;
}

export interface BuildContext {
  /** Secrets configured by the caller, keyed by SecretDef.name. Values are never logged or returned. */
  secrets: Record<string, string>;
  /** Per-caller namespace for Apify state stores (monitor baselines etc.), e.g. "mcp-3fa9c1-pricing". */
  stateName(name?: string): string;
  /** Notes appended to the result (e.g. "no Google key: estimate only"). */
  notes: string[];
  /** Operator contact (used where a public API asks for one, e.g. SEC EDGAR). */
  contactEmail: string;
}

export interface DataToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** One MCP tool backed by one Apify Actor (or the SiteVerdict API). Built from <actor>/MCP-TOOL.md. */
export interface DataToolSpec {
  name: string;
  title: string;
  description: string;
  toolsets: ToolsetId[];
  /** Actor name without the username, e.g. "siteverdict-company-registries". */
  actor: string;
  /** Source folder in /home/shiven/apify-actors (for docs). */
  folder: string;
  /** SiteVerdict API tool id (API-CONTRACT.md) when the API can serve this tool. */
  apiTool?: string;
  inputSchema: z.ZodObject;
  annotations: DataToolAnnotations;
  secrets?: SecretDef[];
  runTimeoutSecs: number;
  memoryMbytes?: number;
  /** Max items placed in structuredContent (the rest are counted, and stay in the Apify dataset). */
  maxItems?: number;
  /** Validates/normalises user-supplied URLs etc. Throw UserInputError on bad input. */
  validate?(args: Obj, check: { url: (u: string) => Promise<string> }): Promise<Obj>;
  buildInput(args: Obj, ctx: BuildContext): Obj;
  /** API body for the SiteVerdict API backend. */
  apiBody?(args: Obj): Obj;
  /** Trims one dataset item for the model's context (return null to drop). */
  shape?(item: Obj, args: Obj): Obj | null;
  /** One-line plain-text rendering of an item for the text content block. */
  line(item: Obj): string | null;
  /** Optional ordering of items (e.g. low-star reviews first). */
  sort?(a: Obj, b: Obj): number;
  disclaimer?: string;
  /** Built-in SAMPLE items for dry-run mode (no network). */
  sample(args: Obj): Obj[];
  examples: string[];
  /** Approximate cost guidance shown in docs. */
  costHint: string;
}

export const DataResultSchema = z.object({
  tool: z.string(),
  status: z.enum(['complete', 'running', 'failed']).describe('"running" = still working; call get_run_results with run.runId later'),
  dryRun: z.boolean().describe('true = built-in SAMPLE data from this server, NOT a real lookup'),
  sampleData: z.boolean().describe('true = the Actor returned fictional sample rows (e.g. no credentials configured); never present as real'),
  summary: z.string(),
  items: z.array(z.record(z.string(), z.unknown())).describe('Result records (trimmed for context). Records often carry a recordType discriminator.'),
  itemsTotal: z.number().int(),
  truncated: z.boolean().describe('true = more records exist than are included here (see datasetUrl)'),
  notes: z.array(z.string()),
  disclaimer: z.string().optional(),
  datasetUrl: z.string().optional(),
  run: RunInfoSchema,
});
export type DataResult = z.infer<typeof DataResultSchema>;
