import { BRAND } from '../brand.js';

/**
 * MCP Apps / ChatGPT Apps SDK UI component: a score card + findings list for the audit tools.
 * Standard (MCP Apps extension): tool _meta.ui.resourceUri -> ui:// resource with mimeType text/html;profile=mcp-app.
 * ChatGPT aliases: openai/outputTemplate, openai/widgetDescription, openai/widgetCSP, openai/widgetDomain ...
 * Refs: https://developers.openai.com/apps-sdk/reference , https://developers.openai.com/apps-sdk/build/chatgpt-ui
 * The HTML is fully self-contained (no network, no external fonts/scripts), so the CSP allows nothing extra.
 */
export const WIDGET_URI = `ui://${BRAND.slug}/score-card-v1.html`;
export const WIDGET_MIME = 'text/html;profile=mcp-app';

export const WIDGET_RESOURCE_META: Record<string, unknown> = {
  ui: { csp: { connectDomains: [], resourceDomains: [] }, domain: BRAND.website, prefersBorder: true },
  'openai/widgetDescription': `${BRAND.name} score card: overall score and grade, issue counts by severity and the top prioritised fixes. The model already has the same data as structured content and should not repeat the list verbatim.`,
  'openai/widgetPrefersBorder': true,
  'openai/widgetDomain': BRAND.website,
  'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
};

/** Tool-descriptor _meta for tools that render the score card. */
export function widgetToolMeta(invoking: string, invoked: string): Record<string, unknown> {
  return {
    ui: { resourceUri: WIDGET_URI },
    'openai/outputTemplate': WIDGET_URI,
    'openai/toolInvocation/invoking': invoking.slice(0, 64),
    'openai/toolInvocation/invoked': invoked.slice(0, 64),
    'openai/widgetAccessible': false,
  };
}

export const WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${BRAND.name} score card</title>
<style>
:root{--bg:#ffffff;--fg:#14171f;--muted:#5b6170;--line:#e3e6ec;--card:#f6f7f9;--crit:#b42318;--high:#c4320a;--med:#a15c07;--low:#3e4c59;--ok:#067647;--accent:#2547d0}
@media (prefers-color-scheme: dark){:root{--bg:#14161b;--fg:#eef0f4;--muted:#a3a9b6;--line:#2b2f38;--card:#1c1f26;--crit:#f97066;--high:#fd853a;--med:#fdb022;--low:#cbd2dc;--ok:#47cd89;--accent:#8ea2ff}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{padding:16px;max-width:760px}
.top{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.score{width:84px;height:84px;border-radius:50%;display:grid;place-items:center;border:6px solid var(--line);font-weight:700;font-size:26px;flex:none}
.score small{display:block;font-size:12px;font-weight:600;color:var(--muted);text-align:center}
h1{font-size:16px;margin:0 0 4px}.sub{color:var(--muted);font-size:13px;margin:0;word-break:break-all}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:var(--card);border:1px solid var(--line)}
.warn{background:#fff4e5;color:#7a3e00;border-color:#f5c27a}@media (prefers-color-scheme: dark){.warn{background:#3a2a10;color:#fdd59a;border-color:#7a5a20}}
.counts{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 4px}
.c{padding:6px 10px;border-radius:8px;background:var(--card);border:1px solid var(--line);font-size:13px}
.c b{font-size:15px}.critical b{color:var(--crit)}.high b{color:var(--high)}.medium b{color:var(--med)}.low b{color:var(--low)}
p.summary{margin:12px 0}
ol{margin:8px 0 0;padding-left:22px}li{margin:0 0 10px}
.sev{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;margin-right:6px}
.sev.critical{color:var(--crit)}.sev.high{color:var(--high)}.sev.medium{color:var(--med)}.sev.low,.sev.info{color:var(--low)}
.fix{color:var(--muted);display:block;margin-top:2px}
a{color:var(--accent)}a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sections{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:12px}
.sec{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13px}
.sec b{display:block;font-size:18px}
.empty{color:var(--muted)}
footer{margin-top:14px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<main id="app" aria-live="polite"><p class="empty">Waiting for audit results…</p></main>
<script>
(function(){
  "use strict";
  var app = document.getElementById("app");
  function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];});}
  function safeUrl(u){try{var x=new URL(String(u));return x.protocol==="https:"?x.href:null;}catch(e){return null;}}
  function colour(score){if(score==null)return "var(--line)";if(score>=80)return "var(--ok)";if(score>=55)return "var(--med)";return "var(--crit)";}
  function render(d){
    if(!d||typeof d!=="object"){return;}
    var score = d.overallScore!=null?d.overallScore:d.score;
    var grade = d.grade||"";
    var target = d.target||d.domain||"";
    var counts = d.severityCounts||{};
    var list = Array.isArray(d.fixPlan)&&d.fixPlan.length?d.fixPlan:(Array.isArray(d.findings)?d.findings:[]);
    var summary = d.executiveSummary||d.summary||"";
    var h = '<div class="top"><div class="score" style="border-color:'+colour(score)+'" role="img" aria-label="Score '+esc(score==null?"not available":score+" out of 100")+'"><div>'+(score==null?"–":esc(score))+'<small>'+esc(grade)+'</small></div></div>'
      + '<div><h1>${BRAND.name} — '+esc(d.check?String(d.check).replace(/_/g," "):"website audit")+'</h1><p class="sub">'+esc(target)+'</p>'
      + (d.dryRun?'<p><span class="badge warn">SAMPLE DATA — not a real scan</span></p>':'')
      + (d.status&&d.status!=="complete"?'<p><span class="badge">'+esc(d.status)+'</span></p>':'')
      + '</div></div>';
    h += '<div class="counts">'+["critical","high","medium","low"].map(function(k){return '<span class="c '+k+'"><b>'+esc(counts[k]||0)+'</b> '+k+'</span>';}).join("")+'</div>';
    if(summary){h += '<p class="summary">'+esc(summary)+'</p>';}
    if(Array.isArray(d.sections)&&d.sections.length){
      h += '<div class="sections">'+d.sections.map(function(s){return '<div class="sec">'+esc(String(s.check).replace(/_/g," "))+'<b>'+(s.score==null?"–":esc(s.score))+'</b>'+esc(s.status)+'</div>';}).join("")+'</div>';
    }
    if(list.length){
      h += '<h1 style="margin-top:14px">'+(d.fixPlan?"Prioritised fix plan":"Top findings")+'</h1><ol>';
      list.slice(0,10).forEach(function(f){
        var link = safeUrl(f.helpUrl);
        h += '<li><span class="sev '+esc(f.severity)+'">'+esc(f.severity)+'</span>'+esc(f.title)
          + (f.fix?'<span class="fix">Fix: '+esc(f.fix)+'</span>':'')
          + (link?' <a href="'+esc(link)+'" target="_blank" rel="noopener noreferrer">Learn more</a>':'')+'</li>';
      });
      h += '</ol>';
    } else { h += '<p class="empty">No findings to show.</p>'; }
    var report = safeUrl(d.reportUrl);
    h += '<footer>Automated checks find many issues but not all; not legal advice.'+(report?' <a href="'+esc(report)+'" target="_blank" rel="noopener noreferrer">Full report</a>':'')+'</footer>';
    app.innerHTML = h;
    notifySize();
  }
  function post(msg){try{window.parent.postMessage(msg,"*");}catch(e){}}
  function notifySize(){post({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:document.documentElement.scrollHeight}});}
  // MCP Apps host bridge (JSON-RPC over postMessage).
  window.addEventListener("message",function(ev){
    if(ev.source!==window.parent)return;
    var m = ev.data; if(!m||m.jsonrpc!=="2.0")return;
    if(m.method==="ui/notifications/tool-result"&&m.params){render(m.params.structuredContent||m.params);}
    if(m.id===1&&m.result){post({jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}});}
  });
  post({jsonrpc:"2.0",id:1,method:"ui/initialize",params:{appInfo:{name:"${BRAND.slug}-score-card",version:"1"},appCapabilities:{},protocolVersion:"2026-01-26"}});
  // ChatGPT compatibility globals.
  function fromOpenAI(){try{if(window.openai&&window.openai.toolOutput){render(window.openai.toolOutput);}}catch(e){}}
  window.addEventListener("openai:set_globals",fromOpenAI);
  fromOpenAI();
})();
</script>
</body>
</html>
`;
