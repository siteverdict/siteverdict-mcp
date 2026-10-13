# SiteVerdict — Website Audit Tools (MCP server)

Website audit tools for AI agents. Ask Claude, ChatGPT, Cursor or any MCP client to *"audit my website and tell me what to fix first"*. It runs real browser-based checks and returns a ranked fix plan:

| Tool | What it checks |
|---|---|
| `full_website_audit` | Runs every check below **in parallel**, then returns an overall score, an executive summary and **one prioritised fix list** |
| `audit_tracking_consent` | Cookie consent and GDPR / UK GDPR / PECR: tags that fire before consent or after "Reject", tracking cookies, Google Consent Mode v2, broken GA4/GTM tags, duplicate page_views |
| `scan_speed_and_revenue` | Core Web Vitals (LCP, INP, CLS, TTFB), page weight and bottlenecks, plus an estimate of **revenue lost to slow pages** if you give traffic and order value |
| `audit_accessibility_wcag` | WCAG 2.2 A/AA/AAA (axe-core), mapped to success criteria and to the European Accessibility Act / EN 301 549 |
| `check_domain_email_health` | MX, SPF, DKIM, DMARC, BIMI, MTA-STS, DNSSEC, CAA, TLS expiry, spoofing risk and Gmail/Yahoo bulk-sender gaps |
| `check_ai_search_readiness` | Can ChatGPT, Perplexity and Google AI Overviews read and cite you? Covers robots.txt AI bots, llms.txt, schema.org, rendering, canonical tags and sitemap |
| `get_audit_results` | Collects the results of a long scan that was still running, at no extra cost |

Prompts: `website_fix_plan`, `cookie_consent_check`, `prelaunch_check`. Resources: `siteverdict://checks`, `siteverdict://guide/scoring`.

## How billing works

Each check is an [Apify](https://apify.com) Actor. The server runs it **on your own Apify account** using your `APIFY_TOKEN`, and Apify bills you directly at its pay-per-event price. This server has no payments, no accounts and no stored data.

- Every run has a spend cap (`maxTotalChargeUsd`, default **$2**, configurable per call with `maxCostUsd`).
- If you cancel a tool call, the Apify run is aborted, so you stop paying.
- You can see run costs in your [Apify console](https://console.apify.com/billing).

Get a token at **https://console.apify.com/settings/integrations**. To try the tools without a token, set `SITEVERDICT_DRY_RUN=1`. Every result is then built-in **sample data** and is clearly labelled.

## Install

Requires Node.js 20+. Replace `apify_api_xxx` with your token.

### Claude Code
```bash
claude mcp add --env APIFY_TOKEN=apify_api_xxx --transport stdio siteverdict -- npx -y @siteverdict/mcp
```

### Claude Desktop
Go to Settings → Developer → Edit Config (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "siteverdict": {
      "command": "npx",
      "args": ["-y", "@siteverdict/mcp"],
      "env": { "APIFY_TOKEN": "apify_api_xxx" }
    }
  }
}
```
You can also install the one-click `.mcpb` bundle from the [Releases](https://github.com/siteverdict/siteverdict-mcp/releases) page. Claude Desktop asks for your token and stores it securely.

### Cursor
Add this to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):
```json
{
  "mcpServers": {
    "siteverdict": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@siteverdict/mcp"],
      "env": { "APIFY_TOKEN": "${env:APIFY_TOKEN}" }
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)
Add this to `.vscode/mcp.json`. VS Code prompts for the token once and stores it encrypted:
```json
{
  "inputs": [
    { "type": "promptString", "id": "apify-token", "description": "Apify API token", "password": true }
  ],
  "servers": {
    "siteverdict": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@siteverdict/mcp"],
      "env": { "APIFY_TOKEN": "${input:apify-token}" }
    }
  }
}
```
Or run: `code --add-mcp '{"name":"siteverdict","command":"npx","args":["-y","@siteverdict/mcp"],"env":{"APIFY_TOKEN":"${input:apify-token}"}}'`

### Windsurf / Devin Desktop
Add this to `~/.codeium/windsurf/mcp_config.json`. Newer builds use `~/.config/devin/mcp_config.json`, or `%APPDATA%\devin\mcp_config.json` on Windows:
```json
{
  "mcpServers": {
    "siteverdict": {
      "command": "npx",
      "args": ["-y", "@siteverdict/mcp"],
      "env": { "APIFY_TOKEN": "${env:APIFY_TOKEN}" }
    }
  }
}
```

### Cline
Install from the Cline MCP Marketplace once the listing is live, or add this to `cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "siteverdict": {
      "command": "npx",
      "args": ["-y", "@siteverdict/mcp"],
      "env": { "APIFY_TOKEN": "apify_api_xxx" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### OpenAI Codex CLI
```bash
codex mcp add siteverdict --env APIFY_TOKEN=apify_api_xxx -- npx -y @siteverdict/mcp
```
Or add this to `~/.codex/config.toml`:
```toml
[mcp_servers.siteverdict]
command = "npx"
args = ["-y", "@siteverdict/mcp"]
tool_timeout_sec = 600

[mcp_servers.siteverdict.env]
APIFY_TOKEN = "apify_api_xxx"
```
Scans can take a few minutes, so raise `tool_timeout_sec` from its default of 60.

### Gemini CLI
```bash
gemini mcp add -e APIFY_TOKEN=apify_api_xxx siteverdict npx -y @siteverdict/mcp
```

### ChatGPT and Claude (remote connector with OAuth)
These clients need a **remote** HTTPS URL. The server ships remote mode with OAuth 2.1: CIMD/DCR client registration, PKCE, and a sign-in page where you paste your own Apify token. It also has a ChatGPT/MCP Apps score-card UI. Once the owner deploys it, add `https://mcp.webrevenuescan.com/mcp` as a custom connector, or `/mcp/<toolsets>` such as `/mcp/web+compliance`. Design and deploy steps: [docs/REMOTE.md](docs/REMOTE.md). **Not deployed yet.**

### Docker
```bash
docker run -i --rm -e APIFY_TOKEN=apify_api_xxx mcp/siteverdict
```

### Remote / Streamable HTTP (self-hosted)
```bash
SITEVERDICT_HTTP_HOST=127.0.0.1 SITEVERDICT_HTTP_PORT=3333 npx -y @siteverdict/mcp --http
# endpoint: http://127.0.0.1:3333/mcp   health: /healthz
# each user sends their own token:  X-Apify-Token: apify_api_xxx   (or Authorization: Bearer apify_api_xxx)
claude mcp add --transport http siteverdict http://127.0.0.1:3333/mcp --header "X-Apify-Token: apify_api_xxx"
```
The server binds to localhost by default and validates `Host` and `Origin`. To serve it publicly, put it behind TLS and set `SITEVERDICT_ALLOWED_HOSTS` and `SITEVERDICT_ALLOWED_ORIGINS`.

## Toolsets (keep the tool list small)
The default is **`web`**: the 7 audit tools plus `detect_tech_stack`, `monitor_website_changes`, `fetch_clean_markdown` and `get_run_results`. To add more groups:
```bash
npx -y @siteverdict/mcp --toolsets web,compliance        # or SITEVERDICT_TOOLSETS=all
npx -y @siteverdict/mcp --tools sanctions_screen,uk_property_data   # explicit allow-list
```
| Toolset | Tools |
|---|---|
| `web` | full_website_audit, audit_tracking_consent, scan_speed_and_revenue, audit_accessibility_wcag, check_domain_email_health, check_ai_search_readiness, get_audit_results, detect_tech_stack, monitor_website_changes, fetch_clean_markdown |
| `marketing` | seo_rank_check, search_traffic_diagnose, google_ads_transparency, reviews_monitor |
| `leads` | find_local_businesses, company_registry_lookup, sec_filing_watch, sec_full_text_search, find_public_tenders, detect_tech_stack |
| `compliance` | sanctions_screen, validate_vat_or_company_number, extract_pdf_invoice, company_registry_lookup |
| `travel` | flight_fare_scan, flight_fare_estimate, flight_deal_alerts, check_flight_compensation, visa_entry_check |
| `property` | uk_property_data |

Some data tools can use **your own** third-party keys:
- stdio: `SITEVERDICT_SECRET_<NAME>` env vars
- HTTP: `X-SiteVerdict-Secret-<Name>` headers

Examples are `COMPANIES_HOUSE_API_KEY`, `HMRC_CLIENT_ID`, `GOOGLE_MAPS_API_KEY`, `SERPAPI_API_KEY` and `EPC_API_TOKEN`. The `siteverdict://tools` resource lists them all. Keys are never tool arguments and never appear in results. Without them, the tool uses the Actor's clearly labelled sample mode or format-only checks.

Full generated table: [marketplace/tools.md](marketplace/tools.md).

## Example prompts
- "Audit https://example.com and give me a fix plan for this week."
- "Is my cookie banner on example.co.uk GDPR-compliant? Does anything track before consent?"
- "How much revenue is my slow mobile site losing? I get 40k visits a month, a 2% conversion rate and a £70 average order."
- "Check example.com against WCAG 2.2 AA and tell me what the European Accessibility Act means for us."
- "Can people spoof email from our domain? Check SPF, DKIM and DMARC for example.com."
- "Will ChatGPT and Perplexity cite our site? Check AI-search readiness."

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `APIFY_TOKEN` | — | Your Apify token (stdio mode) |
| `SITEVERDICT_DRY_RUN` | `0` | `1` returns sample data with no Apify calls |
| `SITEVERDICT_DEFAULT_MAX_CHARGE_USD` | `2` | Spend cap per Actor run |
| `SITEVERDICT_DEFAULT_WAIT_SECS` / `SITEVERDICT_MAX_WAIT_SECS` | `240` / `900` | How long a call waits before returning `running` plus a `runId` |
| `SITEVERDICT_RATE_LIMIT_PER_MINUTE` | `20` | Tool calls per minute per client |
| `SITEVERDICT_MAX_CONCURRENT_RUNS` | `6` | Concurrent Actor runs per client |
| `SITEVERDICT_APIFY_USERNAME` | from `brand.json` | Apify account that owns the Actors |
| `SITEVERDICT_ACTOR_TRACKING_CONSENT`, `..._SPEED_REVENUE`, `..._ACCESSIBILITY`, `..._DOMAIN_EMAIL`, `..._AI_SEARCH` | `<username>/siteverdict-…` | Override individual Actor IDs |
| `SITEVERDICT_DNS_CHECK` | `1` | Resolve hostnames and reject private addresses (SSRF guard) |
| `SITEVERDICT_HTTP_HOST` / `_PORT` / `_PATH` | `127.0.0.1` / `3333` / `/mcp` | HTTP mode |
| `SITEVERDICT_ALLOWED_HOSTS` / `_ORIGINS` | localhost | Comma lists for public HTTP deployments |

## Safety
- **Read-only.** No tool changes your site. Every tool is annotated `readOnlyHint: true, destructiveHint: false, openWorldHint: true`.
- **Public targets only.** Private, loopback, link-local, CGNAT, cloud-metadata and reserved IPs, internal hostnames, non-http(s) schemes, credentials in URLs and odd ports are all rejected. Hostnames that resolve to private addresses are rejected too.
- **Tokens stay with Apify.** Tokens are sent only to `api.apify.com` in an `Authorization` header. They are never logged and never placed in URLs.
- **Limits.** Calls are rate-limited and concurrent runs are capped per client. Every run has a spend cap. Cancelling a call aborts its run.

## Development
```bash
npm install
npm run typecheck && npm run lint && npm test   # unit + integration tests (mocked Apify, no network)
npm run smoke                                   # builds, then drives dist/cli.js over real stdio
npm run inspector                               # MCP Inspector UI against the dry-run server
SITEVERDICT_DRY_RUN=1 npm run dev               # stdio from source
```
To rename the brand, edit `brand.json` and run `npm run brand:sync`.

Built on the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server`). It serves both the 2026-07-28 protocol and 2025-era clients.

## Privacy & terms
See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md). Both are drafts until reviewed. Support: [GitHub issues](https://github.com/siteverdict/siteverdict-mcp/issues).
