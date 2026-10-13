# Hosted mode — STUB, disabled

> **Update 11 Oct 2026:** OAuth 2.1 and the remote endpoint for **BYOK** are now built. See [REMOTE.md](REMOTE.md). Users sign in by pasting their own Apify token, so the operator pays nothing. This file now covers only the separate *operator-pays* hosted mode, which is still a stub.

**Status:** code path exists, OFF by default, NOT for production. Nothing is deployed.

## Modes
| Mode | Who pays Apify | Auth to our server | State |
|---|---|---|---|
| `byok` (default) | The end user, through their own `APIFY_TOKEN` (env var in stdio, `X-Apify-Token` or `Authorization: Bearer` header in HTTP) | None needed; the Apify token is the credential | **Ready** |
| `hosted` | The operator token (`SITEVERDICT_OPERATOR_APIFY_TOKEN`) | `Authorization: Bearer <customer API key>`, checked against SHA-256 hashes in `SITEVERDICT_HOSTED_KEY_SHA256` | **Stub.** It refuses every request unless `SITEVERDICT_MODE=hosted` **and** `SITEVERDICT_HOSTED_ENABLED=true` |

## What is missing before hosted mode could go live (owner decisions)
1. **Billing and metering.** In hosted mode the operator pays Apify, so you would need per-customer usage records, prices, invoices and VAT. Nothing like this exists. A simpler alternative is to keep BYOK and let Apify do all billing.
2. **OAuth 2.1.** The Claude Connectors Directory and the ChatGPT app directory both expect OAuth, and ChatGPT does **not** accept API-key auth. That means an authorization server (or a provider such as Auth0, WorkOS or Stytch), Protected Resource Metadata (RFC 9728), and Client ID Metadata Documents. The SDK has the building blocks: `requireBearerAuth`, `buildOAuthProtectedResourceMetadata` and `verifyBearerToken`.
   - **Alternative:** Apify itself offers OAuth on `mcp.apify.com`. Investigate whether a connector can reuse "Sign in with Apify" so users keep BYOK billing. This was not verified.
3. **Infrastructure.** TLS endpoint (e.g. `mcp.webrevenuescan.com`), process manager, logs without tokens, uptime monitoring, abuse controls. The in-memory rate limiter would need Redis for more than one instance.
4. **Legal.** Final PRIVACY and TERMS, a DPA for EU/UK business customers, and Apify's terms on reselling Actor runs.
5. **Key issuance.** Generate keys out-of-band and store only `sha256(key)`. For example: `node -e "const k=require('crypto').randomBytes(32).toString('base64url');console.log(k, require('crypto').createHash('sha256').update(k).digest('hex'))"`

## Remote deployment sketch (for later — NOT done)
```bash
SITEVERDICT_HTTP_HOST=127.0.0.1 SITEVERDICT_HTTP_PORT=3333 \
SITEVERDICT_ALLOWED_HOSTS=mcp.webrevenuescan.com SITEVERDICT_ALLOWED_ORIGINS=https://claude.ai,https://chatgpt.com \
node dist/cli.js --http      # behind a TLS reverse proxy that forwards /mcp
```
In BYOK remote mode, each request carries the user's own Apify token, so there is no operator cost. Directory listings would still need OAuth, as described above.
