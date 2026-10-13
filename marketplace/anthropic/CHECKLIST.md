# Claude connector directory: checklist and listing (prepared 11 Oct 2026, NOTHING submitted)

Sources, read on 11 Oct 2026:
- Submission: https://claude.com/docs/connectors/building/submission
- Review criteria: https://claude.com/docs/connectors/building/review-criteria
- Authentication: https://claude.com/docs/connectors/building/authentication
- Limits and transports: https://claude.com/docs/connectors/building/index.md
- MCPB status: https://claude.com/docs/connectors/building/mcpb.md
- Directory terms: https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms
- Directory policy: https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy
- Claude egress IPs: https://platform.claude.com/docs/en/api/ip-addresses

## Requirements

| Requirement | Status |
|---|---|
| Remote MCP over HTTPS (Streamable HTTP) | ✅ built and tested on 127.0.0.1 · ⛔ needs `mcp.webrevenuescan.com` |
| Every tool has a `title` and `readOnlyHint`/`destructiveHint` | ✅ all 29 tools, plus `idempotentHint`/`openWorldHint` (enforced by unit tests) |
| Tool names of 64 characters or fewer, and no catch-all "api_request" tool | ✅ the longest is `validate_vat_or_company_number` (30) |
| No prompt-injection wording in descriptions; actionable errors | ✅ covered by tests (negative cases return specific, fixable messages) |
| OAuth for authenticated services | ✅ built-in AS: CIMD is advertised together with `none` in `token_endpoint_auth_methods_supported`, which Claude requires before it will use CIMD; DCR is the fallback; PKCE S256; RFC 8707 `resource`; refresh rotation; `invalid_grant` on dead refresh tokens; form-urlencoded token endpoint |
| Callback `https://claude.ai/api/mcp/auth_callback` | ✅ any exact https redirect is accepted; add `claude.ai` to `SITEVERDICT_OAUTH_REDIRECT_HOSTS` if that allow-list is used |
| Claude Code loopback `http://localhost/callback` and `http://127.0.0.1/callback` on any port | ✅ loopback is always allowed |
| A 401 starts sign-in | ✅ returns `401` with `WWW-Authenticate: Bearer resource_metadata=…, scope="siteverdict.tools"` |
| PRM `resource` must equal the URL the user enters | ✅ `https://mcp.webrevenuescan.com/mcp`. Tell users to paste exactly that URL (or `/mcp/<toolsets>`, which has its own PRM) |
| Discovery, registration and token endpoints answer within 10 s; refresh within 30 s | ✅ all local work. The Apify token check on the consent page has an 8 s timeout and runs in the user's browser flow, not in token calls |
| Allow Claude egress `160.79.104.0/21` to `/mcp` and `/oauth/*` | ⛔ firewall/WAF at deploy time |
| Tool result size about 150k characters (Claude Code 25k tokens); tool timeout 240 s | ✅ results capped at 100k characters (configurable); remote calls return by about 200 s with `runId` handover |
| Documentation URL | 🟡 GitHub README `https://github.com/siteverdict/siteverdict-mcp#readme` (repo not public yet ⛔) |
| Privacy policy URL | ⛔ publish the reviewed `PRIVACY.md` at https://tools.webrevenuescan.com/privacy |
| Support contact | ✅ aman.thakran@bharatfare.com |
| Icon | ⛔ final art (`marketplace/assets/`) |
| Fully populated test account | ⛔ a dedicated Apify account with credit and the Actors published; give its token to the reviewer and rotate it after review |
| 7 compliance acknowledgements | ⛔ the owner ticks them in the form after reading the directory terms and policy |
| MCP App screenshots: 3–5 PNGs, at least 1000 px wide | ⛔ capture the score card in Claude, once Claude supports MCP Apps for this server |
| "Must call first-party APIs" | ⚠ The tools call **our own** Apify Actors (first-party for SiteVerdict). Some Actors read third-party public or official sources. Explain this in the submission, and do not list toolsets whose main value is someone else's API. |
| Not accepted: money transfer, crypto, AI media generation | ✅ none of these |

**MCPB / desktop extensions:** the directory no longer accepts MCPB listings; local servers ship inside a **Claude plugin**. `manifest.json` (manifest_version 0.3) is kept for one-click installs from GitHub Releases. It validates with `npx @anthropic-ai/mcpb@2.1.2 validate manifest.json` (PASS, 11 Oct 2026). The repo already has a 0.4 schema; move to it when the CLI does.

## Listing draft (portal: claude.ai/directory/manage → Submit new → MCP connector)

- **Name** (100 characters or fewer): SiteVerdict: Website Audits
- **Slug** (permanent: choose carefully): `siteverdict`
- **One-liner** (200 characters or fewer): Audit any website for cookie-consent/GDPR issues, speed and lost revenue, WCAG accessibility, SPF/DMARC and AI-search readiness, and get one prioritised fix plan.
- **Description** (2,000 characters or fewer):
  > SiteVerdict gives Claude read-only website audit tools. Ask "audit my site and tell me what to fix first" and Claude runs consent/tracking, speed, accessibility (WCAG 2.2 / European Accessibility Act), domain/email (SPF, DKIM, DMARC, TLS) and AI-search readiness checks in parallel. It then merges them into a score, an executive summary and one ranked fix plan with concrete steps.
  >
  > You can also detect a site's technology stack, watch pages for changes and uptime, and fetch any public page as clean Markdown with a citation.
  >
  > Optional toolsets add sanctions screening, VAT and company-number validation, UK/EU public tenders, company registries (SEC EDGAR, GLEIF), UK property data and travel tools. Connect them with a URL such as https://mcp.webrevenuescan.com/mcp/compliance.
  >
  > Scans run as Apify Actors on your own Apify account, which you link when you sign in. Each run has a spend cap, and cancelling a call stops the run. Nothing on your website is changed.
  >
  > Automated checks find many issues but not all and are not legal advice.
  >
  > Operated by BharatFare Travel and Technologies Ltd, Plymouth, UK.
- **Categories** (1–5): Developer tools · Marketing · Productivity (pick from the live list)
- **Server URL:** https://mcp.webrevenuescan.com/mcp
- **Auth:** OAuth (CIMD/DCR). Alternative for power users: "custom connection" with the header `X-Apify-Token`.

## Owner steps

1. Publish the Actors, make the repo public, and publish the privacy policy and terms pages.
2. Deploy the remote endpoint (`docs/REMOTE.md`).
3. Claude → Settings → Connectors → Add custom connector `https://mcp.webrevenuescan.com/mcp`. Complete OAuth, then run `marketplace/openai/TEST-CASES.md`.
4. Submit in the portal (needs a paid Claude plan; on Team/Enterprise an Owner submits).
5. Escalations: mcp-review@anthropic.com.
