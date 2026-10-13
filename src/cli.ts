#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { stdioAuth } from './auth.js';
import { BRAND, SERVER_VERSION } from './brand.js';
import { loadConfig } from './config.js';
import { buildDeps } from './deps.js';
import { describeHttp, startHttpServer } from './http.js';
import { createServer } from './server.js';

const HELP = `${BRAND.displayName} v${SERVER_VERSION}
${BRAND.tagline}

Usage:
  npx -y ${BRAND.npmPackage}            stdio transport (Claude Desktop, Claude Code, Cursor, VS Code, ...)
  npx -y ${BRAND.npmPackage} --http     Streamable HTTP on 127.0.0.1:3333/mcp (SITEVERDICT_HTTP_HOST/PORT/PATH)
  npx -y ${BRAND.npmPackage} --dry-run  sample data, no Apify calls (same as SITEVERDICT_DRY_RUN=1)
  --toolsets web,leads         tool groups: web (default), marketing, leads, compliance, travel, property, all
  --tools a,b                  explicit tool allow-list (overrides --toolsets)

Environment:
  APIFY_TOKEN                  your Apify API token (runs are billed to your Apify account)
  SITEVERDICT_DRY_RUN=1        use built-in sample data; no token needed
  SITEVERDICT_APIFY_USERNAME   Apify account that owns the Actors (default from brand.json)
  SITEVERDICT_ACTOR_<CHECK>    override one Actor ID, e.g. SITEVERDICT_ACTOR_ACCESSIBILITY=me/my-a11y
  SITEVERDICT_DEFAULT_MAX_CHARGE_USD  per-run spend cap forwarded to Apify (default 2)
  SITEVERDICT_TOOLSETS         same as --toolsets
  SITEVERDICT_SECRET_<NAME>    your own third-party keys for data tools (see siteverdict://tools)
  SITEVERDICT_OAUTH_ENABLED=1 + SITEVERDICT_PUBLIC_URL + SITEVERDICT_OAUTH_KEYS   remote OAuth (HTTP only)
  See README for all options.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(SERVER_VERSION + '\n');
    return;
  }
  if (argv.includes('--dry-run')) process.env.SITEVERDICT_DRY_RUN = '1';
  const flag = (name: string) => {
    const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (i < 0) return undefined;
    return argv[i]!.includes('=') ? argv[i]!.split('=').slice(1).join('=') : argv[i + 1];
  };
  const ts = flag('--toolsets');
  if (ts) process.env.SITEVERDICT_TOOLSETS = ts;
  const tl = flag('--tools');
  if (tl) process.env.SITEVERDICT_TOOLS = tl;
  const config = loadConfig();
  const deps = buildDeps(config);

  if (argv.includes('--http')) {
    const server = await startHttpServer(deps);
    deps.log?.(`listening on ${describeHttp(config)} (mode=${config.mode}${config.dryRun ? ', DRY RUN' : ''})`);
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  // stdio: logs go to stderr only (stdout carries the protocol).
  const auth = stdioAuth(config);
  if (!auth.token && !config.dryRun) deps.log?.('APIFY_TOKEN is not set: tools will explain how to add it. Use --dry-run for sample data.');
  const handle = serveStdio(() => createServer({ ...deps, auth }), { onerror: (e) => deps.log?.(`stdio: ${e.message}`) });
  const stop = () => void handle.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`[${BRAND.slug}] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
