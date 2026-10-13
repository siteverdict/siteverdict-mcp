# Listing copy — SiteVerdict MCP

The copy is honest and specific. It contains no superlatives we can't prove, no fake numbers and no keyword stuffing. Use the same core text everywhere so the listings stay consistent.

## Core assets

**Name:** SiteVerdict
**Display title (≤100):** SiteVerdict — Website Audit Tools
**One-liner (≤100, used for the registry, npm and short fields):**
Website audits for AI agents: GDPR consent, speed, WCAG, SPF/DMARC and AI-search readiness. *(92 characters)*

**Short description (≤200):**
AI-assistant website audits: cookie consent and tracking, Core Web Vitals and lost revenue, WCAG 2.2, email/DNS security and AI-search readiness, merged into one prioritised fix plan. *(183 characters)*

**Long description (≤2000):**
SiteVerdict gives AI agents seven website-audit tools backed by real browser-based Apify Actors.

- full_website_audit runs all checks in parallel and merges them into an overall score, an executive summary and a single fix list. The list is ranked by severity, legal and revenue impact, and effort.
- audit_tracking_consent loads the site three ways (no click, Reject, Accept all). It shows which analytics and ad tags fire before consent or after Reject, checks Google Consent Mode v2, and finds broken GA4/GTM tags and duplicate page_views.
- scan_speed_and_revenue measures LCP, INP, CLS and TTFB and finds the heaviest bottlenecks. If you give it traffic and order value, it estimates the revenue lost to slow pages.
- audit_accessibility_wcag runs axe-core WCAG 2.2 A/AA/AAA checks, mapped to success criteria and to the European Accessibility Act / EN 301 549.
- check_domain_email_health checks MX, SPF, DKIM, DMARC, BIMI, MTA-STS, DNSSEC, CAA and TLS expiry. It flags spoofing risk and gives the exact DNS records to add.
- check_ai_search_readiness checks whether ChatGPT, Perplexity and Google AI Overviews can crawl, read and cite the site: robots.txt AI bots, llms.txt, schema.org and rendering.

Scans run on your own Apify account with your APIFY_TOKEN and are billed by Apify pay-per-event. Every run has a spend cap, and cancelling a call aborts its run. All tools are read-only. Private and internal addresses are blocked. Try it without a token with SITEVERDICT_DRY_RUN=1, which returns clearly-labelled sample data.

Works with Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Cline, Codex and Gemini CLI, over stdio or Streamable HTTP. Automated checks find many issues but not all of them, and they are not legal advice.

**Categories (pick per site):** Developer Tools · SEO / Marketing · Security · Accessibility · Analytics · Web
**Keywords/tags (≤10, only true ones):** website audit, GDPR, cookie consent, Core Web Vitals, WCAG, accessibility, DMARC, SPF, AI search, Apify

**Example prompts (use 3–5 per listing):**
1. "Audit https://example.com and give me a fix plan for this week."
2. "Does anything on example.co.uk track visitors before they accept cookies?"
3. "How much revenue is my slow mobile site losing? 40k visits/month, 2% conversion, £70 AOV."
4. "Check example.com against WCAG 2.2 AA."
5. "Can someone spoof email from our domain? Check SPF, DKIM and DMARC."
6. "Will ChatGPT and Perplexity cite our site?"

**Screenshots to capture** (1280×800 PNG; use a site the owner controls or has permission to scan, e.g. a BharatFare/AmanOS page, never a third party shown in a bad light):
1. Claude Desktop: the `website_fix_plan` prompt → overall score and the top-5 fix plan.
2. Cookie-consent result showing "fires before consent" and the GTM fix.
3. Speed result with LCP and the revenue-loss estimate.
4. Accessibility result listing WCAG criteria.
5. DMARC/SPF result with the exact DNS record to add.
6. Cursor or VS Code tool list showing the 7 tools.
7. The full HTML report opened from the resource link.

**Demo video (60–90 s):** install with one command → ask "audit my site" → progress updates → fix plan → open the full report → show the Apify cost (cents) and the spend cap.

## Per-marketplace fields

| Marketplace | Title | Short | Long | Other |
|---|---|---|---|---|
| Official Registry | `title` = display title | `description` = one-liner (92 chars) | — | Built from `server.json` |
| npm | package `@siteverdict/mcp` | package.json `description` | README | keywords from package.json |
| Smithery | SiteVerdict | short description | long description | config schema: `apifyToken` (required), `dryRun`, `maxChargeUsd` |
| Glama | auto from repo | auto from README | README | `glama.json` maintainers |
| mcp.so | SiteVerdict — Website Audit Tools | short description | long description | type "MCP Server"; tags = keywords |
| MCP Market | SiteVerdict | short description | long description | categories: Developer Tools, Marketing |
| Cline | SiteVerdict | "reason for adding": *Agent-native website audits (consent, speed, WCAG, email/DNS, AI search) with one prioritised fix plan; BYOK billing through Apify; read-only; SSRF-safe.* | — | 400×400 PNG |
| Docker Catalog | SiteVerdict | `about.description` in server.yaml | README | category devops |
| Claude directory | SiteVerdict — Website Audit Tools | short description (≤200) | long description (≤2000) | 1–5 categories; test account |
| ChatGPT directory | SiteVerdict (no "MCP"/"Plugin" suffix) | short description | long description | 5 positive and 3 negative test cases (below) |

## Test cases (for directory reviewers)
Positive:
1. "Audit https://example.com" → full_website_audit, fix plan returned.
2. "Check DMARC for example.com" → check_domain_email_health.
3. "Is my cookie banner compliant? https://example.com" → audit_tracking_consent.
4. "Check WCAG AA on https://example.com/contact" → audit_accessibility_wcag.
5. "Is my site ready for AI search?" with a URL → check_ai_search_readiness.

Negative:
1. "Scan http://192.168.1.1" → refused (private address).
2. "Audit file:///etc/passwd" → refused (scheme).
3. A request with no Apify token → a clear setup message and no run started.
