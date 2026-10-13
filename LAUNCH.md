# LAUNCH.md — honest growth plan for SiteVerdict MCP

**Goal:** be the obvious, best-documented website-audit server for AI agents, listed everywhere agents look for tools.

**Not allowed:** fake reviews or stars, sock-puppet accounts, vote rings, mass DMs, spam comments, keyword stuffing, or scanning third-party sites to shame them publicly.

## Why we can win this niche
- The Apify Store and MCP directories have many narrow single-check tools: llms.txt checkers, DMARC checkers, axe wrappers. We found **no** server that combines consent, speed/revenue, WCAG, email/DNS and AI-search into **one ranked fix plan for agents**. That combination is the pitch. Re-check this claim before each post and never overstate it.
- The tools do real browser work: three-scenario consent testing and axe in Playwright. They are read-only, SSRF-safe and spend-capped, which reviewers and security-minded users value.

## Phase 0 — make it real (before ANY listing)
1. Get all five Actors live on Apify, then test them end-to-end with a real token on 10 different sites the owner controls or has permission to scan. Fix normalisation gaps in `docs/ACTOR-CONTRACTS.md`.
2. Decide the licence, make the GitHub org and repo public, publish to npm, and tag `v0.1.0` with release notes. Attach the `.mcpb` bundle to the release.
3. Write a README GIF and record the 60–90 s demo video (`marketplace/LISTINGS.md`).
4. Set up issue templates (bug / Actor contract / feature) and commit to a **48-hour first response** on issues. Directory reviewers and Glama look at maintenance.

## Phase 1 — distribution in the right order (week 1)
Order chosen for maximum compounding reach:
1. **Official MCP Registry.** It feeds PulseMCP and other aggregators and possibly VS Code's gallery, so one publish reaches many surfaces.
2. **npm**, which must precede the registry publish because the registry verifies `mcpName`.
3. **Apify Store Actor READMEs.** Add a "Use from AI agents" section to each, linking `npx @siteverdict/mcp` and `mcp.apify.com?tools=…`. This is the highest-intent traffic, since people are already on Apify looking for these checks.
4. **Docker MCP Catalog PR.** It gives visibility inside Docker Desktop's MCP Toolkit and Docker builds the image.
5. **Glama claim** plus a good grade (licence, release, Dockerfile).
6. **Cline Marketplace issue.** Run a real Cline install test first.
7. **mcp.so** and **MCP Market** (free queue).
8. **Smithery** via the MCPB bundle.
9. **Claude plugin** submission (local server). The remote Claude connector and the ChatGPT app wait for OAuth hosting.

## Phase 2 — content that earns attention (weeks 2–4)
Each piece must teach something useful on its own.
- **Blog posts on tools.webrevenuescan.com (or dev.to / Hashnode with a canonical link):**
  - "We loaded 50 of our own and our clients' sites with Reject all: here's what still tracked". Use only sites you have permission to publish, or anonymise them.
  - "Consent Mode v2 in 2026: the 4 signals and the GTM mistakes that break them".
  - "What the European Accessibility Act means for small e-commerce sites".
  - "Let Claude audit your website in 60 seconds" (tutorial with the demo video).
- **Show HN:** "Show HN: SiteVerdict – website audits as MCP tools (consent, speed, WCAG, DMARC)".
  - Post once, as the maker, on a weekday morning US time. Link to the GitHub repo, not a landing page.
  - Answer every comment. Do not ask anyone to upvote; HN penalises vote solicitation.
- **Product Hunt:** launch once there is a hosted or one-click path (the MCPB bundle). Prepare a maker comment, gallery from the screenshot list, and the video. Notify your own existing contacts once. No vote-for-vote groups.
- **Reddit:** read each subreddit's rules first, and use self-promo days or threads where required. Candidate subreddits: r/mcp, r/ClaudeAI, r/webdev (Showoff Saturday), r/SEO, r/GoogleTagManager, r/accessibility (only a genuinely helpful post about EAA, with the tool mentioned in context), r/sysadmin (DMARC topic, only if allowed). Use one account, disclose that you built it, and share one post per community.
- **Communities:** the MCP Discord and GitHub discussions (share in the showcase channels only), the Apify Discord and community forum, and Indie Hackers (build-in-public post with real numbers).
- **Newsletters and lists:** submit to MCP-focused newsletters and to "awesome-mcp-servers" lists through a normal PR that follows each list's format. One PR per list, and accept rejection.

## Phase 3 — compounding (ongoing)
- **Be fastest to fix:** ship a release within days of real issues. Keep a public CHANGELOG.
- **Examples repo or gallery:** prompt recipes ("pre-launch checklist", "agency weekly client audit", "DMARC rollout") as copy-paste prompts and MCP prompt templates.
- **Integrations people ask for:** a scheduled audit through Apify Schedules, and a CSV/Sheets export. Build only what issues show demand for.
- **Hosted OAuth endpoint** when there is demand. This unlocks the Claude Connectors Directory and the ChatGPT apps directory, both very high reach (`docs/HOSTED-MODE.md`).
- **Measure:** npm weekly downloads, registry/Glama page views, GitHub stars (organic only), Apify Actor runs from MCP (use a `source` tag in run metadata if the Actors log it), and issue response time.

## Messaging rules
- Say "automated checks find many issues but not all; not legal advice" wherever compliance is mentioned.
- Never claim a site "is GDPR-compliant" or "WCAG-compliant" based on a scan.
- Revenue-loss numbers are **estimates from user-supplied inputs**; label them that way.
- Billing is BYOK through Apify; say so up front, so no user is surprised by a charge.

## Directory launch: ChatGPT app directory and Claude connector directory (prepared 11 Oct 2026, nothing submitted)

**Built and tested locally:**
- remote Streamable HTTP
- a built-in OAuth 2.1 authorization server
- the score-card UI component
- annotations and `securitySchemes` on every tool
- toolsets
- deploy configs

Tests cover stdio, HTTP with an API key, and HTTP with OAuth (`npm run smoke`).

**Checklists:**
- [`marketplace/openai/CHECKLIST.md`](marketplace/openai/CHECKLIST.md), plus [`submission.json`](marketplace/openai/submission.json) and [`TEST-CASES.md`](marketplace/openai/TEST-CASES.md)
- [`marketplace/anthropic/CHECKLIST.md`](marketplace/anthropic/CHECKLIST.md), which includes the listing draft
- Design and deploy: [`docs/REMOTE.md`](docs/REMOTE.md)

**Order:**
1. Publish the Actors.
2. Register the domain and set up TLS.
3. Deploy (PM2 or Docker, one instance).
4. Publish the privacy policy and terms pages.
5. Test in ChatGPT developer mode and with a Claude custom connector.
6. Record the demo.
7. Submit to Claude (no domain proof needed).
8. Submit to OpenAI (domain challenge plus org verification).

Recommendation: list **toolset `web` only** first. The other toolsets need users' own API keys, which OAuth users cannot supply yet. Also, OpenAI scrutinises travel services.

### Requirements sources (read 11 Oct 2026)

**MCP specification (current version 2026-07-28)**
- https://modelcontextprotocol.io/specification/versioning
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration (CIMD preferred; DCR deprecated)
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations (PKCE S256, `iss`)
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/changelog

**OpenAI Apps SDK / ChatGPT plugins**
- https://developers.openai.com/apps-sdk/reference
- https://developers.openai.com/apps-sdk/build/chatgpt-ui
- https://developers.openai.com/apps-sdk/build/auth
- https://developers.openai.com/apps-sdk/deploy/submission
- https://developers.openai.com/apps-sdk/app-submission-guidelines

**Anthropic**
- https://claude.com/docs/connectors/building/submission
- https://claude.com/docs/connectors/building/review-criteria
- https://claude.com/docs/connectors/building/authentication
- https://claude.com/docs/connectors/building/index.md
- https://claude.com/docs/connectors/building/mcpb.md
- https://claude.com/docs/connectors/directory
- https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms
- https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy
- https://platform.claude.com/docs/en/api/ip-addresses

**MCPB**
- https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md

**Not verified:**
- the MCP Apps `ui/initialize` protocol-version string used by the widget
- the ChatGPT review timeline
- whether Claude renders MCP Apps UI for third-party connectors

Test these live in developer mode before submitting.
