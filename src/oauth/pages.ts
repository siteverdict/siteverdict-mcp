import { BRAND } from '../brand.js';

/** Server-rendered OAuth pages (no JS, no external assets; WCAG 2.2 AA: labels, focus, contrast, 44px targets). */

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `:root{--bg:#f6f7f9;--card:#fff;--fg:#14171f;--muted:#4b5262;--line:#d5d9e0;--accent:#2547d0;--accent-fg:#fff;--err:#b42318}
@media (prefers-color-scheme: dark){:root{--bg:#111318;--card:#1b1e25;--fg:#eef0f4;--muted:#b4bac6;--line:#363b46;--accent:#8ea2ff;--accent-fg:#0b0d12;--err:#f97066}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:520px;margin:32px auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 8px}p,li{color:var(--muted)}strong{color:var(--fg)}label{display:block;font-weight:600;margin:16px 0 6px}
input{width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font:inherit}
input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.row{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}button{min-height:44px;padding:10px 18px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--fg)}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}a{color:var(--accent)}.err{color:var(--err);font-weight:600}.small{font-size:14px}`;

function page(status: number, title: string, body: string, csp: string, extraHeaders: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)} · ${esc(BRAND.name)}</title><style>${STYLE}</style></head><body><main><div class="card">${body}</div><p class="small">${esc(BRAND.name)} is operated by ${esc(BRAND.company)}, ${esc(BRAND.companyLocation)}. <a href="${esc(BRAND.website)}/privacy">Privacy</a> · <a href="${esc(BRAND.website)}/terms">Terms</a> · Support: <a href="mailto:${esc(BRAND.supportEmail)}">${esc(BRAND.supportEmail)}</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': csp,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

export function errorPage(status: number, title: string, message: string): Response {
  return page(status, title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`, "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}

export interface ConsentOptions {
  sealed: string;
  clientName: string;
  redirectHost: string;
  redirectOrigin: string;
  secureCookie: boolean;
  nonce: string;
  apiKeyAllowed: boolean;
  error?: string;
  keepCookie?: boolean;
}

export function consentPage(o: ConsentOptions): Response {
  const body = `<h1>Connect ${o.clientName ? esc(o.clientName) : 'your AI app'} to ${esc(BRAND.name)}</h1>
<p>After you approve, <strong>${esc(o.redirectHost)}</strong> can run ${esc(BRAND.name)} tools for you: website audits and the other read-mostly business tools you enable. Nothing on your website is changed.</p>
<ul class="small"><li>Scans run as Apify Actors on <strong>your own Apify account</strong> and are billed by Apify (pay-per-event, spend-capped per run).</li><li>Your token is encrypted into the access token given to the app; ${esc(BRAND.name)} does not store it. Disconnect the app to revoke access, and rotate the token in Apify at any time.</li></ul>
${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ''}
<form method="post" action="/oauth/authorize" autocomplete="off">
<input type="hidden" name="req" value="${esc(o.sealed)}">
<label for="apify_token">Your Apify API token</label>
<input id="apify_token" name="apify_token" type="password" inputmode="text" spellcheck="false" autocapitalize="off" placeholder="apify_api_…" aria-describedby="tokhelp">
<p id="tokhelp" class="small">Find it at <a href="https://console.apify.com/settings/integrations" target="_blank" rel="noopener noreferrer">console.apify.com → Settings → API &amp; Integrations</a>.</p>
${o.apiKeyAllowed ? `<label for="api_key">Or: your ${esc(BRAND.name)} API key</label><input id="api_key" name="api_key" type="password" spellcheck="false" autocapitalize="off" placeholder="sv_live_…">` : ''}
<div class="row"><button class="primary" type="submit" name="action" value="allow">Allow access</button><button type="submit" name="action" value="deny">Cancel</button></div>
</form>`;
  const cookie = `sv_oauth_nonce=${o.nonce}; Path=/oauth; Max-Age=600; HttpOnly; SameSite=Lax${o.secureCookie ? '; Secure' : ''}`;
  return page(
    200,
    'Connect',
    body,
    `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${o.redirectOrigin}`,
    { 'set-cookie': cookie },
  );
}
