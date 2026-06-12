// The Chorus console: the HUMAN's surface over the shared store. A zero-dependency local web
// UI — briefing dashboard, topic browser, per-entity receipts, an as-of time scrubber, and a
// trust editor whose edits are signed by the USER's persistent key (the console is you).
//
//   npm run chorus:console     (CHORUS_STORE, CHORUS_MASTER_SEED, CHORUS_CONSOLE_PORT)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authorForSeed } from "../src/index.js";
import { ChorusAgent } from "./agent.js";
import { briefing } from "./briefing.js";
import { recallUnified, sameAsClass, search, topics } from "./discovery.js";
import { identityIndex, userSeed, type AuthorIdentity } from "./identity.js";
import { SharedStore } from "./shared-store.js";
import { ROLE_TRUST_AUTHOR, ROLE_TRUST_REASON, ROLE_TRUST_VERDICT } from "./vocab.js";

export interface ConsoleOptions {
  readonly storePath: string;
  readonly masterSeedHex: string;
  readonly port?: number; // 0 = ephemeral
}

export interface ConsoleHandle {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): void;
}

function describeAuthor(id: AuthorIdentity | undefined, author: string): string {
  if (id === undefined) return `${author.slice(0, 18)}… (unknown)`;
  if (id.kind === "user") return "you";
  return `${id.model ?? "?"} · session ${id.sessionId ?? "?"}`;
}

export function startConsole(opts: ConsoleOptions): Promise<ConsoleHandle> {
  const store = new SharedStore(opts.storePath);
  const uSeed = userSeed(opts.masterSeedHex);
  const userAuthor = authorForSeed(uSeed);
  // The console's reading agent. Its keypair exists but never signs anything; every console
  // WRITE is signed by the user key.
  const agent = new ChorusAgent({ name: "console", seedHex: userSeed(`${opts.masterSeedHex}c`) });
  store.refresh(agent);

  const json = (res: ServerResponse, body: unknown, status = 200): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    store.refresh(agent); // every request sees the live world
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
      } else if (url.pathname === "/api/state") {
        const b = briefing(agent, userAuthor);
        json(res, {
          storePath: opts.storePath,
          deltas: agent.peer.reactor.arrivalLog().length,
          userAuthor,
          briefing: b,
          topics: topics(agent, { limit: 100 }),
        });
      } else if (url.pathname === "/api/entity") {
        const id = url.searchParams.get("id") ?? "";
        const at = url.searchParams.get("at");
        const asOf = at === null ? undefined : Number(at);
        const identities = identityIndex(agent.snapshot(), userAuthor);
        const receipts = agent
          .explain(id, undefined, asOf === undefined ? {} : { asOf })
          .map((r) => ({ ...r, who: describeAuthor(identities.get(r.author), r.author) }));
        const unified = recallUnified(agent, id, asOf === undefined ? {} : { asOf });
        json(res, {
          id,
          view: agent.recall(id, asOf === undefined ? {} : { asOf }),
          unifiedView: unified.view,
          class: sameAsClass(agent, id),
          receipts,
          distrusted: receipts
            .map((r) => r.author)
            .filter((a) => agent.distrusts(a))
            .sort(),
        });
      } else if (url.pathname === "/api/search") {
        json(res, search(agent, url.searchParams.get("q") ?? "", 25));
      } else if (url.pathname === "/api/distrust" && req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const { author, reason } = JSON.parse(body) as { author: string; reason?: string };
          // The console is the human: the edit is signed by YOUR key, visible to every session.
          agent.recordAs(uSeed, {
            timestamp: Date.now(),
            pointers: [
              { role: ROLE_TRUST_AUTHOR, target: { kind: "primitive", value: author } },
              { role: ROLE_TRUST_VERDICT, target: { kind: "primitive", value: "distrusted" } },
              ...(reason === undefined
                ? []
                : [
                    {
                      role: ROLE_TRUST_REASON,
                      target: { kind: "primitive" as const, value: reason },
                    },
                  ]),
            ],
          });
          agent.applyDistrust(author);
          store.persist(agent);
          json(res, { distrusted: author });
        });
        return;
      } else {
        json(res, { error: "not found" }, 404);
      }
    } catch (e) {
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  };

  return new Promise((resolvePromise) => {
    const server = createServer(handle);
    server.listen(opts.port ?? 4820, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        server,
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () => server.close(),
      });
    });
  });
}

// ── the page ─────────────────────────────────────────────────────────────────────────────────

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Chorus console</title>
<style>
:root{--bg:#0f0f14;--panel:#17171f;--panel2:#1c1c26;--border:#2a2a38;--text:#d8d8e0;--dim:#8a8a9a;
--accent:#e8b04b;--ok:#6fd08c;--bad:#e06c75;--mono:ui-monospace,"Cascadia Code",Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,sans-serif}
header{padding:.8em 1.2em;border-bottom:1px solid var(--border);display:flex;gap:1em;align-items:baseline;flex-wrap:wrap}
header h1{font-size:1.1em;margin:0}header .meta{color:var(--dim);font-size:.8em;font-family:var(--mono)}
main{display:grid;grid-template-columns:280px 1fr;gap:1em;padding:1em;max-width:1300px;margin:0 auto}
@media(max-width:800px){main{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:.9em 1em;margin-bottom:1em}
.panel h2{font-size:.8em;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:0 0 .5em}
.topic{cursor:pointer;padding:.25em .4em;border-radius:6px;font-family:var(--mono);font-size:.85em;display:flex;justify-content:space-between;gap:.5em}
.topic:hover{background:var(--panel2)}.topic .n{color:var(--dim)}
.row{padding:.3em 0;border-bottom:1px solid var(--border);font-size:.9em}.row:last-child{border:none}
.kv{font-family:var(--mono);font-size:.9em}.kv b{color:var(--accent);font-weight:600}
.receipt{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:.5em .7em;margin:.45em 0;font-size:.85em}
.receipt .who{color:var(--accent)}.receipt .id{color:var(--dim);font-family:var(--mono);font-size:.85em}
.receipt.negated{opacity:.55}.receipt.negated .val{text-decoration:line-through}
.badge{display:inline-block;border:1px solid var(--border);border-radius:999px;padding:0 .55em;font-size:.78em;color:var(--dim);margin-left:.4em}
.badge.neg{color:var(--bad);border-color:var(--bad)}.badge.user{color:var(--ok);border-color:var(--ok)}
button{background:var(--panel2);color:var(--bad);border:1px solid var(--border);border-radius:6px;padding:.15em .6em;cursor:pointer;font-size:.78em}
button:hover{border-color:var(--bad)}
input[type=range]{width:100%}
input[type=search]{width:100%;background:var(--panel2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:.4em .6em;font-family:var(--mono)}
.scrub{color:var(--dim);font-size:.8em;font-family:var(--mono)}
.contested{color:var(--bad)}.empty{color:var(--dim);font-style:italic;font-size:.85em}
a{color:var(--accent);cursor:pointer}
</style></head><body>
<header><h1>Chorus console</h1><span class="meta" id="meta"></span></header>
<main>
<div>
  <div class="panel"><h2>Search</h2><input type="search" id="q" placeholder="value, attribute, id…"/></div>
  <div class="panel"><h2>Topics</h2><div id="topics"></div></div>
</div>
<div>
  <div class="panel" id="briefing"></div>
  <div class="panel" id="entity"><h2>Entity</h2><div class="empty">pick a topic ←</div></div>
</div>
</main>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let state=null,current=null,tsRange=null;
async function load(){
  state=await (await fetch('/api/state')).json();
  $('meta').textContent=state.storePath+' · '+state.deltas+' deltas';
  $('topics').innerHTML=state.topics.map(t=>'<div class="topic" onclick="openEntity(\\''+esc(t.entity)+'\\')"><span>'+esc(t.entity)+'</span><span class="n">'+t.claims+'</span></div>').join('')||'<div class="empty">nothing yet</div>';
  const b=state.briefing;
  $('briefing').innerHTML='<h2>Briefing</h2>'
    +section('Preferences',b.preferences.map(p=>kv(p.entity+' · '+p.attribute,p.value)))
    +section('Open tasks',b.openTasks.map(p=>kv(p.entity+' · '+p.attribute,p.value)))
    +section('Contested',b.contested.map(c=>'<div class="row contested">'+esc(c.entity)+' · '+esc(c.attribute)+' → '+esc(JSON.stringify(c.values))+'</div>'),true)
    +section('Recent sessions',b.recentSessions.map(s=>'<div class="row"><span class="kv"><b>'+esc(s.model)+'</b> · '+esc(s.sessionId)+'</span>'+(s.purpose?' — '+esc(s.purpose):'')+(s.summary?'<br/><span class="scrub">'+esc(s.summary)+'</span>':'')+'</div>'))
    +section('Distrusted',b.distrusted.map(d=>'<div class="row kv">'+esc(d.author.slice(0,24))+'… '+(d.reason?'<span class="scrub">('+esc(d.reason)+')</span>':'')+'</div>'));
}
const section=(t,items,warn)=>'<h2 style="margin-top:.8em'+(warn&&items.length?';color:var(--bad)':'')+'">'+t+(items.length?' ('+items.length+')':'')+'</h2>'+(items.join('')||'<div class="empty">none</div>');
const kv=(k,v)=>'<div class="row kv">'+esc(k)+' = <b>'+esc(JSON.stringify(v))+'</b></div>';
async function openEntity(id,at){
  current=id;
  const e=await (await fetch('/api/entity?id='+encodeURIComponent(id)+(at?'&at='+at:''))).json();
  const ts=e.receipts.map(r=>r.timestamp).filter(t=>t>0);
  if(!at){tsRange=ts.length?[Math.min(...ts),Math.max(...ts)]:null}
  $('entity').innerHTML='<h2>Entity</h2><div class="kv" style="font-size:1.05em"><b>'+esc(id)+'</b>'
    +(e.class.length>1?'<span class="badge">≡ '+e.class.filter(x=>x!==id).map(esc).join(', ')+'</span>':'')+'</div>'
    +'<div class="kv" style="margin:.4em 0">view'+(at?' @ '+new Date(+at).toLocaleString():'')+': <b>'+esc(JSON.stringify(e.class.length>1?e.unifiedView:e.view))+'</b></div>'
    +(tsRange?'<input type="range" id="scrub" min="'+tsRange[0]+'" max="'+(tsRange[1]+1)+'" value="'+(at||tsRange[1]+1)+'" oninput="scrubbed(this.value)"/><div class="scrub" id="scrubLabel">'+(at?'as of '+new Date(+at).toLocaleString():'now')+'</div>':'')
    +'<h2 style="margin-top:.8em">Receipts ('+e.receipts.length+')</h2>'
    +e.receipts.map(r=>'<div class="receipt'+(r.negated?' negated':'')+'">'
      +'<span class="val">'+esc(r.attribute||'')+' '+esc(JSON.stringify(r.value))+'</span>'
      +(r.negated?'<span class="badge neg">retracted</span>':'')
      +(r.kind?'<span class="badge">'+esc(r.kind)+'</span>':'')
      +'<br/><span class="who">'+esc(r.who)+'</span>'+(r.signed?'':'<span class="badge neg">unsigned</span>')
      +' <span class="id">'+esc(r.deltaId.slice(0,18))+'… · t='+r.timestamp+'</span>'
      +(e.distrusted.includes(r.author)?'<span class="badge neg">distrusted</span>':' <button onclick="distrust(\\''+esc(r.author)+'\\')">distrust</button>')
      +'</div>').join('');
}
let scrubTimer=null;
function scrubbed(v){
  $('scrubLabel').textContent=(+v>tsRange[1])?'now':'as of '+new Date(+v).toLocaleString();
  clearTimeout(scrubTimer);
  scrubTimer=setTimeout(()=>openEntity(current,(+v>tsRange[1])?undefined:v),150);
}
async function distrust(author){
  const reason=prompt('Why distrust this author? (recorded, signed by you)')||undefined;
  await fetch('/api/distrust',{method:'POST',body:JSON.stringify({author,reason})});
  await load();if(current)openEntity(current);
}
$('q').addEventListener('input',async ev=>{
  const q=ev.target.value.trim();
  if(!q){load();return}
  const hits=await (await fetch('/api/search?q='+encodeURIComponent(q))).json();
  $('topics').innerHTML=hits.map(h=>'<div class="topic" onclick="openEntity(\\''+esc(h.entity)+'\\')"><span>'+esc(h.entity)+' · '+esc(h.attribute)+'</span><span class="n">'+esc(JSON.stringify(h.value))+'</span></div>').join('')||'<div class="empty">no hits</div>';
});
load();setInterval(load,5000);
</script></body></html>`;

// Direct run.
if (
  process.argv[1] !== undefined &&
  process.argv[1].replace(/\\\\/g, "/").replace(/\\/g, "/").endsWith("chorus/console.ts")
) {
  const opts: ConsoleOptions = {
    storePath: process.env["CHORUS_STORE"] ?? "chorus-memory.jsonl",
    masterSeedHex:
      process.env["CHORUS_MASTER_SEED"] ?? process.env["CHORUS_SEED_HEX"] ?? "0f".repeat(32),
    port: Number(process.env["CHORUS_CONSOLE_PORT"] ?? 4820),
  };
  void startConsole(opts).then((h) => console.log(`chorus console → ${h.url}`));
}
