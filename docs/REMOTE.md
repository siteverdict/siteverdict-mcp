# Remote mode: Streamable HTTP + OAuth 2.1 (built, tested on 127.0.0.1, NOT deployed)

Planned public URL: `https://mcp.webrevenuescan.com/mcp` (domain not registered yet). Nothing is deployed. Every step below needs the owner's approval.

## Endpoints

| Path | Purpose |
|---|---|
| `POST /mcp` | MCP Streamable HTTP. It is stateless: there are no sessions, and GET/DELETE return 405. 2026-07-28 clients are served natively and 2025-era clients through the SDK's stateless fallback. |
| `POST /mcp/<toolsets>` (e.g. `/mcp/travel`, `/mcp/web+leads`) or `/mcp?toolsets=…&tools=…` | Same endpoint with only some toolsets enabled for that connection |
| `GET /healthz`, `GET /health` | Liveness check: version, mode, OAuth on/off, default toolsets. No secrets. |
| `GET /.well-known/oauth-protected-resource[/mcp[/<toolsets>]]` | RFC 9728 Protected Resource Metadata. Path-aware; built with the SDK's `oauthMetadataResponse`. |
| `GET /.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | RFC 8414 Authorization Server metadata |
| `POST /oauth/register` | RFC 7591 Dynamic Client Registration. This is the fallback; the MCP 2026-07-28 spec deprecates DCR in favour of CIMD. |
| `GET/POST /oauth/authorize` | Consent page (server-rendered, no JS, CSP `frame-ancestors 'none'`) |
| `POST /oauth/token` | `authorization_code` (PKCE S256) and `refresh_token` (rotation). Accepts form-urlencoded or JSON. |
| `POST /oauth/revoke` | RFC 7009 |
| `GET /.well-known/openai-apps-challenge` | OpenAI domain verification. The token comes from `SITEVERDICT_OPENAI_APPS_CHALLENGE`. |

## Auth design

- **Resource server** (MCP spec, authorization): a request without credentials gets `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="siteverdict.tools"`. Access tokens are checked with the SDK's `verifyBearerToken`, which validates expiry, scope and **audience**. The audience is the RFC 8707 `resource`; a token issued for `/mcp` is refused on `/mcp/travel`.
- **Authorization server** (`src/oauth/`): built in, so no third-party IdP is needed.
  - Supports **CIMD** (`client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported` includes `none`). ChatGPT and Claude prefer it.
  - Supports **DCR** as the fallback, for public clients or `client_secret_post`/`_basic`.
  - Requires **PKCE S256**.
  - Adds **RFC 9207 `iss`** to the authorization response.
  - Matches `redirect_uri` exactly. The redirect host allow-list is optional (`SITEVERDICT_OAUTH_REDIRECT_HOSTS`); loopback is always allowed for Claude Code.
  - Authorization codes are single-use and last 120 s.
  - Refresh tokens rotate. Reusing an old refresh token revokes the whole token family.
- **What "sign in" means:** the consent page asks the user for **their own Apify API token**, so billing stays BYOK. If the SiteVerdict API backend is configured, it also accepts a SiteVerdict API key.
  - The token is checked against `api.apify.com/v2/users/me`, then **sealed with AES-256-GCM into the access token**.
  - Nothing is stored server-side and clients only ever hold ciphertext.
  - Keys rotate with `SITEVERDICT_OAUTH_KEYS="new,old"`.
  - Our OAuth tokens are never sent upstream (no token passthrough). Apify only ever receives the user's Apify token.
- **API-key fallback** (`SITEVERDICT_ALLOW_API_KEYS=1`, default on) accepts any of these:
  - `X-Apify-Token: apify_api_…`
  - `Authorization: Bearer apify_api_…`
  - `X-API-Key: sv_live_…`

  This serves Claude's "custom connection" headers, Cursor, scripts and MCP Inspector. Set it to `0` to require OAuth only.
- **Third-party keys for data tools** (Companies House, HMRC, Google, SERP providers…):
  - stdio: `SITEVERDICT_SECRET_<NAME>` env vars.
  - HTTP API-key mode: `X-SiteVerdict-Secret-<Name>` headers.
  - They are never tool arguments the model fills in, and they never appear in results or logs.
  - OAuth connections have no secret store yet, so those tools fall back to each Actor's labelled sample mode or to format-only checks. The owner can add a per-user encrypted secret store later.

## Hardening

- Host-header allow-list (DNS rebinding) and Origin allow-list on `/mcp`. Server-side clients send no Origin.
- CORS is echoed only for allowed browser origins. Discovery, token and register endpoints allow `*`, as public-client OAuth requires.
- Per-IP limit: `SITEVERDICT_IP_RATE_PER_MINUTE`, default 120. OAuth endpoints cost 4 per call.
- Per-user tool-call limit: `SITEVERDICT_RATE_LIMIT_PER_MINUTE`, default 20.
- Concurrent Actor runs per user: 6.
- Body limit `SITEVERDICT_MAX_BODY_BYTES` (256 KB). Larger requests get 413, including chunked bodies.
- Remote tool calls return within about 200 s, inside Claude's 240 s limit; longer runs return `running` plus a `runId`.
- Results are capped at `SITEVERDICT_MAX_RESULT_CHARS` (100k). Claude's limit is about 150k characters.
- SSRF guard on every URL input, including CIMD fetches: public hosts only, no redirects, 5 s timeout, 64 KB.

## Scaling (read before running more than one instance)

These are all **in-memory, per process**:
- rate limits
- single-use authorization-code tracking
- refresh-token and revocation lists
- the CIMD cache

Run **one instance** (PM2 `instances: 1`), or move these to Redis first. Also note that losing `SITEVERDICT_OAUTH_KEYS` logs every user out.

## Deploy (owner-approved, later)

1. Register `tools.webrevenuescan.com`. Point `mcp.webrevenuescan.com` at the host, then set up TLS (see `deploy/nginx-mcp.webrevenuescan.com.conf.example`), or use a Cloudflare Tunnel.
2. `cp .env.example .env`, generate `SITEVERDICT_OAUTH_KEYS`, and set `SITEVERDICT_PUBLIC_URL=https://mcp.webrevenuescan.com` and `SITEVERDICT_ALLOWED_HOSTS=mcp.webrevenuescan.com`.
3. Start it with **either** `pm2 start deploy/ecosystem.config.cjs` **or** `docker compose -f deploy/docker-compose.yml --env-file .env up -d --build`. Both bind to 127.0.0.1:3333.
4. Check it:
   - `curl https://mcp.webrevenuescan.com/healthz`
   - `npx @modelcontextprotocol/inspector`, then connect to the URL and complete the OAuth flow.
5. Claude's egress range `160.79.104.0/21` must reach both `/mcp` and `/oauth/*`, so don't block it at the firewall or WAF.
