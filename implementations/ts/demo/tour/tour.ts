// The Rhizomatic tour: a narrated, interactive walk through the format. Every widget on this
// page runs the real, tested library — the same code that passes the conformance vectors.
// This file is DOM glue only; all semantics come from src/.

import { canonicalHex, computeId } from "../../src/delta.js";
import type { HView } from "../../src/hview.js";
import { Peer, syncBoth } from "../../src/peer.js";
import { resolveView, type Policy, type View } from "../../src/policy.js";
import { Reactor } from "../../src/reactor.js";
import { makeNegationClaims } from "../../src/set.js";
import { parsePolicy, parseTerm } from "../../src/term-json.js";
import type { Claims, Delta } from "../../src/types.js";

// --- DOM helpers --------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function labeled(text: string, input: HTMLElement): HTMLElement {
  return el("label", { class: "field" }, el("span", {}, text), input);
}

function flash(node: HTMLElement): void {
  node.classList.remove("flash");
  void node.offsetWidth; // restart the animation
  node.classList.add("flash");
}

function valueOf(claims: {
  pointers: ReadonlyArray<{ role: string; target: { kind: string } }>;
}): string {
  const p = claims.pointers.find((x) => x.role === "value");
  if (p !== undefined && p.target.kind === "primitive") {
    return JSON.stringify((p.target as unknown as { value: unknown }).value);
  }
  const neg = claims.pointers.find((x) => x.role === "negates");
  return neg !== undefined ? "(retraction)" : "(edge)";
}

function parseValue(raw: string): string | number {
  const n = Number(raw);
  return Number.isFinite(n) && raw.trim() !== "" ? n : raw;
}

// --- §1 the atom: a live delta builder -----------------------------------------------------------

function widgetAtom(): void {
  const host = $("w-atom");
  const author = el("input", { value: "alice" });
  const ts = el("input", { value: "1", type: "number" });
  const entity = el("input", { value: "movie:blade_runner" });
  const prop = el("input", { value: "director" });
  const val = el("input", { value: "Ridley Scott" });

  const claimsOut = el("pre", { class: "code" });
  const bytesOut = el("div", { class: "bytes mono" });
  const bytesMeta = el("div", { class: "meta" });
  const idOut = el("div", { class: "id mono" });
  const err = el("div", { class: "error" });

  const render = (): void => {
    const claims: Claims = {
      author: author.value,
      timestamp: Number(ts.value),
      pointers: [
        {
          role: "subject",
          target: { kind: "entity", entity: { id: entity.value, context: prop.value } },
        },
        { role: "value", target: { kind: "primitive", value: parseValue(val.value) } },
      ],
    };
    claimsOut.textContent = JSON.stringify(claims, null, 2);
    try {
      const hex = canonicalHex(claims);
      bytesOut.textContent = hex.replace(/(..)/g, "$1 ").trimEnd();
      bytesMeta.textContent = `${hex.length / 2} bytes of canonical CBOR — this IS the wire format`;
      idOut.textContent = computeId(claims);
      err.textContent = "";
      flash(idOut);
    } catch (e) {
      bytesOut.textContent = "—";
      bytesMeta.textContent = "";
      idOut.textContent = "—";
      err.textContent = `the format refuses this delta: ${(e as Error).message}`;
    }
  };

  host.append(
    el(
      "div",
      { class: "controls" },
      labeled("author", author),
      labeled("timestamp", ts),
      labeled("entity", entity),
      labeled("property", prop),
      labeled("value", val),
    ),
    el("div", { class: "panel-title" }, "the claims, as data"),
    claimsOut,
    el("div", { class: "panel-title" }, "canonical bytes"),
    bytesOut,
    bytesMeta,
    el("div", { class: "panel-title" }, "content-derived identity (blake3-256 multihash)"),
    idOut,
    err,
  );
  for (const i of [author, ts, entity, prop, val]) i.addEventListener("input", render);
  render();
}

// --- the shared world for §2–§4 ------------------------------------------------------------------

const ROOT = "movie:blade_runner";

interface World {
  readonly alice: Peer;
  readonly bob: Peer;
  tick(): number;
  clock(): number;
  whoIs(author: string): string;
}

function makeWorldA(): World {
  const alice = new Peer("a1".repeat(32));
  const bob = new Peer("b2".repeat(32));
  let clock = 0;
  const tick = (): number => ++clock;
  const claim = (context: string, value: string | number): Omit<Claims, "author"> => ({
    timestamp: tick(),
    pointers: [
      { role: "subject", target: { kind: "entity", entity: { id: ROOT, context } } },
      { role: "value", target: { kind: "primitive", value: parseValue(String(value)) } },
    ],
  });
  alice.authorClaims(claim("title", "Blade Runner"));
  alice.authorClaims(claim("director", "Ridley Scott"));
  bob.authorClaims(claim("director", "Denis Villeneuve"));
  bob.authorClaims(claim("year", 1982));
  syncBoth(alice, bob);
  return {
    alice,
    bob,
    tick,
    clock: () => clock,
    whoIs(author: string): string {
      if (author === alice.author) return "Alice";
      if (author === bob.author) return "Bob";
      return `${author.slice(8, 16)}…`;
    },
  };
}

const A = makeWorldA();

function bodyTerm(asOf: number | undefined, audit: boolean) {
  const base =
    asOf === undefined
      ? "input"
      : {
          op: "select",
          pred: { match: { field: "timestamp", cmp: "lte", const: asOf } },
          in: "input",
        };
  // No select stage between mask and group: group's filing rules already restrict to pointers
  // targeting the ambient root (E6), and select would drop the annotate channel (ERRATA-2 E14).
  return parseTerm({
    op: "group",
    key: "byTargetContext",
    in: { op: "mask", policy: audit ? "annotate" : "drop", in: base },
  });
}

function hviewAt(peer: Peer, asOf: number | undefined, audit: boolean): HView {
  const result = peer.reactor.eval(bodyTerm(asOf, audit), ROOT);
  if (result.sort !== "hview") throw new Error("expected hview");
  return result.hview;
}

// --- §2 superposition -----------------------------------------------------------------------------

function renderSuperposition(): void {
  const host = $("w-superposition-list");
  host.replaceChildren();
  const hview = hviewAt(A.alice, undefined, false);
  const entries = hview.props.get("director") ?? [];
  for (const e of entries) {
    host.append(
      el(
        "div",
        { class: "entry" },
        el("span", { class: "mono val" }, valueOf(e.delta.claims)),
        el(
          "span",
          { class: "meta" },
          ` — claimed by ${A.whoIs(e.delta.claims.author)} at t=${e.delta.claims.timestamp} · `,
        ),
        el("span", { class: "mono dim" }, `${e.delta.id.slice(4, 16)}…`),
      ),
    );
  }
  host.append(
    el(
      "div",
      { class: "meta" },
      `${entries.length} claims about "director" coexist. None of them won. None of them had to.`,
    ),
  );
}

function widgetSuperposition(): void {
  const host = $("w-superposition");
  host.append(el("div", { class: "panel-title" }, 'the property "director", as stored'));
  host.append(el("div", { id: "w-superposition-list" }));
  const who = el("select", {});
  who.append(el("option", {}, "Alice"), el("option", {}, "Bob"));
  const val = el("input", { placeholder: "your candidate director" });
  const add = el("button", {}, "add a third opinion");
  add.onclick = () => {
    if (!val.value) return;
    const peer = who.value === "Alice" ? A.alice : A.bob;
    peer.authorClaims({
      timestamp: A.tick(),
      pointers: [
        {
          role: "subject",
          target: { kind: "entity", entity: { id: ROOT, context: "director" } },
        },
        { role: "value", target: { kind: "primitive", value: parseValue(val.value) } },
      ],
    });
    syncBoth(A.alice, A.bob);
    val.value = "";
    refreshWorldA();
  };
  host.append(el("div", { class: "controls" }, labeled("as", who), labeled("value", val), add));
}

// --- §3 lenses ------------------------------------------------------------------------------------

const POLICIES: ReadonlyArray<{ label: string; note: string; make: () => Policy }> = [
  {
    label: "latest wins",
    note: "pick by timestamp, newest first",
    make: () => parsePolicy({ default: { pick: { order: { byTimestamp: "desc" } } } }),
  },
  {
    label: "trust Alice",
    note: "pick by author rank: Alice first",
    make: () => parsePolicy({ default: { pick: { order: { byAuthorRank: [A.alice.author] } } } }),
  },
  {
    label: "trust Bob",
    note: "pick by author rank: Bob first",
    make: () => parsePolicy({ default: { pick: { order: { byAuthorRank: [A.bob.author] } } } }),
  },
  {
    label: "surface conflicts",
    note: "directors disagree? say so, loudly",
    make: () =>
      parsePolicy({
        props: { director: { conflicts: { order: { byTimestamp: "desc" } } } },
        default: { pick: { order: { byTimestamp: "desc" } } },
      }),
  },
];

function renderLenses(): void {
  const host = $("w-lens");
  host.replaceChildren();
  const hview = hviewAt(A.alice, undefined, false);
  for (const p of POLICIES) {
    const view: View = resolveView(p.make(), hview);
    host.append(
      el(
        "div",
        { class: "lens-cell" },
        el("div", { class: "panel-title" }, p.label),
        el("div", { class: "meta" }, p.note),
        el("pre", { class: "code" }, JSON.stringify(view, null, 2)),
      ),
    );
  }
}

// --- §4 history: retraction, audit, time ----------------------------------------------------------

function renderHistory(): void {
  const host = $("w-history-claims");
  host.replaceChildren();
  const audit = ($("w-history-audit") as HTMLInputElement).checked;
  const slider = $("w-history-asof") as HTMLInputElement;
  slider.max = String(A.clock());
  if (slider.dataset["touched"] !== "yes") slider.value = slider.max;
  const asOf = Number(slider.value) >= A.clock() ? undefined : Number(slider.value);
  $("w-history-asof-label").textContent = asOf === undefined ? "now" : `as of t≤${asOf}`;

  // every positive claim, with a retract button for its own author
  for (const d of A.alice.reactor.arrivalLog()) {
    if (d.claims.pointers.some((p) => p.role === "negates")) continue;
    const retracted = A.alice.reactor.negationsOf(d.id).length > 0;
    const subject = d.claims.pointers.find((p) => p.target.kind === "entity");
    const ctx = subject?.target.kind === "entity" ? (subject.target.entity.context ?? "?") : "?";
    const row = el(
      "div",
      { class: `entry${retracted ? " retracted" : ""}` },
      el("span", { class: "mono" }, `t=${d.claims.timestamp} `),
      `${A.whoIs(d.claims.author)}: ${ctx} = `,
      el("span", { class: "mono val" }, valueOf(d.claims)),
      " ",
    );
    if (!retracted) {
      const btn = el("button", { class: "small" }, "retract");
      btn.onclick = () => {
        const peer = d.claims.author === A.alice.author ? A.alice : A.bob;
        const neg = makeNegationClaims(peer.author, A.tick(), d.id, "retracted in the tour");
        peer.authorClaims({ timestamp: neg.timestamp, pointers: [...neg.pointers] });
        syncBoth(A.alice, A.bob);
        refreshWorldA();
      };
      row.append(btn);
    } else {
      row.append(el("span", { class: "meta" }, " [retracted — but still right here]"));
    }
    host.append(row);
  }

  const out = $("w-history-out");
  const hview = hviewAt(A.alice, asOf, audit);
  if (audit) {
    const lines: string[] = [];
    for (const [prop, entries] of [...hview.props.entries()].sort()) {
      for (const e of entries) {
        lines.push(
          `${e.negated ? "✗" : "✓"} ${prop} = ${valueOf(e.delta.claims)}  — ${A.whoIs(
            e.delta.claims.author,
          )} @ t=${e.delta.claims.timestamp}${e.negated ? "  [retracted]" : ""}`,
        );
      }
    }
    out.textContent = lines.join("\n") || "(nothing here yet)";
  } else {
    const view = resolveView(POLICIES[0]!.make(), hview);
    out.textContent = JSON.stringify(view, null, 2);
  }
}

function widgetHistory(): void {
  const host = $("w-history");
  const audit = el("input", { type: "checkbox", id: "w-history-audit" });
  const slider = el("input", {
    type: "range",
    id: "w-history-asof",
    min: "1",
    max: String(A.clock()),
    value: String(A.clock()),
  });
  slider.addEventListener("input", () => {
    slider.dataset["touched"] = "yes";
    renderHistory();
  });
  audit.addEventListener("input", renderHistory);
  host.append(
    el("div", { class: "panel-title" }, "every claim ever made (the arrival log)"),
    el("div", { id: "w-history-claims" }),
    el(
      "div",
      { class: "controls" },
      el("label", { class: "field row" }, audit, el("span", {}, "audit lens (see retractions)")),
      el(
        "label",
        { class: "field grow" },
        el("span", {}, "time travel"),
        slider,
        el("span", { id: "w-history-asof-label", class: "mono" }, "now"),
      ),
    ),
    el("div", { class: "panel-title" }, "the view, through your chosen lens"),
    el("pre", { class: "code", id: "w-history-out" }),
  );
}

function refreshWorldA(): void {
  renderSuperposition();
  renderLenses();
  renderHistory();
  renderStats();
}

// --- §5 federation: two sovereign peers ----------------------------------------------------------

interface FedWorld {
  readonly pat: Peer;
  readonly quinn: Peer;
  tick(): number;
}

function makeWorldB(): FedWorld {
  const pat = new Peer("d4".repeat(32));
  const quinn = new Peer("e5".repeat(32));
  let clock = 100;
  const tick = (): number => ++clock;
  const claim = (peer: Peer, entity: string, context: string, value: string | number): void => {
    peer.authorClaims({
      timestamp: tick(),
      pointers: [
        { role: "subject", target: { kind: "entity", entity: { id: entity, context } } },
        { role: "value", target: { kind: "primitive", value } },
      ],
    });
  };
  claim(pat, "rover:spirit", "location", "Gusev Crater");
  claim(pat, "rover:spirit", "status", "silent since sol 2210");
  claim(quinn, "rover:spirit", "wheels", 6);
  claim(quinn, "rover:spirit", "status", "beloved");
  return { pat, quinn, tick };
}

const B = makeWorldB();

function renderFederation(): void {
  for (const [name, peer] of [
    ["Pat", B.pat],
    ["Quinn", B.quinn],
  ] as const) {
    const card = $(`w-fed-${name}`);
    card.replaceChildren();
    const digest = peer.reactor.digest();
    card.append(
      el("h3", {}, name),
      el(
        "div",
        { class: "digest mono", title: digest },
        `digest ${digest.slice(4, 16)}… · ${peer.reactor.size} deltas`,
      ),
    );
    const list = el("div", { class: "claims" });
    for (const d of peer.reactor.arrivalLog()) {
      const subject = d.claims.pointers.find((p) => p.target.kind === "entity");
      const ctx = subject?.target.kind === "entity" ? (subject.target.entity.context ?? "?") : "?";
      const own = d.claims.author === peer.author;
      list.append(
        el(
          "div",
          { class: "entry" },
          el("span", { class: "meta" }, own ? "(own) " : "(synced) "),
          `${ctx} = `,
          el("span", { class: "mono val" }, valueOf(d.claims)),
        ),
      );
    }
    card.append(list);
    const prop = el("input", { placeholder: "property" });
    const val = el("input", { placeholder: "value" });
    const add = el("button", { class: "small" }, "claim");
    add.onclick = () => {
      if (!prop.value || !val.value) return;
      peer.authorClaims({
        timestamp: B.tick(),
        pointers: [
          {
            role: "subject",
            target: { kind: "entity", entity: { id: "rover:spirit", context: prop.value } },
          },
          { role: "value", target: { kind: "primitive", value: parseValue(val.value) } },
        ],
      });
      prop.value = "";
      val.value = "";
      renderFederation();
      renderStats();
    };
    card.append(el("div", { class: "form" }, prop, val, add));
  }
  const a = B.pat.reactor.digest();
  const b = B.quinn.reactor.digest();
  const verdict = $("w-fed-verdict");
  verdict.replaceChildren();
  if (a === b) {
    verdict.append(
      el("div", { class: "ok" }, "✓ digests identical — the peers converged. Merge was union."),
    );
  } else {
    verdict.append(
      el("div", { class: "meta" }, "digests differ — the peers have diverged. Sync to converge."),
    );
  }
}

function widgetFederation(): void {
  const sync = $("w-fed-sync");
  sync.onclick = () => {
    syncBoth(B.pat, B.quinn);
    renderFederation();
    renderStats();
  };
  renderFederation();
}

// --- §5b shuffle & replay -------------------------------------------------------------------------

function widgetReplay(): void {
  const btn = $("w-replay-btn");
  const out = $("w-replay-out");
  btn.onclick = () => {
    const log: Delta[] = [...B.pat.reactor.arrivalLog()];
    const shuffled = [...log];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const fresh = new Reactor();
    for (const d of shuffled) fresh.ingest(d);
    const original = B.pat.reactor.digest();
    const replayed = fresh.digest();
    const order = shuffled.map((d) => log.indexOf(d) + 1).join(", ");
    const same = original === replayed;
    out.textContent =
      `replayed ${log.length} deltas in order [${order}]\n` +
      `original digest  ${original.slice(4, 36)}…\n` +
      `replayed digest  ${replayed.slice(4, 36)}…\n` +
      (same ? "✓ byte-identical. Order never matters." : "✗ DIVERGED — file a bug, this is a P0");
    flash(out as HTMLElement);
  };
}

// --- stats badge ----------------------------------------------------------------------------------

function renderStats(): void {
  const n = A.alice.reactor.size + A.bob.reactor.size + B.pat.reactor.size + B.quinn.reactor.size;
  $("live-stats").textContent =
    `${n} signed deltas currently live in this tab — authored, hashed, and verified by the real implementation.`;
}

// --- boot -----------------------------------------------------------------------------------------

widgetAtom();
widgetSuperposition();
widgetHistory();
widgetFederation();
widgetReplay();
refreshWorldA();
