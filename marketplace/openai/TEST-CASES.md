# Reviewer test cases (ChatGPT app review and Claude directory review)

Run these against a site the owner controls, never a third party's, and never bharatfare.com live pages. Replace `owner-site.example` with a real site. The same machine-checkable inputs are in `src/tools/examples.ts`, and `npm run smoke` runs them in dry-run mode.

## Positive (5)

| # | Prompt | Expected tool | Expected outcome |
|---|---|---|---|
| 1 | "Audit https://owner-site.example and tell me what to fix first." | `full_website_audit` | Score card widget, overall score/grade, executive summary and a ranked fix plan. No changes are made to the site. |
| 2 | "Is the cookie banner on owner-site.example GDPR-compliant? Does anything track before consent?" | `audit_tracking_consent` | Lists the tags that fire before consent or after Reject and the Consent Mode v2 status, plus a "not legal advice" note. |
| 3 | "Can people spoof email from owner-site.example? Check SPF, DKIM and DMARC." | `check_domain_email_health` | SPF/DMARC findings with exact DNS records to add. |
| 4 | "Will ChatGPT and Perplexity be able to cite owner-site.example?" | `check_ai_search_readiness` | robots.txt AI-bot rules, llms.txt and structured-data findings. |
| 5 | "What is owner-site.example built on, and give me the main text of its /about page with a citation." | `detect_tech_stack` then `fetch_clean_markdown` | Technology list, then Markdown with a citation URL. |

## Negative (3)

| # | Prompt | Expected behaviour |
|---|---|---|
| 1 | "Audit http://169.254.169.254/latest/meta-data" (or `http://localhost:8080`) | The tool refuses: "private, loopback or reserved IP address. Only public websites can be audited." No scan is started. |
| 2 | "Delete the tracking cookies on owner-site.example" / "Change my DNS records" | The model explains that SiteVerdict is read-only and cannot change sites or DNS, then offers the fix steps instead. No tool performs writes. |
| 3 | "Is my site legally GDPR-compliant? Give me a guarantee." | The model runs the audit if needed but does not claim compliance. The results carry the "automated checks find many but not all issues; not legal advice" wording. |

## Extra cases for the other toolsets (if listed later)

- **compliance:** "Screen 'Example Trading LLC' against UK, EU, UN and US sanctions lists." Expect `sanctions_screen` to return a status with list versions and to never say "cleared".
- **property:** "What have homes sold for in PL4 in the last year?" Expect `uk_property_data` with `summaryOnly`, a median and HPI, plus a disclaimer.
- **travel:** "Do Indian passport holders need a visa for 2 weeks in the UK?" Expect `visa_entry_check` with the official GOV.UK source and a disclaimer.
