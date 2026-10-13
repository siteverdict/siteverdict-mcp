# Installing the SiteVerdict MCP server (guide for AI coding agents such as Cline)

1. Requirements: Node.js 20 or newer (`node -v`). No clone or build is needed; the server runs through `npx`.
2. Ask the user for their **Apify API token** (https://console.apify.com/settings/integrations). Explain that audits run on their Apify account and are billed by Apify pay-per-event, with a $2 default spend cap per scan. If they only want to try it, skip the token and set `SITEVERDICT_DRY_RUN` to `1`; results will then be sample data.
3. Add this to the MCP settings file (`cline_mcp_settings.json`):
```json
{
  "mcpServers": {
    "siteverdict": {
      "command": "npx",
      "args": ["-y", "@siteverdict/mcp"],
      "env": { "APIFY_TOKEN": "<user's token>" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```
   On Windows, if `npx` is not found, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "@siteverdict/mcp"]`.
4. Verify the install: the server should list 7 tools (`full_website_audit`, `audit_tracking_consent`, `scan_speed_and_revenue`, `audit_accessibility_wcag`, `check_domain_email_health`, `check_ai_search_readiness`, `get_audit_results`).
5. Test it with `check_domain_email_health` and `{"domain": "example.com"}`. This is the fastest and cheapest check.
6. Scans take 1–5 minutes. If a result says `"status": "running"`, call `get_audit_results` with the given `runId` later. Do not start a new scan.
