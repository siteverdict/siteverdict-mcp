import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ACTORS, CHECK_BY_TOOL, compact, runControls, urlField, type ActorSpec } from './actors.js';
import { MISSING_TOKEN_HELP, type CallerAuth } from './auth.js';
import { BRAND, SERVER_VERSION } from './brand.js';
import { CHECK_KEYS, type CheckKey, type Config } from './config.js';
import type { ActorRunner, RunResult } from './apify/runner.js';
import { apiBodyForCheck } from './api/bodies.js';
import { AuthError, CancelledError, toUserMessage } from './lib/errors.js';
import type { ClientLimiter } from './lib/rateLimit.js';
import { errorResult, progressFor } from './lib/toolkit.js';
import { WIDGET_HTML, WIDGET_MIME, WIDGET_RESOURCE_META, WIDGET_URI, widgetToolMeta } from './apps/widget.js';
import { DATA_TOOLS } from './tools/catalog/index.js';
import { actorIdFor, registerDataTools } from './tools/register.js';
import type { DataToolSpec } from './tools/types.js';
import { TOOLSETS, toolEnabled, type ToolsetId } from './toolsets.js';
import { validatePublicDomain, validatePublicUrl, type Resolver } from './lib/validate.js';
import {
  buildFixPlan, CheckReportSchema, countSeverities, deriveScore, FullAuditSchema, gradeFor, mergeSeverityCounts,
  normaliseItems, overallScore, pickMetrics, pickScore, sortFindings,
  type CheckReport, type FullAudit,
} from './report.js';

export interface ServerDeps {
  config: Config;
  auth: CallerAuth;
  limiter: ClientLimiter;
  /** Real runner (Apify API). */
  runner: ActorRunner;
  /** Sample-data runner used when config.dryRun is on. */
  mockRunner: ActorRunner;
  resolver?: Resolver;
  log?: (msg: string) => void;
  /** SiteVerdict API backend runner (used when configured; see config.backend). */
  apiRunner?: ActorRunner;
  /** Per-connection toolset override (HTTP ?toolsets=); defaults to config.toolsets. */
  toolsets?: Set<ToolsetId>;
  /** Per-connection tool allow-list override (HTTP ?tools=); defaults to config.toolAllow. */
  toolAllow?: Set<string>;
}

/** SiteVerdict API tool ids for the five checks (products/API-CONTRACT.md). */
const API_TOOL_BY_CHECK: Record<CheckKey, string> = {
  tracking_consent: 'consent-tracking',
  speed_revenue: 'speed',
  accessibility: 'accessibility',
  domain_email: 'domain-health',
  ai_search: 'ai-readiness',
};

const MAX_FINDINGS_IN_RESULT = 25;

function serverInstructions(toolsets: Set<ToolsetId>): string {
  const groups = [...toolsets].map((t) => `${t} (${TOOLSETS[t].title})`).join(', ');
  return `${BRAND.name} gives agents read-mostly business tools backed by Apify Actors. Enabled toolsets: ${groups}.
- Website audits: use full_website_audit for "audit my site"; it runs all checks in parallel and returns a prioritised fix plan. Use single-check tools for one area (cookies/GDPR, speed, accessibility, email/DMARC, AI search).
- Each call starts a paid Apify run on the user's own account (spend-capped); avoid repeated calls for the same input and reuse results.
- If a result has status "running", call get_audit_results (audits) or get_run_results (other tools) with the runId later instead of starting a new run.
- Results with dryRun=true or sampleData=true are SAMPLE data: never present them as real.
- Relay disclaimers: tools give decision support, not legal, financial, tax, immigration or valuation advice.`;
}

/* ------------------------------------------------------------------ helpers */

type Ctx = ServerContext;

function statusOf(run: RunResult): CheckReport['status'] {
  if (run.status === 'SUCCEEDED') return 'complete';
  if (['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'].includes(run.status)) return 'running';
  return 'failed';
}

export function buildCheckReport(spec: ActorSpec, target: string, run: RunResult): CheckReport {
  const status = statusOf(run);
  const { summaryItem, findings } = normaliseItems(run.items, spec.key);
  const sorted = sortFindings(findings);
  let score = pickScore(summaryItem);
  if (score === null && status === 'complete' && (findings.length > 0 || summaryItem)) score = deriveScore(findings);
  const actorGrade = typeof summaryItem?.grade === 'string' ? summaryItem.grade : null;
  const counts = countSeverities(findings);
  const reportUrl = (typeof summaryItem?.reportUrl === 'string' && summaryItem.reportUrl) || run.reportUrl;
  let summary: string;
  if (status === 'running') summary = `Scan still running on Apify (run ${run.runId}). Call get_audit_results with this runId in a minute or two.`;
  else if (status === 'failed') summary = `Actor run ended with status ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ''}.`;
  else
    summary =
      (typeof summaryItem?.summary === 'string' && summaryItem.summary) ||
      `${findings.length} issue(s): ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low.`;
  return {
    check: spec.key,
    target,
    status,
    dryRun: run.dryRun,
    score,
    grade: actorGrade ?? gradeFor(score),
    summary,
    findings: sorted.slice(0, MAX_FINDINGS_IN_RESULT),
    findingsTotal: findings.length,
    severityCounts: counts,
    metrics: pickMetrics(summaryItem),
    ...(reportUrl ? { reportUrl } : {}),
    ...(run.datasetUrl ? { datasetUrl: run.datasetUrl } : {}),
    run: compact({
      actorId: run.actorId,
      runId: run.runId,
      status: run.dryRun ? 'DRY-RUN' : run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      usageTotalUsd: run.usageTotalUsd,
      consoleUrl: run.consoleUrl,
    }) as CheckReport['run'],
  };
}

function checkReportText(spec: ActorSpec, r: CheckReport): string {
  const lines: string[] = [];
  if (r.dryRun) lines.push('⚠ DRY RUN — SAMPLE DATA, not a real scan of this site.');
  lines.push(`${spec.title} — ${r.target}`);
  if (r.score !== null) lines.push(`Score: ${r.score}/100 (${r.grade}) · ${r.severityCounts.critical} critical, ${r.severityCounts.high} high, ${r.severityCounts.medium} medium, ${r.severityCounts.low} low`);
  lines.push(r.summary);
  const top = r.findings.filter((f) => f.severity !== 'info').slice(0, 5);
  if (top.length) {
    lines.push('Top fixes:');
    top.forEach((f, i) => lines.push(`${i + 1}. [${f.severity}] ${f.title}${f.fix ? ` — Fix: ${f.fix}` : ''}`));
  }
  if (r.findingsTotal > r.findings.length) lines.push(`(${r.findingsTotal - r.findings.length} more findings in the full report)`);
  if (r.reportUrl) lines.push(`Full report: ${r.reportUrl}`);
  if (r.run.usageTotalUsd !== undefined && !r.dryRun) lines.push(`Apify run cost: $${r.run.usageTotalUsd.toFixed(3)} (run ${r.run.runId})`);
  return lines.join('\n');
}

function reportLinks(r: { reportUrl?: string; check: string; target: string }): CallToolResult['content'] {
  if (!r.reportUrl || !/^https:\/\//.test(r.reportUrl)) return [];
  return [
    {
      type: 'resource_link',
      uri: r.reportUrl,
      name: `${r.check}-report`,
      title: `Full ${r.check.replace('_', ' ')} report for ${r.target}`,
      mimeType: r.reportUrl.endsWith('.html') ? 'text/html' : 'application/json',
      description: 'Full report stored in the Apify key-value store of the run.',
    },
  ];
}

/* --------------------------------------------------------------- the server */

export function createServer(deps: ServerDeps): McpServer {
  const { config, auth, limiter } = deps;
  const toolsets = deps.toolsets ?? config.toolsets;
  const allow = deps.toolAllow ?? config.toolAllow;
  const enabled = (names: readonly ToolsetId[], tool: string) => toolEnabled(names, toolsets, allow, tool);
  const securitySchemes = config.oauth.enabled
    ? [{ type: 'oauth2', scopes: ['siteverdict.tools'] }]
    : config.dryRun
      ? [{ type: 'noauth' }]
      : [{ type: 'oauth2', scopes: ['siteverdict.tools'] }, { type: 'noauth' }];
  const metaFor = (widget?: { invoking: string; invoked: string }) => ({ ...(widget ? widgetToolMeta(widget.invoking, widget.invoked) : {}), securitySchemes });
  const useApi = () => Boolean(config.apiBaseUrl && deps.apiRunner && (config.backend === 'api' || (config.backend === 'auto' && auth.apiKey)));
  const server = new McpServer(
    {
      name: BRAND.registryName,
      title: BRAND.displayName,
      version: SERVER_VERSION,
      websiteUrl: BRAND.website,
    },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: serverInstructions(toolsets),
      maxToolInputElements: 200,
    },
  );

  const runnerFor = (): ActorRunner => {
    if (config.dryRun) return deps.mockRunner;
    if (useApi()) {
      if (!auth.apiKey) throw new AuthError('This server uses the SiteVerdict API backend: send your SiteVerdict API key (X-API-Key) or connect with OAuth.');
      return deps.apiRunner!;
    }
    if (!auth.token) throw new AuthError(MISSING_TOKEN_HELP);
    return deps.runner;
  };

  async function resolveTarget(spec: ActorSpec, args: Record<string, unknown>): Promise<string> {
    const opts = { dnsCheck: config.dnsCheck && !config.dryRun, resolver: deps.resolver };
    return spec.targetKind === 'domain'
      ? validatePublicDomain(String(args.domain ?? ''), opts)
      : validatePublicUrl(String(args.url ?? ''), opts);
  }

  async function runCheck(spec: ActorSpec, target: string, args: Record<string, unknown>, ctx: Ctx, onProgress: (p: number, t: number | undefined, m: string) => void, maxCostUsd?: number): Promise<CheckReport> {
    const runner = runnerFor();
    const waitSecs = Math.min(config.maxWaitSecs, Number(args.waitSecs ?? config.defaultWaitSecs));
    const run = await runner.run({
      actorId: config.actorIds[spec.key],
      input: compact(spec.buildActorInput(target, args)),
      token: auth.token ?? '',
      apiKey: auth.apiKey,
      api: { tool: API_TOOL_BY_CHECK[spec.key], body: apiBodyForCheck(spec.key, target, args), kind: 'check' },
      waitSecs,
      runTimeoutSecs: spec.runTimeoutSecs,
      memoryMbytes: spec.memoryMbytes,
      maxTotalChargeUsd: maxCostUsd ?? (args.maxCostUsd as number | undefined) ?? config.defaultMaxChargeUsd,
      signal: ctx.mcpReq.signal,
      onProgress,
    });
    return buildCheckReport(spec, target, run);
  }

  /* ---- single-check tools (toolset "web") */
  const auditTools: string[] = [];
  for (const spec of Object.values(ACTORS)) {
    if (!enabled(['web'], spec.tool)) continue;
    auditTools.push(spec.tool);
    server.registerTool(
      spec.tool,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        outputSchema: CheckReportSchema,
        annotations: { title: spec.title, readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        _meta: metaFor({ invoking: `Running ${spec.key.replace('_', ' ')} check…`, invoked: 'Check complete' }),
      },
      async (args: Record<string, unknown>, ctx: Ctx): Promise<CallToolResult> => {
        let release: (() => void) | undefined;
        try {
          runnerFor();
          const target = await resolveTarget(spec, args);
          limiter.hit(auth.clientKey);
          release = limiter.acquire(auth.clientKey, 1);
          const report = await runCheck(spec, target, args, ctx, progressFor(ctx));
          return {
            content: [{ type: 'text', text: checkReportText(spec, report) }, ...reportLinks(report)],
            structuredContent: report,
          };
        } catch (err) {
          if (err instanceof CancelledError) return errorResult(err);
          return errorResult(err, deps.log);
        } finally {
          release?.();
        }
      },
    );
  }

  /* ---- composite */
  const fullInput = z.object({
    url: urlField,
    checks: z
      .array(z.enum(CHECK_KEYS))
      .min(1)
      .max(5)
      .default([...CHECK_KEYS])
      .describe('Which checks to run (default: all five). domain_email uses the URL\'s domain.'),
    maxPages: z.number().int().min(1).max(10).default(3).describe('Pages per crawler-based check (keeps cost and time down).'),
    device: z.enum(['mobile', 'desktop']).default('mobile'),
    maxCostUsd: z.number().min(0.05).max(100).optional().describe('Total spend cap across all runs on YOUR Apify account (split evenly per check). Default: $2 per check.'),
    waitSecs: runControls.waitSecs,
  });

  if (enabled(['web'], 'full_website_audit')) {
  auditTools.push('full_website_audit');
  server.registerTool(
    'full_website_audit',
    {
      title: 'Full website audit with prioritised fix plan',
      description:
        'Runs the tracking & consent, speed & revenue, accessibility (WCAG 2.2), domain/email health and AI-search readiness checks IN PARALLEL on one website, then merges them into an overall score, an executive summary and a single fix list ranked by severity, legal/revenue impact and effort. Best first call for "audit my website" or "what should I fix first". Partial results are returned if one check fails. Starts one Apify run per check on the caller\'s Apify account (pay-per-event).',
      inputSchema: fullInput,
      outputSchema: FullAuditSchema,
      annotations: { title: 'Full website audit', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: metaFor({ invoking: 'Auditing the website…', invoked: 'Audit ready' }),
    },
    async (args, ctx): Promise<CallToolResult> => {
      let release: (() => void) | undefined;
      try {
        runnerFor();
        const opts = { dnsCheck: config.dnsCheck && !config.dryRun, resolver: deps.resolver };
        const target = await validatePublicUrl(args.url, opts);
        const domain = await validatePublicDomain(new URL(target).hostname.replace(/^www\./, ''), opts);
        const checks = [...new Set(args.checks)];
        limiter.hit(auth.clientKey);
        release = limiter.acquire(auth.clientKey, checks.length);
        const perCheckCap = args.maxCostUsd !== undefined ? Math.max(0.01, args.maxCostUsd / checks.length) : config.defaultMaxChargeUsd;

        const progress = progressFor(ctx);
        const pct = new Map<CheckKey, number>(checks.map((c) => [c, 0]));
        const report = (c: CheckKey) => (p: number, _t: number | undefined, m: string) => {
          pct.set(c, p);
          const avg = [...pct.values()].reduce((a, b) => a + b, 0) / pct.size;
          progress(Math.round(avg), 100, `${c}: ${m}`);
        };

        const settled = await Promise.allSettled(
          checks.map((c) => {
            const spec = ACTORS[c];
            const base: Record<string, unknown> = c === 'domain_email' ? { domain } : { url: target };
            const extra: Record<string, unknown> = {
              tracking_consent: { internalPages: Math.min(10, args.maxPages - 1) },
              speed_revenue: { maxPages: args.maxPages, device: args.device },
              accessibility: { maxPages: args.maxPages },
              domain_email: {},
              ai_search: { maxPages: args.maxPages },
            }[c];
            const parsed = spec.inputSchema.parse({ ...base, ...extra, waitSecs: args.waitSecs }) as Record<string, unknown>;
            return runCheck(spec, c === 'domain_email' ? domain : target, parsed, ctx, report(c), perCheckCap);
          }),
        );
        if (ctx.mcpReq.signal.aborted) throw new CancelledError('Cancelled; running Apify runs were aborted.');

        const reports: CheckReport[] = [];
        const sections: FullAudit['sections'] = [];
        settled.forEach((s, i) => {
          const c = checks[i]!;
          if (s.status === 'fulfilled') {
            reports.push(s.value);
            sections.push(compact({ check: c, status: s.value.status, score: s.value.score, summary: s.value.summary, findingsTotal: s.value.findingsTotal, reportUrl: s.value.reportUrl, runId: s.value.run.runId }) as FullAudit['sections'][number]);
          } else {
            sections.push({ check: c, status: 'failed', score: null, summary: 'Check failed.', findingsTotal: 0, error: toUserMessage(s.reason) });
          }
        });
        if (reports.length === 0) {
          const first = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
          throw first?.reason ?? new Error('All checks failed');
        }

        const fixPlan = buildFixPlan(reports.map((r) => ({ check: r.check, findings: r.findings })));
        const score = overallScore(reports.map((r) => ({ check: r.check, score: r.score })));
        const counts = mergeSeverityCounts(reports.map((r) => r.severityCounts));
        const dryRun = reports.some((r) => r.dryRun);
        const cost = reports.reduce((sum, r) => sum + (r.run.usageTotalUsd ?? 0), 0);
        const failed = sections.filter((s) => s.status === 'failed').length;
        const running = sections.filter((s) => s.status === 'running').length;
        const weakest = [...reports].filter((r) => r.score !== null).sort((a, b) => a.score! - b.score!)[0];

        const exec = [
          score !== null ? `Overall ${score}/100 (${gradeFor(score)}) across ${reports.length - running} completed check(s).` : 'No scores yet.',
          `${counts.critical} critical and ${counts.high} high-severity issues found.`,
          weakest ? `Weakest area: ${weakest.check.replace('_', ' ')} (${weakest.score}/100).` : '',
          fixPlan.length ? `Fix first: ${fixPlan.slice(0, 3).map((f) => f.title).join('; ')}.` : '',
          failed ? `${failed} check(s) failed and are excluded from the score.` : '',
          running ? `${running} check(s) still running — use get_audit_results with their runId.` : '',
        ].filter(Boolean).join(' ');

        const result: FullAudit = {
          target,
          domain,
          dryRun,
          overallScore: score,
          grade: gradeFor(score),
          executiveSummary: exec,
          sections,
          fixPlan,
          severityCounts: counts,
          ...(dryRun ? {} : { totalCostUsd: Math.round(cost * 1000) / 1000 }),
        };

        const text = [
          dryRun ? '⚠ DRY RUN — SAMPLE DATA, not a real scan of this site.' : '',
          `Website audit — ${target}`,
          exec,
          '',
          'Sections:',
          ...sections.map((s) => `- ${s.check}: ${s.status}${s.score !== null ? ` ${s.score}/100` : ''}${s.error ? ` (${s.error})` : ''}${s.reportUrl ? ` — ${s.reportUrl}` : ''}`),
          '',
          'Prioritised fix plan:',
          ...fixPlan.slice(0, 10).map((f) => `${f.rank}. [${f.severity}/${f.effort} effort] ${f.title} — ${f.fix}`),
        ].filter((l, i) => l !== '' || i > 1).join('\n');

        return {
          content: [{ type: 'text', text }, ...reports.flatMap((r) => reportLinks(r))],
          structuredContent: result,
        };
      } catch (err) {
        return errorResult(err, deps.log);
      } finally {
        release?.();
      }
    },
  );

  }

  /* ---- results of a run that was still going */
  if (auditTools.length) {
  auditTools.push('get_audit_results');
  server.registerTool(
    'get_audit_results',
    {
      title: 'Get results of an earlier audit run',
      description:
        'Fetches the status and results of an audit run that was still "running" when its tool returned (or any earlier run), by Apify runId. Does not start a new scan and costs nothing extra.',
      inputSchema: z.object({
        runId: z.string().regex(/^[A-Za-z0-9_-]{5,40}$/).describe('run.runId from an earlier result'),
        check: z.enum(CHECK_KEYS).describe('Which check the run belongs to (for parsing the results).'),
      }),
      outputSchema: CheckReportSchema,
      annotations: { title: 'Get audit results', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: metaFor({ invoking: 'Fetching audit results…', invoked: 'Results ready' }),
    },
    async ({ runId, check }, ctx): Promise<CallToolResult> => {
      try {
        const runner = runId.startsWith('dryrun-') ? deps.mockRunner : runnerFor();
        limiter.hit(auth.clientKey);
        const run = await runner.fetchRun({ runId, token: auth.token ?? '', apiKey: auth.apiKey, kind: 'check', signal: ctx.mcpReq.signal });
        const spec = ACTORS[check];
        const target = String((run.items[0] as { url?: string; domain?: string } | undefined)?.url ?? (run.items[0] as { domain?: string } | undefined)?.domain ?? 'unknown');
        const report = buildCheckReport(spec, target, run);
        return { content: [{ type: 'text', text: checkReportText(spec, report) }, ...reportLinks(report)], structuredContent: report };
      } catch (err) {
        return errorResult(err, deps.log);
      }
    },
  );

  }

  /* ---- data tools from the other finished Actors (toolsets web/marketing/leads/compliance/travel/property) */
  const dataTools = registerDataTools(
    server,
    deps,
    (name) => enabled(DATA_TOOLS.find((t) => t.name === name)!.toolsets, name),
    (spec?: DataToolSpec) => ({
      ...metaFor(),
      ...(spec ? { 'openai/toolInvocation/invoking': `Running ${spec.title.toLowerCase()}…`.slice(0, 64), 'openai/toolInvocation/invoked': 'Done' } : {}),
    }),
  );

  /* ---- ChatGPT / MCP Apps UI component for the audit tools */
  if (auditTools.length) {
    server.registerResource(
      'score-card',
      WIDGET_URI,
      { title: `${BRAND.name} score card`, description: 'Score card + findings list UI for audit results (MCP Apps / ChatGPT).', mimeType: WIDGET_MIME, _meta: WIDGET_RESOURCE_META },
      async () => ({ contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: WIDGET_HTML, _meta: WIDGET_RESOURCE_META }] }),
    );
  }

  registerResources(server, deps, [...auditTools, ...dataTools]);
  if (auditTools.length) registerPrompts(server);
  return server;
}

/* ---------------------------------------------------------------- resources */

function registerResources(server: McpServer, deps: ServerDeps, toolNames: string[]): void {
  const { config } = deps;
  const toolsUri = `${BRAND.uriScheme}://tools`;
  server.registerResource(
    'tools',
    toolsUri,
    { title: `${BRAND.name} tools, toolsets and Apify Actors`, description: 'Every data tool this connection exposes: toolsets, backing Actor, annotations, required user credentials and cost hint.', mimeType: 'application/json' },
    async () => ({
      contents: [
        {
          uri: toolsUri,
          mimeType: 'application/json',
          text: JSON.stringify(
            DATA_TOOLS.filter((t) => toolNames.includes(t.name)).map((t) => ({
              tool: t.name,
              title: t.title,
              toolsets: t.toolsets,
              actorId: actorIdFor(deps, t),
              readOnly: t.annotations.readOnlyHint,
              userCredentials: (t.secrets ?? []).map((x) => ({ env: `SITEVERDICT_SECRET_${x.name}`, header: `X-SiteVerdict-Secret-${x.name.replace(/_/g, '-')}`, label: x.label })),
              cost: t.costHint,
            })),
            null,
            2,
          ),
        },
      ],
    }),
  );
  const checksUri = `${BRAND.uriScheme}://checks`;
  server.registerResource(
    'checks',
    checksUri,
    { title: `${BRAND.name} checks and Apify Actors`, description: 'Which tool runs which Apify Actor, and what each check covers.', mimeType: 'application/json' },
    async () => ({
      contents: [
        {
          uri: checksUri,
          mimeType: 'application/json',
          text: JSON.stringify(
            Object.values(ACTORS).map((a) => ({ check: a.key, tool: a.tool, title: a.title, actorId: config.actorIds[a.key], storeUrl: `https://apify.com/${config.actorIds[a.key]}`, contract: a.contractStatus })),
            null,
            2,
          ),
        },
      ],
    }),
  );
  const guideUri = `${BRAND.uriScheme}://guide/scoring`;
  server.registerResource(
    'scoring-guide',
    guideUri,
    { title: 'How scores and fix priorities are calculated', description: 'Scoring, grading and fix-plan ranking method, plus billing notes.', mimeType: 'text/markdown' },
    async () => ({ contents: [{ uri: guideUri, mimeType: 'text/markdown', text: SCORING_GUIDE }] }),
  );
}

const SCORING_GUIDE = `# ${BRAND.name}: scoring and prioritisation

- Each check returns a 0–100 score from its Apify Actor. If an Actor gives none, the score is 100 minus 20/critical, 8/high, 3/medium, 1/low issue (floor 0).
- Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 55, F below.
- Overall score (full_website_audit) = weighted mean of completed checks: tracking & consent 1.2, speed & revenue 1.2, accessibility 1.1, domain/email 1.0, AI search 0.8.
- Fix plan rank = severity weight (critical 100, high 60, medium 30, low 10) × category weight (consent 1.25, accessibility 1.2, revenue 1.2, tracking/performance 1.15, email/security 1.1, others ≈1) × effort factor (low 1.2, medium 1, high 0.8) + up to 10 points for pages affected. Duplicate titles are merged.
- Automated checks find many but not all issues (especially for accessibility and legal compliance); they are not legal advice.

## Billing
Every scan is an Apify Actor run on the caller's own Apify account, billed by Apify pay-per-event. Runs carry a spend cap (maxTotalChargeUsd). Cancelling a tool call aborts the run.
`;

/* ------------------------------------------------------------------ prompts */

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'website_fix_plan',
    {
      title: 'Audit my website and give me a fix plan',
      description: 'Runs the full audit and turns it into a prioritised, plain-English action plan.',
      argsSchema: z.object({
        url: z.string().describe('Website to audit'),
        business: z.string().optional().describe('Optional: what the business does / who the site is for'),
      }),
    },
    ({ url, business }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Audit ${url} with the full_website_audit tool.${business ? ` Context: ${business}.` : ''} Then give me:\n` +
              '1) a 3-sentence executive summary for a non-technical owner,\n2) a fix plan grouped into "this week", "this month" and "later", each item with who should do it (developer, marketer, DNS admin) and expected impact,\n3) any legal-risk items (cookies/GDPR, accessibility) called out explicitly.\nDo not invent findings beyond the tool results; if the result says dryRun=true, say clearly that it is sample data.',
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'cookie_consent_check',
    {
      title: 'Is my cookie banner GDPR-compliant?',
      description: 'Checks tracking before consent / after reject and explains the fixes.',
      argsSchema: z.object({ url: z.string().describe('Website to check') }),
    },
    ({ url }) => ({
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: `Use audit_tracking_consent on ${url}. Explain which tags fire before consent or after "Reject", whether Google Consent Mode v2 is set up, and the exact GTM/CMP changes to fix each issue. Note this is not legal advice.` },
        },
      ],
    }),
  );
  server.registerPrompt(
    'prelaunch_check',
    {
      title: 'Pre-launch website checklist',
      description: 'Speed, accessibility, email/DNS and AI-search checks before a launch or redesign goes live.',
      argsSchema: z.object({ url: z.string().describe('Staging or live URL (must be publicly reachable)') }),
    },
    ({ url }) => ({
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: `Run full_website_audit on ${url} and turn the result into a go/no-go launch checklist: blockers (critical/high), should-fix, nice-to-have.` },
        },
      ],
    }),
  );
}

export { CHECK_BY_TOOL };
