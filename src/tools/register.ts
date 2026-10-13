import { createHash } from 'node:crypto';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { RunResult } from '../apify/runner.js';
import { BRAND } from '../brand.js';
import { AuthError, CancelledError, UserInputError } from '../lib/errors.js';
import { errorResult, progressFor } from '../lib/toolkit.js';
import { validatePublicUrl } from '../lib/validate.js';
import { MISSING_TOKEN_HELP } from '../auth.js';
import type { ServerDeps } from '../server.js';
import { actorEnvKey, DATA_TOOL_BY_NAME, DATA_TOOLS } from './catalog/index.js';
import { compactObj, trimDeep } from './helpers.js';
import { DataResultSchema, type BuildContext, type DataResult, type DataToolSpec, type Obj } from './types.js';

const MAX_TEXT_LINES = 15;

export function actorIdFor(deps: Pick<ServerDeps, 'config'>, spec: DataToolSpec): string {
  return deps.config.actorOverrides[actorEnvKey(spec)] ?? `${deps.config.apifyUsername}/${spec.actor}`;
}

/** Per-caller namespace for Apify state stores, so monitor baselines of different users never mix. */
export function stateNamer(source: string, clientKey: string): (name?: string) => string {
  const prefix = source === 'env' || source === 'none' ? 'mcp' : `mcp-${createHash('sha256').update(clientKey).digest('hex').slice(0, 10)}`;
  return (name = 'default') => `${prefix}-${name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'default'}`.slice(0, 63);
}

const isSampleItem = (i: Obj) => i.isSampleData === true || i.isSample === true || i.sampleData === true;

function statusOf(run: RunResult): DataResult['status'] {
  if (run.status === 'SUCCEEDED') return 'complete';
  if (['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'].includes(run.status)) return 'running';
  return 'failed';
}

export function buildDataResult(spec: DataToolSpec, args: Obj, run: RunResult, notes: string[], maxChars: number): DataResult {
  const status = statusOf(run);
  let items = (run.items.filter((x) => x && typeof x === 'object') as Obj[])
    .map((i) => (spec.shape ? spec.shape(i, args) : i))
    .filter((i): i is Obj => i !== null)
    .map((i) => trimDeep(compactObj(i), spec.name === 'fetch_clean_markdown' ? 100_000 : 1200) as Obj);
  if (spec.sort) items = [...items].sort(spec.sort);
  const itemsTotal = items.length;
  const sampleData = items.some(isSampleItem);
  const cap = spec.maxItems ?? 50;
  let truncated = items.length > cap;
  items = items.slice(0, cap);

  const types = new Map<string, number>();
  for (const i of items) {
    const t = String(i.recordType ?? i.type ?? 'result');
    types.set(t, (types.get(t) ?? 0) + 1);
  }
  let summary: string;
  if (status === 'running') summary = `Still running (run ${run.runId}). Call get_run_results with this runId and tool "${spec.name}" in a minute or two.`;
  else if (status === 'failed') summary = `Run ended with status ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ''}.`;
  else summary = `${itemsTotal} record(s)${types.size > 1 || !types.has('result') ? `: ${[...types].map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}.`;

  const result: DataResult = {
    tool: spec.name,
    status,
    dryRun: run.dryRun,
    sampleData: sampleData || run.dryRun,
    summary,
    items,
    itemsTotal,
    truncated,
    notes,
    ...(spec.disclaimer ? { disclaimer: spec.disclaimer } : {}),
    ...(run.datasetUrl ? { datasetUrl: run.datasetUrl } : {}),
    run: compactObj({ actorId: run.actorId, runId: run.runId, status: run.dryRun ? 'DRY-RUN' : run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, usageTotalUsd: run.usageTotalUsd, consoleUrl: run.consoleUrl }) as DataResult['run'],
  };
  // Keep each result well under client limits (Claude ~150k chars, Claude Code 25k tokens).
  while (result.items.length > 1 && JSON.stringify(result).length > maxChars) {
    result.items = result.items.slice(0, Math.max(1, Math.floor(result.items.length * 0.7)));
    truncated = true;
  }
  if (JSON.stringify(result).length > maxChars) result.items = result.items.map((i) => trimDeep(i, 2000, 10) as Obj);
  result.truncated = truncated || result.items.length < itemsTotal;
  return result;
}

export function dataResultText(spec: DataToolSpec, r: DataResult): string {
  const lines: string[] = [];
  if (r.dryRun) lines.push('⚠ DRY RUN — SAMPLE DATA from the server, not a real lookup.');
  else if (r.sampleData) lines.push('⚠ SAMPLE / FICTIONAL DATA returned by the Actor (no credentials configured) — do not present as real.');
  lines.push(`${spec.title}: ${r.summary}`);
  for (const i of r.items.slice(0, MAX_TEXT_LINES)) {
    const l = spec.line(i);
    if (l) lines.push(`- ${l}`);
  }
  if (r.itemsTotal > MAX_TEXT_LINES) lines.push(`(${r.itemsTotal - Math.min(MAX_TEXT_LINES, r.items.length)} more in structured results${r.truncated ? ' / the dataset' : ''})`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  if (r.disclaimer) lines.push(r.disclaimer);
  if (r.run.usageTotalUsd !== undefined && !r.dryRun) lines.push(`Apify run cost: $${r.run.usageTotalUsd.toFixed(3)}${r.run.runId ? ` (run ${r.run.runId})` : ''}`);
  return lines.join('\n');
}

/** Registers every enabled data tool (+ get_run_results when at least one is enabled). */
export function registerDataTools(server: McpServer, deps: ServerDeps, enabled: (name: string) => boolean, toolMeta: (spec?: DataToolSpec) => Record<string, unknown>): string[] {
  const { config, auth, limiter } = deps;
  const registered: string[] = [];
  const secretValues = () => Object.values(auth.secrets ?? {});

  const useApi = (spec: DataToolSpec) =>
    Boolean(spec.apiTool && config.apiBaseUrl && deps.apiRunner && (config.backend === 'api' || (config.backend === 'auto' && auth.apiKey)));

  for (const spec of DATA_TOOLS) {
    if (!enabled(spec.name)) continue;
    registered.push(spec.name);
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        outputSchema: DataResultSchema,
        annotations: { title: spec.title, ...spec.annotations },
        _meta: toolMeta(spec),
      },
      async (rawArgs: Record<string, unknown>, ctx: ServerContext): Promise<CallToolResult> => {
        let release: (() => void) | undefined;
        try {
          const viaApi = useApi(spec);
          if (!config.dryRun) {
            if (viaApi && !auth.apiKey) throw new AuthError('This server uses the SiteVerdict API backend: send your SiteVerdict API key (X-API-Key) or connect with OAuth.');
            if (!viaApi && !auth.token) throw new AuthError(MISSING_TOKEN_HELP);
          }
          const urlOpts = { dnsCheck: config.dnsCheck && !config.dryRun, resolver: deps.resolver };
          const args = spec.validate ? await spec.validate(rawArgs, { url: (u) => validatePublicUrl(u, urlOpts) }) : rawArgs;
          limiter.hit(auth.clientKey);
          release = limiter.acquire(auth.clientKey, 1);
          const notes: string[] = [];
          const bctx: BuildContext = { secrets: auth.secrets ?? {}, stateName: stateNamer(auth.source, auth.clientKey), notes, contactEmail: config.contactEmail };
          const input = compactObj(spec.buildInput(args, bctx));
          let run: RunResult;
          if (config.dryRun) {
            const now = new Date().toISOString();
            run = { actorId: actorIdFor(deps, spec), runId: `dryrun-${spec.name}`, status: 'SUCCEEDED', items: spec.sample(args), startedAt: now, finishedAt: now, usageTotalUsd: 0, dryRun: true };
          } else if (viaApi) {
            run = await deps.apiRunner!.run({ actorId: `siteverdict-api/${spec.apiTool}`, input, token: '', apiKey: auth.apiKey, waitSecs: Math.min(config.maxWaitSecs, config.defaultWaitSecs), runTimeoutSecs: spec.runTimeoutSecs, signal: ctx.mcpReq.signal, onProgress: progressFor(ctx), api: { tool: spec.apiTool!, body: spec.apiBody ? spec.apiBody(args) : args, kind: 'data' } });
          } else {
            run = await deps.runner.run({
              actorId: actorIdFor(deps, spec),
              input,
              token: auth.token ?? '',
              waitSecs: Math.min(config.maxWaitSecs, config.defaultWaitSecs),
              runTimeoutSecs: spec.runTimeoutSecs,
              memoryMbytes: spec.memoryMbytes,
              maxTotalChargeUsd: config.defaultMaxChargeUsd,
              signal: ctx.mcpReq.signal,
              onProgress: progressFor(ctx),
            });
          }
          const result = buildDataResult(spec, args, run, notes, config.maxResultChars);
          return { content: [{ type: 'text', text: dataResultText(spec, result) }], structuredContent: result };
        } catch (err) {
          if (err instanceof CancelledError) return errorResult(err, undefined, secretValues());
          return errorResult(err, deps.log, secretValues());
        } finally {
          release?.();
        }
      },
    );
  }

  if (registered.length) {
    const names = registered as [string, ...string[]];
    server.registerTool(
      'get_run_results',
      {
        title: 'Get results of an earlier data-tool run',
        description: `Fetches the status and results of a run that was still "running" when a ${BRAND.name} data tool returned (by runId and tool name). Does not start a new run and costs nothing extra.`,
        inputSchema: z.object({
          runId: z.string().regex(/^[A-Za-z0-9_-]{5,60}$/).describe('run.runId from an earlier result'),
          tool: z.enum(names).describe('Which tool produced the run'),
        }),
        outputSchema: DataResultSchema,
        annotations: { title: 'Get run results', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        _meta: toolMeta(),
      },
      async ({ runId, tool }, ctx): Promise<CallToolResult> => {
        try {
          const spec = DATA_TOOL_BY_NAME[tool]!;
          let run: RunResult;
          if (runId.startsWith('dryrun-')) {
            throw new UserInputError('Dry-run results are returned immediately; there is nothing to fetch for a dry-run runId.');
          }
          if (runId.startsWith('job_')) {
            if (!deps.apiRunner || !auth.apiKey) throw new AuthError('A SiteVerdict API key is needed to fetch API job results.');
            run = await deps.apiRunner.fetchRun({ runId, token: '', apiKey: auth.apiKey, signal: ctx.mcpReq.signal, kind: 'data' });
          } else {
            if (!auth.token) throw new AuthError(MISSING_TOKEN_HELP);
            limiter.hit(auth.clientKey);
            run = await deps.runner.fetchRun({ runId, token: auth.token, signal: ctx.mcpReq.signal });
          }
          const result = buildDataResult(spec, {}, run, [], config.maxResultChars);
          return { content: [{ type: 'text', text: dataResultText(spec, result) }], structuredContent: result };
        } catch (err) {
          return errorResult(err, deps.log, secretValues());
        }
      },
    );
    registered.push('get_run_results');
  }
  return registered;
}
