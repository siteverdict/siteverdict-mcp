# ChatGPT app directory: submission checklist (prepared 11 Oct 2026, NOTHING submitted)

✅ means built here, ⛔ means the owner must act, 🟡 means a draft or placeholder is ready.

Requirements below were read on 11 Oct 2026 from:
- https://developers.openai.com/apps-sdk/reference (`_meta` keys, annotations)
- https://developers.openai.com/apps-sdk/build/chatgpt-ui (UI resource, `text/html;profile=mcp-app`)
- https://developers.openai.com/apps-sdk/build/auth (OAuth 2.1, CIMD, redirect URIs)
- https://developers.openai.com/apps-sdk/deploy/submission (submission package)
- https://developers.openai.com/apps-sdk/app-submission-guidelines (policy, rejection reasons)

## Technical (all testable locally, see `npm run smoke`)

- ✅ **Remote MCP over HTTPS, Streamable HTTP.** It is stateless and tested on 127.0.0.1. ⛔ It needs a public HTTPS host: `mcp.webrevenuescan.com`.
- ✅ **OAuth 2.1 with PKCE S256**, which the AS advertises in `code_challenge_methods_supported`.
  - CIMD is supported (`client_id_metadata_document_supported: true`), with DCR as the fallback.
  - RFC 9207 `iss` is included, so ChatGPT uses the redirect `https://chatgpt.com/connector_platform_oauth_redirect`.
  - PRM: `resource` plus `authorization_servers`. The `issuer` matches exactly, and the token audience is the `resource`.
  - Set `SITEVERDICT_OAUTH_REDIRECT_HOSTS=chatgpt.com,claude.ai,claude.com` in production, then copy the exact redirect URI from the OpenAI management page and check that it is allowed.
- ✅ Every tool explicitly sets `readOnlyHint`, `destructiveHint` and `openWorldHint` (and `idempotentHint`).
  - 4 tools are `readOnlyHint:false` because they save a private baseline in the user's own Apify storage: `monitor_website_changes`, `sec_filing_watch`, `reviews_monitor`, `seo_rank_check`.
  - None are destructive.
- ✅ **`securitySchemes`** is set per tool in `_meta` (`oauth2` with scope `siteverdict.tools`).
- ✅ **UI component** `ui://siteverdict/score-card-v1.html`:
  - mimeType `text/html;profile=mcp-app`, used by the 6 audit tools and `get_audit_results`
  - tool `_meta`: `ui.resourceUri` plus the alias `openai/outputTemplate`, and `openai/toolInvocation/invoking|invoked` (each 64 characters or fewer)
  - resource `_meta`: `ui.csp` (no external domains), `ui.domain`, `ui.prefersBorder`, `openai/widgetDescription` and the legacy `openai/widgetCSP`
  - The widget is self-contained (no network, no external scripts). It renders `structuredContent` from `ui/notifications/tool-result` or `window.openai.toolOutput`. It supports light and dark and escapes all text.
  - ⛔ Test it in ChatGPT developer mode. The MCP Apps `ui/initialize` handshake version string (`2026-01-26`) could not be verified against a live host.
- ✅ **Domain verification route** `/.well-known/openai-apps-challenge`. ⛔ Set `SITEVERDICT_OPENAI_APPS_CHALLENGE` to the token OpenAI gives you.
- ✅ **No request or trace IDs in results.** SiteVerdict API `request_id` is dropped. Apify `runId` is kept because it is needed to fetch long runs.
- ✅ **Data minimisation.** There is no chat history, no precise location and no government IDs. Passwords are never collected through tools; the Apify token is only entered on our own OAuth consent page. Reviewer names and e-mails are off by default.
- 🟡 **Which tools to expose.** Recommend listing **toolset `web` only** (`https://mcp.webrevenuescan.com/mcp`) at first:
  - It is coherent and needs no extra third-party keys.
  - The marketing, compliance and other toolsets need user API keys, which OAuth users cannot supply yet; they would return sample data, which reviewers may treat as "demo".
  - Leave `travel` out of the ChatGPT listing: the guidelines list "high-chargeback or abusive travel services" among prohibited services. Our travel tools are informational only, but they invite scrutiny.
  - Separate apps per toolset (e.g. `/mcp/compliance`) can be submitted later.

## Listing package (draft in `submission.json`)

- 🟡 `displayName` (30 characters or fewer): **"SiteVerdict Website Audit"** (25). The name must not end in "MCP" or "Plugin" and must not be a generic dictionary word.
- 🟡 `shortDescription` (30 characters or fewer): **"Fix plan for your website"** (25).
- 🟡 `longDescription` (4000 characters or fewer): in `submission.json`. It mentions no pricing or promotions and makes no competitor comparisons.
- ⛔ Category: suggest "Productivity" or "Developer tools". Pick from the live form.
- ⛔ HTTPS URLs:
  - `websiteURL` https://tools.webrevenuescan.com
  - `supportURL` (a page, or mailto aman.thakran@bharatfare.com)
  - `privacyPolicyURL` https://tools.webrevenuescan.com/privacy (publish the reviewed `PRIVACY.md`)
  - `termsOfServiceURL` https://tools.webrevenuescan.com/terms
- ⛔ **Logo:** square, at least 48×48. Use `marketplace/assets/icon-512.png` once final art exists.
- ✅ **Test cases (5 positive, 3 negative):** `TEST-CASES.md`.
- ⛔ **Demo recording URL** (`demo_recording_url`): screen-record ChatGPT running `full_website_audit` on a site the owner controls.
- ⛔ **Reviewer test account:**
  - no MFA, e-mail/SMS codes or magic links
  - an Apify account with credit and its token, so the reviewer can paste it on the consent page
  - with the Actors published under `clairvoyant_turtle`
  - Use a dedicated low-limit account, set a spend cap in Apify, and rotate the token after review.
- ⛔ **Org verification:** individual, or business (BharatFare Travel and Technologies Ltd). The submitter needs Owner or Apps Management Write.

## Policy review

- ✅ It is 13+ appropriate and contains no ads, upsells or checkout links. It sells no digital goods inside ChatGPT. Billing is the user's own Apify account; say so in plain words, without prices, in the description.
- ⚠ **"Unofficial connectors / scraping" rejection risk.**
  - The Actors load public pages like a browser, respect robots.txt and never bypass bot protection.
  - They also use official APIs (SEC, GLEIF, VIES, HMRC, Land Registry, GOV.UK).
  - Be ready to explain this. Our own website-audit checks are first-party functionality.
- ⚠ **"Trial/demo apps" rejection risk.** Do not submit while the Actors are unpublished, because the reviewer would only see dry-run or sample data.
- ⚠ **"Tool behaviour must match descriptions."** The descriptions mention Apify billing and spend caps, which is accurate. Re-check after every Actor change.
- After approval OpenAI rescans the server daily, so keep tool names and annotations stable.

## Owner steps (in order)

1. Publish the Actors.
2. Register the domain and deploy the remote endpoint (`docs/REMOTE.md`).
3. Publish the privacy policy and terms pages.
4. Final icon.
5. ChatGPT developer mode: Settings → Apps → Developer mode → add `https://mcp.webrevenuescan.com/mcp`. Run the 8 test cases and record the demo.
6. platform.openai.com/plugins → Submit, and paste from `submission.json`.
7. Domain verification token → `SITEVERDICT_OPENAI_APPS_CHALLENGE`.
8. Answer the review.
