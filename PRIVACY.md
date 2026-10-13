# Privacy Policy — SiteVerdict MCP server

> **DRAFT — needs owner and legal review before publication.** Not legal advice. Placeholders are in [brackets].

_Last updated: [date]_ · Controller: [Aman Thakran / legal entity name], [address], United Kingdom · Contact: [aman.thakran@bharatfare.com]

## 1. What this covers
This policy covers the SiteVerdict MCP server software (the npm package `@siteverdict/mcp`, its Docker image and MCPB bundle) and any SiteVerdict-operated hosted endpoint, if one is ever launched. The SiteVerdict Apify Actors are run on Apify's platform, and Apify's own privacy policy applies to your Apify account: https://apify.com/privacy-policy

## 2. Local use (stdio, npx, Docker, MCPB): we receive nothing
When you run the server on your own machine:
- it sends your audit requests (the website URL or domain and scan options) and your Apify API token **directly to Apify** (`api.apify.com`), to start the Actor run on your Apify account
- **we (SiteVerdict) receive no data**: no telemetry, no analytics, no crash reports
- your token is read from your environment or client config, is held only in memory, and is never written to disk or logs by the server

## 3. Data processed during an audit
- **Inputs:** the public URL or domain you choose, and optional values such as monthly visitors or average order value for the revenue estimate.
- **What the Actors collect:** they load public pages like a normal visitor would, recording page performance, cookies set, network requests to tracking vendors, accessibility issues, and public DNS records. They do not log in, submit forms or bypass access controls.
- **Results** are stored in **your** Apify account's storage (dataset and key-value store). Apify's retention rules apply. Unnamed run storage is typically deleted automatically after Apify's retention period; check your plan.
- Pages you scan may contain personal data (for example names on a team page). Scan only sites you own or are authorised to test, and treat reports accordingly.

## 4. Hosted endpoint (not live; this section applies only if launched)
If SiteVerdict operates a remote endpoint:
- **What we process:**
  - request metadata (IP address, timestamp, tool name, target domain, status, duration)
  - account or OAuth identifiers
  - usage counts for billing and abuse prevention
- **Legal basis:** contract and legitimate interests (security, abuse prevention). UK GDPR / EU GDPR.
- **Retention:** request logs [30] days, billing records as required by law [6 years UK].
- **What we do not keep:** we do not store your Apify token beyond the request. In BYOK mode it is passed through to Apify only.
- **Processors:** [hosting provider], [OAuth provider], Apify Technologies s.r.o. (Czech Republic, EU).
- **International transfers:** [describe safeguards, e.g. UK IDTA / EU SCCs, if any processor is outside the UK/EEA].

## 4a. Remote sign-in (OAuth) — applies only if the hosted endpoint is launched
- When you connect ChatGPT, Claude or another app, you paste **your own Apify API token** on our sign-in page.
- The token is checked once with Apify, then **encrypted** (AES-256-GCM) into the access token that your app holds.
- We keep no database of tokens. Disconnecting the app, or rotating the token in Apify, ends access.
- Access tokens last 1 hour and refresh tokens 30 days. Refresh tokens rotate on use.
- Optional third-party keys (e.g. Companies House, HMRC, Google) are only accepted from your own configuration or request headers. They are passed to the Actor run, never logged, and never shown in results.
- Data tools can process business or personal data that you submit, such as names you screen against sanctions lists or VAT numbers. Submit only data you have a lawful basis to process. Reviewer names and e-mail addresses are off by default.

## 5. Your rights
Under UK GDPR and EU GDPR you can request access, correction, deletion, restriction, portability, or object to processing. Contact [aman.thakran@bharatfare.com]. You may complain to the ICO (ico.org.uk) or your local supervisory authority.

## 6. Children
The service is for businesses and developers and is not directed at children under 16.

## 7. Changes
We will post changes here, with a new "Last updated" date.
