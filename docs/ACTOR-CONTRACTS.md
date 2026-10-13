# Actor contracts (MCP server ⇄ Apify Actors)

Code: `src/actors.ts` maps tool input to Actor input, and `src/report.ts` (`normaliseItems`) maps Actor dataset items back to the tool output.
Actor IDs are `<SITEVERDICT_APIFY_USERNAME>/<name>`. You can override each one with `SITEVERDICT_ACTOR_<CHECK>`.

| Check key | Tool | Actor name | Contract status (11 Oct 2026) |
|---|---|---|---|
| `tracking_consent` | `audit_tracking_consent` | `siteverdict-tracking-consent-auditor` | **ALIGNED** with its `.actor/input_schema.json` and `dataset_schema.json` |
| `speed_revenue` | `scan_speed_and_revenue` | `siteverdict-speed-revenue-scanner` | PROPOSED (the Actor has no schema yet) |
| `accessibility` | `audit_accessibility_wcag` | `siteverdict-accessibility-auditor` | PROPOSED (folder `accessibility-auditor` has no `.actor/` yet) |
| `domain_email` | `check_domain_email_health` | `siteverdict-domain-email-health` | PROPOSED |
| `ai_search` | `check_ai_search_readiness` | `siteverdict-ai-search-readiness` | PROPOSED |

## Run options the server always sends
`POST /v2/acts/{user}~{name}/runs?timeout=<runTimeoutSecs>&memory=<MB>&maxTotalChargeUsd=<cap>`, authenticated with `Authorization: Bearer <user token>`.

The `maxTotalChargeUsd` parameter only limits pay-per-event Actors. Actors must charge events through `Actor.charge()` and stop once the limit is reached, which the Apify SDK signals.

## Input the server sends

```jsonc
// tracking_consent (ALIGNED)
{ "startUrls": [{ "url": "https://example.com/" }], "scanMode": "full|quick", "maxInternalPages": 0-10,
  "locale": "en-GB", "timezoneId": "Europe/London", "saveScreenshots": true }

// speed_revenue (PROPOSED)
{ "startUrls": [{ "url": "..." }], "device": "mobile|desktop", "maxPages": 1-20,
  "monthlyVisitors"?: int, "averageOrderValue"?: number, "conversionRatePct"?: number, "currency": "USD" }

// accessibility (PROPOSED)
{ "startUrls": [{ "url": "..." }], "maxPages": 1-50, "wcagLevel": "A|AA|AAA", "includeBestPractices": false }

// domain_email (PROPOSED)
{ "domains": ["example.com"], "dkimSelectors"?: ["google", "selector1"] }

// ai_search (PROPOSED)
{ "startUrls": [{ "url": "..." }], "maxPages": 1-25 }
```
If an Actor chooses different field names, change only that Actor's `buildActorInput` in `src/actors.ts` and the matching test in `test/server.test.ts`.

## Dataset output the server understands (in order of preference)

1. **Recommended:** one item `{"type":"summary", ...}` plus N items `{"type":"finding", ...}`.
2. **One item per URL with arrays.** Each item carries `findings[]`, `issues[]`, `violations[]` (axe-core), `problems[]` or `recommendations[]`. This is the tracking-consent Actor's shape.

Summary fields read: `score` (0–100, or 0–1), also `overallScore` or `scores.overall`. Also `grade`, `summary` (one sentence), `metrics` (object), and `reportUrl` (a public HTML or JSON report URL; otherwise the run's KV `OUTPUT` record is linked).

Finding fields read, with aliases:

| Output | Accepted input keys |
|---|---|
| `id` | `id`, `ruleId`, `code`, `check` |
| `title` | `title`, `help`, `name`, `message` |
| `severity` | `severity` / `impact` / `level` / `priority`: critical\|high\|medium\|low\|info, plus axe critical\|serious\|moderate\|minor, plus a 0–10 number |
| `category` | `category` / `type` / `group` (free text is mapped: consent, tracking, performance, revenue, accessibility, email, dns, security, ai-search, seo) |
| `fix` | `fix`, `recommendation`, `remediation`, `howToFix` |
| `detail` | `detail`, `description`, `message` |
| `impact` | `businessImpact`, or `estimatedMonthlyRevenueLoss` / `revenueImpactPerMonth` (a number) |
| `effort` | `effort`: low\|medium\|high (also easy/quick, hard/complex) |
| `standard` | `standard`, `wcag`, `reference`, or axe `tags` matching `wcag*` |
| `pages` | `pages[]`, `urls[]`, `affectedUrls[]`, `url`, `pageUrl` |
| `helpUrl` | `helpUrl`, `docsUrl`, `learnMoreUrl` |

If an Actor returns no score, the server derives one as 100 − 20×critical − 8×high − 3×medium − 1×low, with a floor of 0. Ask the Actor owners to emit a real score.

## Asks for the Actor builders
- Accept the input fields above, or tell the MCP owner your names.
- Emit `score`, `summary`, and a short `fix` per finding. Emit `effort` where you know it, because it improves the fix-plan ranking.
- Put a public `reportUrl` in the summary item, and store the full report in the default KV store as `OUTPUT` (or `report.html`).
- Charge pay-per-event with clear event names, and respect `maxTotalChargeUsd`.
