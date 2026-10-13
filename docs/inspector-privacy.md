# SiteVerdict Inspector — Privacy Policy

_Last updated: 11 October 2026_

SiteVerdict Inspector ("the extension") is published by **BharatFare Travel and Technologies Ltd** (United Kingdom), trading as **SiteVerdict**. Contact: **aman.thakran@bharatfare.com**.

## Single purpose

The extension inspects the technical health of the website you are viewing (technologies used, tracking tags and consent signals, speed and UX, SEO basics, AI-search crawler access and quick accessibility flags) and shows the results to you.

## What the extension does NOT do

- It does **not** collect, transmit, sell, rent or share any personal data or browsing data.
- It has **no** analytics, telemetry, crash reporting, advertising or tracking of its own.
- It does **not** run in the background and does **not** read any page until **you** click the extension (Chrome's `activeTab` model). It has no access to other tabs or sites.
- It does **not** load or execute remote code. All code ships inside the extension package.
- It does **not** read cookie values. It only lists cookie **names** that the page itself can read, and only on your screen.

## Network requests

When you open the inspector on a page, the extension makes exactly two requests, both to **the same website you are inspecting** (same origin, without sending cookies):

- `GET /robots.txt`
- `GET /llms.txt`

They are used to show which AI crawlers the site allows. No data about you or the page is sent to SiteVerdict, BharatFare or any third party. The site you inspect receives these two requests like any normal visit to those files.

Links in the panel (for example "Get the full SiteVerdict audit", "Find more sites like this", "Monitor this site") open the Apify Store in a new tab **only when you click them**. Those links contain only fixed campaign tags identifying the extension (`utm_source=siteverdict-inspector`) — never the address of the site you inspected or any result.

## Data stored on your device

Only your interface preferences (light/dark theme and the last tab you opened) are saved with `chrome.storage.local` on your device. Inspection results are kept in memory while the panel is open and are discarded when you close it, unless **you** choose "Copy as Markdown" or "Download JSON", which put a copy on your clipboard or in your Downloads folder.

## Chrome Web Store "Privacy practices" answers

| Question | Answer |
|---|---|
| Personally identifiable information | Not collected |
| Health information | Not collected |
| Financial and payment information | Not collected |
| Authentication information | Not collected |
| Personal communications | Not collected |
| Location | Not collected |
| Web history | Not collected |
| User activity (clicks, mouse, keystrokes) | Not collected |
| Website content | Not collected (page content is analysed locally on your device and never transmitted) |
| I do not sell or transfer user data to third parties, outside of the approved use cases | Certified |
| I do not use or transfer user data for purposes unrelated to the item's single purpose | Certified |
| I do not use or transfer user data to determine creditworthiness or for lending purposes | Certified |

## Future paid tier

A future optional "Pro" tier may add licence verification through a payment provider (for example ExtensionPay or Lemon Squeezy). It is **not active** in this version. If it is ever enabled, this policy and the Chrome Web Store disclosures will be updated **before** release, and the only data sent would be what is needed to verify a licence you choose to enter.

## Children

The extension is a developer/marketing tool and is not directed at children.

## Your rights (UK GDPR)

Because we do not collect personal data through the extension, we hold no extension data about you. For any privacy question, email aman.thakran@bharatfare.com. You may also complain to the UK Information Commissioner's Office (ico.org.uk).

## Changes

We will post any change to this policy here and update the "Last updated" date.
