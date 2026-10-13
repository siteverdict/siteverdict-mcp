# Changelog

## 0.2.0 — unreleased (prepared 2026-10-11, directory-ready build)
- **21 new data tools** from every finished Actor that has an MCP-TOOL.md (18 Actors), plus `get_run_results`. That makes 29 tools in total.
- **Toolsets**: `web` (default), `marketing`, `leads`, `compliance`, `travel`, `property`, `all`. Select them with `--toolsets`, `SITEVERDICT_TOOLSETS`, `/mcp/<toolsets>` or `?toolsets=`. `--tools` / `?tools=` is an explicit allow-list.
- **Remote mode**: OAuth 2.1 with a built-in authorization server:
  - CIMD and DCR client registration
  - PKCE S256, RFC 8707 resource binding, RFC 9207 `iss`, refresh rotation
  - the user's Apify token sealed with AES-GCM into the access token
  - PRM and AS metadata
  - API-key fallback
- **Remote hardening**: CORS, per-IP rate limit, 256 KB body limit, `/health`, remote waits capped at 200 s, result size cap.
- **ChatGPT Apps SDK / MCP Apps**: score-card UI resource (`text/html;profile=mcp-app`), tool `_meta` (`ui.resourceUri`, `openai/outputTemplate`, invocation strings), `securitySchemes`, and the `/.well-known/openai-apps-challenge` route.
- **Optional SiteVerdict API backend** (`SITEVERDICT_BACKEND=api|auto`, API-CONTRACT v1).
- **Packaging**: `deploy/` (PM2, docker-compose, nginx example), `.env.example`, MCPB manifest updated (validates), and directory checklists in `marketplace/openai` and `marketplace/anthropic`.
- Support contact is now aman.thakran@bharatfare.com.

## 0.1.0 — unreleased (prepared 2026-10-11)
- First version: 7 tools (`full_website_audit`, `audit_tracking_consent`, `scan_speed_and_revenue`, `audit_accessibility_wcag`, `check_domain_email_health`, `check_ai_search_readiness`, `get_audit_results`), 3 prompts and 2 resources.
- Transports: stdio and Streamable HTTP, both built from one codebase on MCP TypeScript SDK v2. Supports protocol 2026-07-28 plus the 2025-era legacy fallback.
- Billing: BYOK through Apify (pay-per-event on the user's account), with a spend cap per run, run abort on cancellation, and a hand-off to `get_audit_results` for long scans.
- Safety: SSRF guard (IP literals, internal names and DNS resolution), Host/Origin validation, per-client rate and concurrency limits, token redaction.
- Dry-run mode with labelled sample data.
