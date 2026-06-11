// The Rhizomatic tour: a narrated, interactive walk through the format. Every widget on this
// page runs the real, tested library — the same code that passes the conformance vectors.
// This file is DOM glue only; all semantics come from src/.

import { canonicalHex, computeId } from "../../src/delta.js";
import {
  DerivationHost,
  verifyPureDerivation,
  type BindingSpec,
  type DerivedFn,
} from "../../src/derivation.js";
import { evalTerm, resultCanonicalHex } from "../../src/eval.js";
import type { HView } from "../../src/hview.js";
import { claimsToJson, parseClaims } from "../../src/json-profile.js";
import { packId, packSet, unpackSet } from "../../src/pack.js";
import { Peer, syncBoth } from "../../src/peer.js";
import { resolveView, type Policy, type View } from "../../src/policy.js";
import { Reactor } from "../../src/reactor.js";
import { SchemaRegistry } from "../../src/schema.js";
import { VOCAB_PREFIX } from "../../src/schema-deltas.js";
import { DeltaSet, makeDelta, makeNegationClaims } from "../../src/set.js";
import { publicKeyFromSeed, signClaims, verifyDelta } from "../../src/sign.js";
import { parsePolicy, parseTerm } from "../../src/term-json.js";
import type { Claims, Delta, Pointer } from "../../src/types.js";

// The committed conformance vectors, bundled in at build time. CI's docs-freshness gate
// rebuilds this bundle, so the page can never drift from the vectors the witnesses pass.
import keysJson from "../../../../vectors/keys/keys.json" with { type: "json" };
import deltasJson from "../../../../vectors/l0-delta/deltas.json" with { type: "json" };
import signedJson from "../../../../vectors/l0-delta/deltas-signed.json" with { type: "json" };
import setDigestJson from "../../../../vectors/l0-delta/set-digest.json" with { type: "json" };
import evalBasicJson from "../../../../vectors/l1-eval/eval-basic.json" with { type: "json" };
import evalHviewJson from "../../../../vectors/l1-eval/eval-hview.json" with { type: "json" };
import evalExpandJson from "../../../../vectors/l1-eval/eval-expand.json" with { type: "json" };
import evalResolveJson from "../../../../vectors/l1-eval/eval-resolve.json" with { type: "json" };
import evalHolesJson from "../../../../vectors/l1-eval/eval-holes.json" with { type: "json" };

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
  const neg = claims.pointers.find((x) => x.role === "negates");
  if (neg !== undefined) return "(retraction)";
  const p = claims.pointers.find((x) => x.target.kind === "primitive");
  if (p !== undefined) {
    return JSON.stringify((p.target as unknown as { value: unknown }).value);
  }
  return "(edge)";
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
  const role = el("input", { value: "movie" });
  const prop = el("input", { value: "director" });
  const val = el("input", { value: "Ridley Scott" });

  const claimsOut = el("pre", { class: "code" });
  const bytesOut = el("div", { class: "bytes mono" });
  const bytesMeta = el("div", { class: "meta" });
  const idOut = el("div", { class: "id mono" });
  const rustLine = el("div", { class: "meta", style: "margin-top:0.5em" });
  const err = el("div", { class: "error" });

  const render = (): void => {
    // The native idiom: the entity pointer's role names what the target IS; its context names
    // the property this delta files under AT that target (SPEC-1 §2.3); the primitive pointer's
    // role names what the value IS. No subject anywhere.
    const claims: Claims = {
      author: author.value,
      timestamp: Number(ts.value),
      pointers: [
        {
          role: role.value,
          target: { kind: "entity", entity: { id: entity.value, context: prop.value } },
        },
        { role: prop.value, target: { kind: "primitive", value: parseValue(val.value) } },
      ],
    };
    claimsOut.textContent = JSON.stringify(claimsToJson(claims), null, 2);
    try {
      const hex = canonicalHex(claims);
      bytesOut.textContent = hex.replace(/(..)/g, "$1 ").trimEnd();
      bytesMeta.textContent = `${hex.length / 2} bytes of canonical CBOR — this IS the wire format`;
      const id = computeId(claims);
      idOut.textContent = id;
      err.textContent = "";
      flash(idOut);
      if (RUST !== null) {
        const r = RUST.call({ op: "canonical", claims: claimsToJson(claims) });
        const agree = okStr(r, "hex") === hex && okStr(r, "id") === id;
        rustLine.textContent = agree
          ? `🦀 the Rust witness (compiled to WebAssembly, also on this page) just computed the same ${hex.length / 2} bytes and the same id — two languages, zero coordination`
          : `🦀 RUST DISAGREES: ${r.err ?? "different bytes"} — this would be a P0 parity bug`;
        rustLine.className = agree ? "meta" : "error";
      } else {
        rustLine.textContent = rustFailed
          ? "(the Rust WASM witness couldn't load in this browser — CI still enforces byte parity)"
          : "loading the Rust witness (WASM)…";
      }
    } catch (e) {
      bytesOut.textContent = "—";
      bytesMeta.textContent = "";
      idOut.textContent = "—";
      rustLine.textContent = "";
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
      labeled("its role", role),
      labeled("property (context)", prop),
      labeled("value", val),
    ),
    el("div", { class: "panel-title" }, "the claims, as data (JSON debug profile)"),
    claimsOut,
    el("div", { class: "panel-title" }, "canonical bytes"),
    bytesOut,
    bytesMeta,
    el("div", { class: "panel-title" }, "content-derived identity (blake3-256 multihash)"),
    idOut,
    rustLine,
    err,
  );
  for (const i of [author, ts, entity, role, prop, val]) i.addEventListener("input", render);
  rustReady.push(render);
  render();
}

// --- §2 every pointer is a perspective -------------------------------------------------------------

function widgetPerspectives(): void {
  const host = $("w-perspectives");
  const leftId = el("input", { value: "movie:blade_runner" });
  const leftCtx = el("input", { value: "director" });
  const rightId = el("input", { value: "person:ridley_scott" });
  const rightCtx = el("input", { value: "movies" });

  const deltaOut = el("pre", { class: "code" });
  const idOut = el("div", { class: "meta mono" });
  const leftPane = el("pre", { class: "code" });
  const rightPane = el("pre", { class: "code" });
  const leftTitle = el("div", { class: "panel-title" });
  const rightTitle = el("div", { class: "panel-title" });
  const err = el("div", { class: "error" });

  const VIEW_TERM = parseTerm({
    op: "group",
    key: "byTargetContext",
    in: { op: "mask", policy: "drop", in: "input" },
  });
  const LATEST = parsePolicy({ default: { pick: { order: { byTimestamp: "desc" } } } });

  const paneFor = (set: DeltaSet, root: string): string => {
    const result = evalTerm(VIEW_TERM, set, root);
    if (result.sort !== "hview") return "(not an hview)";
    const view = resolveView(LATEST, result.hview);
    return Object.keys(view).length === 0
      ? "{}  ← no backpointer. The reference exists;\n    the property was never granted."
      : JSON.stringify(view, null, 2);
  };

  const render = (): void => {
    const entityRef = (id: string, ctx: string) => (ctx === "" ? { id } : { id, context: ctx });
    const claims: Claims = {
      author: "alice",
      timestamp: 1,
      pointers: [
        {
          role: "movie",
          target: { kind: "entity", entity: entityRef(leftId.value, leftCtx.value) },
        },
        {
          role: "director",
          target: { kind: "entity", entity: entityRef(rightId.value, rightCtx.value) },
        },
      ],
    };
    deltaOut.textContent = JSON.stringify(claimsToJson(claims), null, 2);
    try {
      const delta = makeDelta(claims);
      const set = DeltaSet.from([delta]);
      idOut.textContent = `one delta · id ${delta.id.slice(0, 24)}…`;
      leftTitle.textContent = `the view at ${leftId.value}`;
      rightTitle.textContent = `the view at ${rightId.value}`;
      leftPane.textContent = paneFor(set, leftId.value);
      rightPane.textContent = paneFor(set, rightId.value);
      err.textContent = "";
    } catch (e) {
      leftPane.textContent = "—";
      rightPane.textContent = "—";
      err.textContent = `the format refuses this delta: ${(e as Error).message}`;
    }
  };

  host.append(
    el(
      "div",
      { class: "controls" },
      labeled("entity A (role: movie)", leftId),
      labeled("context at A", leftCtx),
      labeled("entity B (role: director)", rightId),
      labeled("context at B", rightCtx),
    ),
    el("div", { class: "panel-title" }, "the delta (JSON debug profile)"),
    deltaOut,
    idOut,
    el(
      "div",
      { class: "persp-grid" },
      el("div", { class: "persp-cell" }, leftTitle, leftPane),
      el("div", { class: "persp-cell" }, rightTitle, rightPane),
    ),
    err,
  );
  for (const i of [leftId, leftCtx, rightId, rightCtx]) i.addEventListener("input", render);
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
  // Native idiom (SPEC-1 §2.3): the entity pointer's context names the property at the target;
  // the primitive pointer's role names what the value is.
  const claim = (context: string, value: string | number): Omit<Claims, "author"> => ({
    timestamp: tick(),
    pointers: [
      { role: "movie", target: { kind: "entity", entity: { id: ROOT, context } } },
      { role: context, target: { kind: "primitive", value: parseValue(String(value)) } },
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
          role: "movie",
          target: { kind: "entity", entity: { id: ROOT, context: "director" } },
        },
        { role: "director", target: { kind: "primitive", value: parseValue(val.value) } },
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

  // the full arrival log, append-only: claims AND the negations that retract them
  const describeTarget = (id: string): string => {
    const target = A.alice.reactor.get(id);
    if (target === undefined) return "?";
    const subject = target.claims.pointers.find((p) => p.target.kind === "entity");
    const ctx = subject?.target.kind === "entity" ? (subject.target.entity.context ?? "?") : "?";
    return `t=${target.claims.timestamp}'s ${ctx} = ${valueOf(target.claims)}`;
  };
  for (const d of A.alice.reactor.arrivalLog()) {
    const negPtr = d.claims.pointers.find((p) => p.role === "negates");
    if (negPtr !== undefined) {
      const targetId = negPtr.target.kind === "delta" ? negPtr.target.deltaRef.delta : "";
      host.append(
        el(
          "div",
          { class: "entry negation" },
          el("span", { class: "mono" }, `t=${d.claims.timestamp} `),
          `${A.whoIs(d.claims.author)} negates ${describeTarget(targetId)} `,
          el("span", { class: "meta" }, "— a new claim about an old claim; nothing was edited"),
        ),
      );
      continue;
    }
    const negIds = A.alice.reactor.negationsOf(d.id);
    const negAt = negIds
      .map((id) => A.alice.reactor.get(id)?.claims.timestamp)
      .filter((t): t is number => t !== undefined)
      .sort((x, y) => x - y)[0];
    const retracted = negAt !== undefined;
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
      row.append(el("span", { class: "meta" }, ` [negated at t=${negAt} — still right here]`));
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
  readonly kenobi: Peer;
  readonly vader: Peer;
  tick(): number;
}

const ANAKIN = "person:anakin_skywalker";

function makeWorldB(): FedWorld {
  const kenobi = new Peer("d4".repeat(32));
  const vader = new Peer("e5".repeat(32));
  let clock = 100;
  const tick = (): number => ++clock;
  const claim = (peer: Peer, context: string, value: string | number): void => {
    peer.authorClaims({
      timestamp: tick(),
      pointers: [
        { role: "person", target: { kind: "entity", entity: { id: ANAKIN, context } } },
        { role: context, target: { kind: "primitive", value } },
      ],
    });
  };
  claim(kenobi, "fate", "betrayed and murdered by Darth Vader");
  claim(kenobi, "lightsaber", "kept for his son");
  claim(vader, "fate", "became Darth Vader");
  claim(vader, "father_of", "Luke Skywalker");
  return { kenobi, vader, tick };
}

const B = makeWorldB();

function renderFederation(): void {
  for (const [name, peer] of [
    ["Obi-Wan", B.kenobi],
    ["Vader", B.vader],
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
            role: "person",
            target: { kind: "entity", entity: { id: ANAKIN, context: prop.value } },
          },
          { role: prop.value, target: { kind: "primitive", value: parseValue(val.value) } },
        ],
      });
      prop.value = "";
      val.value = "";
      renderFederation();
      renderStats();
    };
    card.append(el("div", { class: "form" }, prop, val, add));
  }
  const a = B.kenobi.reactor.digest();
  const b = B.vader.reactor.digest();
  const verdict = $("w-fed-verdict");
  verdict.replaceChildren();
  if (a === b) {
    verdict.append(
      el(
        "div",
        { class: "ok" },
        "✓ digests identical — the peers converged. Both points of view now travel together.",
      ),
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
    syncBoth(B.kenobi, B.vader);
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
    const log: Delta[] = [...B.kenobi.reactor.arrivalLog()];
    const shuffled = [...log];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const fresh = new Reactor();
    for (const d of shuffled) fresh.ingest(d);
    const original = B.kenobi.reactor.digest();
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

// --- the second witness: the Rust implementation, compiled to WASM --------------------------------
// Loaded over a hand-rolled (ptr, len) ABI — JSON request in, JSON response out. No wasm-bindgen,
// no generated glue: the same spirit as the hand-rolled CBOR encoders.

interface RustResponse {
  readonly ok?: Record<string, unknown>;
  readonly err?: string;
}

interface RustWitness {
  call(req: unknown): RustResponse;
}

let RUST: RustWitness | null = null;
let rustFailed = false;
const rustReady: Array<() => void> = [];

async function loadRustWitness(): Promise<RustWitness | null> {
  try {
    const res = await fetch("rust-witness.wasm");
    if (!res.ok) return null;
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
    const ex = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      rhz_alloc(len: number): number;
      rhz_dealloc(ptr: number, len: number): void;
      rhz_call(ptr: number, len: number): bigint;
    };
    return {
      call(req: unknown): RustResponse {
        const bytes = new TextEncoder().encode(JSON.stringify(req));
        const ptr = ex.rhz_alloc(bytes.length);
        new Uint8Array(ex.memory.buffer).set(bytes, ptr);
        const packed = ex.rhz_call(ptr, bytes.length);
        ex.rhz_dealloc(ptr, bytes.length);
        const outPtr = Number(packed >> 32n);
        const outLen = Number(packed & 0xffffffffn);
        const out = new TextDecoder().decode(
          new Uint8Array(ex.memory.buffer.slice(outPtr, outPtr + outLen)),
        );
        ex.rhz_dealloc(outPtr, outLen);
        return JSON.parse(out) as RustResponse;
      },
    };
  } catch {
    return null;
  }
}

function okStr(r: RustResponse, key: string): string | undefined {
  const v = r.ok?.[key];
  return typeof v === "string" ? v : undefined;
}

function okBool(r: RustResponse, key: string): boolean {
  return r.ok?.[key] === true;
}

// --- §6 run the conformance vectors in the browser ------------------------------------------------

interface VecCase {
  readonly name: string;
  readonly pass: boolean;
}

interface Suite {
  readonly label: string;
  readonly file: string;
  readonly cases: VecCase[];
}

interface DeltaVector {
  name: string;
  claims: unknown;
  canonicalCborHex: string;
  id: string;
}

interface SignedVector extends DeltaVector {
  keyId: string;
  sig: string;
}

interface KeyVector {
  keyId: string;
  seedHex: string;
  publicKeyHex: string;
  author: string;
}

interface EvalDoc {
  fixture: { deltas: Array<{ name: string; id: string; claims: unknown }> };
  schemas?: Array<{ name: string; alg: number; body: unknown }>;
  cases: Array<{ name: string; root?: string; term: unknown; expectedCanonicalHex: string }>;
}

const tryCase = (name: string, check: () => boolean): VecCase => {
  try {
    return { name, pass: check() };
  } catch {
    return { name, pass: false };
  }
};

function evalSuite(label: string, file: string, doc: EvalDoc): Suite {
  const set = DeltaSet.from(doc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims))));
  const registry =
    doc.schemas === undefined
      ? undefined
      : SchemaRegistry.build(
          doc.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
        );
  const cases: VecCase[] = [
    tryCase("fixture ids are pinned", () =>
      doc.fixture.deltas.every((d) => makeDelta(parseClaims(d.claims)).id === d.id),
    ),
    ...doc.cases.map((c) =>
      tryCase(c.name, () => {
        const result = evalTerm(parseTerm(c.term), set, c.root, registry);
        return resultCanonicalHex(result) === c.expectedCanonicalHex;
      }),
    ),
  ];
  return { label, file, cases };
}

function runConformance(): Suite[] {
  const keys = keysJson as unknown as KeyVector[];
  const deltas = deltasJson as unknown as DeltaVector[];
  const signed = signedJson as unknown as SignedVector[];
  const setDigest = setDigestJson as unknown as { ids: string[]; digest: string };
  return [
    {
      label: "canonical CBOR bytes + content addresses",
      file: "vectors/l0-delta/deltas.json",
      cases: deltas.map((v) =>
        tryCase(v.name, () => {
          const claims = parseClaims(v.claims);
          return canonicalHex(claims) === v.canonicalCborHex && computeId(claims) === v.id;
        }),
      ),
    },
    {
      label: "Ed25519 keys derive from pinned seeds",
      file: "vectors/keys/keys.json",
      cases: keys.map((k) =>
        tryCase(k.keyId, () => {
          return (
            publicKeyFromSeed(k.seedHex) === k.publicKeyHex &&
            k.author === `ed25519:${k.publicKeyHex}`
          );
        }),
      ),
    },
    {
      label: "deterministic signatures, verification, tamper-rejection",
      file: "vectors/l0-delta/deltas-signed.json",
      cases: signed.map((v) =>
        tryCase(v.name, () => {
          const key = keys.find((k) => k.keyId === v.keyId);
          if (key === undefined) return false;
          const claims = parseClaims(v.claims);
          const resigned = signClaims(claims, key.seedHex);
          const tampered = verifyDelta({
            id: resigned.id,
            claims: { ...claims, timestamp: claims.timestamp + 1 },
            sig: resigned.sig ?? "",
          });
          return (
            canonicalHex(claims) === v.canonicalCborHex &&
            computeId(claims) === v.id &&
            resigned.sig === v.sig &&
            verifyDelta(resigned) === "verified" &&
            tampered === "invalid"
          );
        }),
      ),
    },
    {
      label: "delta-set digest (order-independent)",
      file: "vectors/l0-delta/set-digest.json",
      cases: [
        tryCase("set of all deltas.json vectors", () => {
          const s = DeltaSet.from(deltas.map((v) => makeDelta(parseClaims(v.claims))));
          return (
            JSON.stringify(s.ids()) === JSON.stringify(setDigest.ids) &&
            s.digest() === setDigest.digest
          );
        }),
      ],
    },
    evalSuite(
      "evaluator: select / union / mask",
      "vectors/l1-eval/eval-basic.json",
      evalBasicJson as unknown as EvalDoc,
    ),
    evalSuite(
      "evaluator: group / prune (HyperViews)",
      "vectors/l1-eval/eval-hview.json",
      evalHviewJson as unknown as EvalDoc,
    ),
    evalSuite(
      "evaluator: expand / fix (schemas)",
      "vectors/l1-eval/eval-expand.json",
      evalExpandJson as unknown as EvalDoc,
    ),
    evalSuite(
      "evaluator: resolve (policies → Views)",
      "vectors/l1-eval/eval-resolve.json",
      evalResolveJson as unknown as EvalDoc,
    ),
    evalSuite(
      "evaluator: parameterized terms (holes)",
      "vectors/l1-eval/eval-holes.json",
      evalHolesJson as unknown as EvalDoc,
    ),
  ];
}

// The same suites, asked of the Rust witness over the WASM ABI. Labels match runConformance()
// so the widget can render the two witnesses side by side.
function runRustConformance(rust: RustWitness): Map<string, VecCase[]> {
  const keys = keysJson as unknown as KeyVector[];
  const deltas = deltasJson as unknown as DeltaVector[];
  const signed = signedJson as unknown as SignedVector[];
  const setDigest = setDigestJson as unknown as { ids: string[]; digest: string };
  const out = new Map<string, VecCase[]>();
  out.set(
    "canonical CBOR bytes + content addresses",
    deltas.map((v) =>
      tryCase(v.name, () => {
        const r = rust.call({ op: "canonical", claims: v.claims });
        return okStr(r, "hex") === v.canonicalCborHex && okStr(r, "id") === v.id;
      }),
    ),
  );
  out.set(
    "deterministic signatures, verification, tamper-rejection",
    signed.map((v) =>
      tryCase(v.name, () => {
        const key = keys.find((k) => k.keyId === v.keyId);
        if (key === undefined) return false;
        const r = rust.call({ op: "sign", claims: v.claims, seedHex: key.seedHex });
        return okStr(r, "sig") === v.sig && okBool(r, "verified") && okBool(r, "tamperRejected");
      }),
    ),
  );
  out.set("delta-set digest (order-independent)", [
    tryCase("set of all deltas.json vectors", () => {
      const r = rust.call({ op: "setDigest", deltas: deltas.map((v) => v.claims) });
      return (
        JSON.stringify(r.ok?.["ids"]) === JSON.stringify(setDigest.ids) &&
        okStr(r, "digest") === setDigest.digest
      );
    }),
  ]);
  const rustEval = (label: string, doc: EvalDoc): void => {
    out.set(
      label,
      doc.cases.map((c) =>
        tryCase(c.name, () => {
          const req: Record<string, unknown> = {
            op: "eval",
            fixture: doc.fixture.deltas.map((d) => d.claims),
            term: c.term,
          };
          if (c.root !== undefined) req["root"] = c.root;
          if (doc.schemas !== undefined) req["schemas"] = doc.schemas;
          return okStr(rust.call(req), "hex") === c.expectedCanonicalHex;
        }),
      ),
    );
  };
  rustEval("evaluator: select / union / mask", evalBasicJson as unknown as EvalDoc);
  rustEval("evaluator: group / prune (HyperViews)", evalHviewJson as unknown as EvalDoc);
  rustEval("evaluator: expand / fix (schemas)", evalExpandJson as unknown as EvalDoc);
  rustEval("evaluator: resolve (policies → Views)", evalResolveJson as unknown as EvalDoc);
  rustEval("evaluator: parameterized terms (holes)", evalHolesJson as unknown as EvalDoc);
  return out;
}

function widgetConformance(): void {
  const host = $("w-conformance");
  const btn = el("button", { class: "big" }, "▶ re-run the vectors");
  const out = el("div", { class: "suites" });
  const run = (): void => {
    const t0 = performance.now();
    const suites = runConformance();
    const rustSuites = RUST === null ? null : runRustConformance(RUST);
    const ms = Math.max(1, Math.round(performance.now() - t0));
    out.replaceChildren();
    let pass = 0;
    let total = 0;
    for (const s of suites) {
      const ok = s.cases.filter((c) => c.pass).length;
      pass += ok;
      total += s.cases.length;
      const rust = rustSuites?.get(s.label);
      let rustNote = "";
      if (rust !== undefined) {
        const rustOk = rust.filter((c) => c.pass).length;
        pass += rustOk;
        total += rust.length;
        rustNote = ` · Rust ${rustOk}/${rust.length}`;
      }
      const allGreen = ok === s.cases.length && (rust === undefined || rust.every((c) => c.pass));
      const row = el(
        "div",
        { class: "entry" },
        el("span", { class: allGreen ? "val" : "error" }, allGreen ? "✓ " : "✗ "),
        `${s.label} — TS ${ok}/${s.cases.length}${rustNote} `,
        el("span", { class: "meta mono" }, s.file),
      );
      for (const c of s.cases.filter((x) => !x.pass)) {
        row.append(el("div", { class: "error" }, `  ✗ TS: ${c.name}`));
      }
      for (const c of (rust ?? []).filter((x) => !x.pass)) {
        row.append(el("div", { class: "error" }, `  ✗ Rust: ${c.name}`));
      }
      out.append(row);
    }
    const witnesses =
      rustSuites === null
        ? rustFailed
          ? " (TypeScript only — the Rust WASM witness couldn't load in this browser; CI still enforces parity)"
          : " (TypeScript — the Rust WASM witness is still loading…)"
        : " across BOTH witnesses — TypeScript, and Rust compiled to WebAssembly";
    out.append(
      el(
        "div",
        { class: pass === total ? "ok" : "error", style: "margin-top:0.8em" },
        pass === total
          ? `✓ ${pass}/${total} green in ${ms} ms${witnesses}. Your browser is now a conformance witness.`
          : `✗ ${pass}/${total} — a vector failed; this page is out of sync with the suite.`,
      ),
    );
    flash(out);
  };
  btn.onclick = run;
  host.append(out, btn);
  rustReady.push(run);
  run();
}

// --- §6c packs: the bytes at rest -------------------------------------------------------------------

function widgetPack(): void {
  const btn = $("w-pack-btn");
  const out = $("w-pack-out");
  btn.onclick = () => {
    const snapshot = B.kenobi.reactor.snapshot();
    const bytes = packSet(snapshot);
    const restored = unpackSet(bytes);
    const match = restored.digest() === snapshot.digest();
    out.textContent =
      `packed ${snapshot.size} deltas → ${bytes.length} bytes of canonical CBOR\n` +
      `packId   ${packId(bytes).slice(0, 32)}…  (same set ⇒ same bytes ⇒ same id)\n` +
      `unpacked → ${restored.size} deltas, digest ${match ? "IDENTICAL" : "MISMATCH"}\n` +
      (match
        ? "✓ rehydration is self-verifying — a corrupted pack fails, loudly."
        : "✗ round-trip diverged — file a bug, this is a P0");
    flash(out);
  };
}

// --- §7 computation is an author -------------------------------------------------------------------

function widgetDerivation(): void {
  const host = $("w-derivation");
  const root = "movie:blade_runner";
  const body = parseTerm({
    op: "group",
    key: "byTargetContext",
    in: {
      op: "select",
      pred: { hasPointer: { targetEntity: { var: "root" } } },
      in: { op: "mask", policy: "drop", in: "input" },
    },
  });
  const reactor = new Reactor();
  reactor.register("movie", body, [root]);
  const bot = new DerivationHost(reactor);

  let clock = 1000;
  const dataClaim = (context: string, value: string | number, author: string): Delta =>
    makeDelta({
      timestamp: ++clock,
      author,
      pointers: [
        { role: "movie", target: { kind: "entity", entity: { id: root, context } } },
        { role: context, target: { kind: "primitive", value } },
      ],
    });

  const avgFn: DerivedFn = (view: HView, r: string): Pointer[][] => {
    const nums = (view.props.get("rating") ?? [])
      .flatMap((e) => e.delta.claims.pointers)
      .filter((p) => p.target.kind === "primitive")
      .map((p) => (p.target as { value: unknown }).value)
      .filter((v): v is number => typeof v === "number");
    if (nums.length === 0) return [];
    const avg = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
    return [
      [
        { role: "movie", target: { kind: "entity", entity: { id: r, context: "avgRating" } } },
        { role: "avgRating", target: { kind: "primitive", value: avg } },
      ],
    ];
  };
  // The forgery probe for the replay check: same shape, quietly inflated output.
  const tamperedFn: DerivedFn = (v, r) =>
    avgFn(v, r).map((ptrs) =>
      ptrs.map((p) =>
        p.target.kind === "primitive" && typeof p.target.value === "number"
          ? { ...p, target: { kind: "primitive" as const, value: p.target.value + 1 } }
          : p,
      ),
    );
  const spec: BindingSpec = {
    name: "binding:avg",
    fnId: "fn:avgRating",
    materialization: "movie",
    pure: true,
    budget: 100,
    emit: "supersede",
  };
  const botAuthor = bot.install(spec, avgFn, "f6".repeat(32));

  // Arrival count through the latest emission's input (the rating that triggered it) —
  // replay verification reconstructs the pinned input view from exactly this prefix.
  let lastInputLen = 0;
  const rate = (n: number, author: string): void => {
    const before = reactor.arrivalLog().length;
    bot.ingest(dataClaim("rating", n, author));
    lastInputLen = before + 1;
  };

  bot.ingest(dataClaim("title", "Blade Runner", "did:key:zAlice"));
  rate(9, "did:key:zCarol");
  rate(8, "did:key:zDana");

  const ratingsOut = el("div", { class: "meta" });
  const receiptOut = el("pre", { class: "code" });
  const verifyOut = el("div", {});

  const latestEmission = (): Delta | undefined => {
    const log = reactor.arrivalLog();
    for (let i = log.length - 1; i >= 0; i--) {
      const d = log[i]!;
      if (d.claims.author !== botAuthor) continue;
      if (d.claims.pointers.some((p) => p.role === "negates")) continue;
      return d;
    }
    return undefined;
  };

  const render = (): void => {
    const view = reactor.materializedView("movie", root);
    const ratings = view ? (view.props.get("rating") ?? []) : [];
    ratingsOut.textContent = `${ratings.length} ratings on record: ${ratings
      .map((e) => valueOf(e.delta.claims))
      .join(", ")}`;
    const emitted = latestEmission();
    if (emitted === undefined) {
      receiptOut.textContent = "(no emission yet — rate the movie)";
      return;
    }
    const prov = (suffix: string): string => {
      const p = emitted.claims.pointers.find((x) => x.role === `${VOCAB_PREFIX}.derived.${suffix}`);
      if (p === undefined) return "?";
      if (p.target.kind === "primitive") return String(p.target.value);
      if (p.target.kind === "entity") return p.target.entity.id;
      return p.target.kind;
    };
    receiptOut.textContent = [
      `avgRating = ${valueOf(emitted.claims)}`,
      ``,
      `author  ${emitted.claims.author.slice(0, 32)}…  (the bot's own keypair)`,
      `id      ${emitted.id.slice(0, 32)}…`,
      `${VOCAB_PREFIX}.derived.by    = ${prov("by")}`,
      `${VOCAB_PREFIX}.derived.from  = ${prov("from").slice(0, 24)}…  (the exact input view, pinned byte for byte)`,
      `${VOCAB_PREFIX}.derived.under = ${prov("under")}`,
    ].join("\n");
    verifyOut.replaceChildren();
  };

  const verify = (): void => {
    const emitted = latestEmission();
    if (emitted === undefined) return;
    // Rebuild the pinned input from first principles: a fresh reactor fed the arrival
    // prefix up to and including the triggering rating, nothing else.
    const probe = new Reactor();
    probe.register("movie", body, [root]);
    for (const d of reactor.arrivalLog().slice(0, lastInputLen)) probe.ingest(d);
    const viewHex = probe.materializedHex("movie", root);
    const view = probe.materializedView("movie", root);
    if (view === undefined || viewHex === undefined) return;
    const genuine = verifyPureDerivation(emitted, spec, avgFn, view, root, viewHex);
    const tampered = verifyPureDerivation(emitted, spec, tamperedFn, view, root, viewHex);
    verifyOut.replaceChildren(
      el(
        "div",
        { class: genuine ? "ok" : "error" },
        genuine
          ? "✓ replay verified — re-ran the function on the pinned input; the recomputed content address matches the claim's id, and the signature checks out"
          : "✗ replay FAILED — this receipt does not check out",
      ),
      el(
        "div",
        { class: tampered ? "error" : "ok" },
        tampered
          ? "✗ the tampered function ALSO verified — that would be a bug"
          : "✓ and a tampered function (+1 to every average) fails the same replay — forgery is detectable, not just discouraged",
      ),
    );
    flash(verifyOut);
  };

  const buttons = el("div", { class: "controls" });
  for (const n of [6, 7, 8, 9, 10]) {
    const b = el("button", {}, `rate ${n}`);
    b.onclick = () => {
      rate(n, "did:key:zYou");
      render();
    };
    buttons.append(b);
  }
  const verifyBtn = el(
    "button",
    { class: "big", style: "margin-top:0.8em" },
    "🔍 replay-verify the receipt",
  );
  verifyBtn.onclick = verify;

  host.append(
    el("div", { class: "panel-title" }, "rate the movie (as did:key:zYou)"),
    buttons,
    ratingsOut,
    el(
      "div",
      { class: "panel-title" },
      "the bot's latest claim — an ordinary signed delta, carrying its receipt",
    ),
    receiptOut,
    verifyBtn,
    verifyOut,
  );
  render();
}

// --- stats badge ----------------------------------------------------------------------------------

function renderStats(): void {
  const n =
    A.alice.reactor.size + A.bob.reactor.size + B.kenobi.reactor.size + B.vader.reactor.size;
  $("live-stats").textContent =
    `${n} signed deltas currently live in this tab — authored, hashed, and verified by the real implementation.`;
}

// --- boot -----------------------------------------------------------------------------------------

widgetAtom();
widgetPerspectives();
widgetSuperposition();
widgetHistory();
widgetFederation();
widgetReplay();
widgetPack();
widgetDerivation();
widgetConformance();
refreshWorldA();

// The second witness arrives asynchronously; widgets re-render when it lands.
void loadRustWitness().then((w) => {
  RUST = w;
  rustFailed = w === null;
  for (const cb of rustReady) cb();
});
