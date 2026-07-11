// The Rhizomatic playground: the reference demo, but clickable. Three sovereign peers in one
// browser tab — author claims, retract them, sync selectively, and watch the same data resolve
// to different truths under different policies, at any point in claimed time.
// All semantics come from the tested library; this file is DOM glue only.

import { resolveView, type Schema, type View } from "../../src/resolution.js";
import { type HView } from "../../src/hview.js";
import { Peer } from "../../src/peer.js";
import { makeNegationClaims } from "../../src/set.js";
import { parseSchema, parseTerm } from "../../src/term-json.js";

// --- world state ------------------------------------------------------------------------------

const peers: Record<string, Peer> = {
  Alice: new Peer("a1".repeat(32)),
  Bob: new Peer("b2".repeat(32)),
  Carol: new Peer("c3".repeat(32)),
};
let clock = 0;
const tick = (): number => ++clock;

// seed the story
peers["Alice"]!.authorClaims(seedClaim("movie:blade_runner", "title", "Blade Runner"));
peers["Alice"]!.authorClaims(seedClaim("movie:blade_runner", "director", "Ridley Scott"));
peers["Bob"]!.authorClaims(seedClaim("movie:blade_runner", "director", "Denis Villeneuve"));
peers["Bob"]!.authorClaims(seedClaim("movie:blade_runner", "year", 1982));
peers["Carol"]!.authorClaims(seedClaim("movie:blade_runner", "rating", 9));

function seedClaim(entity: string, context: string, value: string | number) {
  return {
    timestamp: tick(),
    pointers: [
      { role: "movie", target: { kind: "entity" as const, entity: { id: entity, context } } },
      { role: context, target: { kind: "primitive" as const, value } },
    ],
  };
}

// --- view machinery ---------------------------------------------------------------------------

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

function schemaFor(kind: string): Schema {
  switch (kind) {
    case "trust-alice":
      return parseSchema({
        default: { pick: { order: { byAuthorRank: [peers["Alice"]!.author] } } },
      });
    case "trust-bob":
      return parseSchema({
        default: { pick: { order: { byAuthorRank: [peers["Bob"]!.author] } } },
      });
    case "conflicts":
      return parseSchema({
        props: { director: { conflicts: { order: { byTimestamp: "desc" } } } },
        default: { pick: { order: { byTimestamp: "desc" } } },
      });
    case "all":
      return parseSchema({ default: { all: { order: { byTimestamp: "asc" } } } });
    default:
      return parseSchema({ default: { pick: { order: { byTimestamp: "desc" } } } });
  }
}

function hviewAt(peer: Peer, root: string, asOf: number | undefined, audit: boolean): HView {
  const result = peer.reactor.eval(bodyTerm(asOf, audit), root);
  if (result.sort !== "hview") throw new Error("expected hview");
  return result.hview;
}

// --- DOM helpers ------------------------------------------------------------------------------

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

// --- rendering --------------------------------------------------------------------------------

function whoIs(author: string): string {
  for (const [name, p] of Object.entries(peers)) if (p.author === author) return name;
  return `${author.slice(8, 16)}…`;
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

function renderPeers(): void {
  for (const [name, peer] of Object.entries(peers)) {
    const card = $(`peer-${name}`);
    card.replaceChildren();
    card.append(
      el("h2", {}, name),
      el(
        "div",
        { class: "meta" },
        `${peer.reactor.size} deltas · digest ${peer.reactor.digest().slice(4, 12)}…`,
      ),
    );
    // own claims with retract buttons
    const list = el("div", { class: "claims" });
    for (const d of peer.reactor.arrivalLog()) {
      if (d.claims.author !== peer.author) continue;
      if (d.claims.pointers.some((p) => p.role === "negates")) continue;
      const alreadyRetracted = peer.reactor.negationsOf(d.id).length > 0;
      const subject = d.claims.pointers.find((p) => p.target.kind === "entity");
      const ctx = subject?.target.kind === "entity" ? (subject.target.entity.context ?? "?") : "?";
      const row = el(
        "div",
        { class: `claim${alreadyRetracted ? " retracted" : ""}` },
        `t=${d.claims.timestamp} ${ctx} = ${valueOf(d.claims)} `,
      );
      if (!alreadyRetracted) {
        const btn = el("button", { class: "small" }, "retract");
        btn.onclick = () => {
          const neg = makeNegationClaims(peer.author, tick(), d.id, "retracted in playground");
          peer.authorClaims({ timestamp: neg.timestamp, pointers: [...neg.pointers] });
          refresh();
        };
        row.append(btn);
      }
      list.append(row);
    }
    card.append(list);
    // author form
    const entity = el("input", { value: "movie:blade_runner", title: "entity" });
    const ctx = el("input", { placeholder: "property (context)", title: "context" });
    const val = el("input", { placeholder: "value", title: "value" });
    const add = el("button", {}, "claim");
    add.onclick = () => {
      if (!ctx.value || !val.value) return;
      const num = Number(val.value);
      const value = Number.isFinite(num) && val.value.trim() !== "" ? num : val.value;
      peer.authorClaims(seedClaim(entity.value, ctx.value, value));
      ctx.value = "";
      val.value = "";
      refresh();
    };
    card.append(el("div", { class: "form" }, entity, ctx, val, add));
    // sync buttons
    const syncRow = el("div", { class: "sync" }, "sync ⇄ ");
    for (const other of Object.keys(peers)) {
      if (other === name) continue;
      const btn = el("button", { class: "small" }, other);
      btn.onclick = () => {
        // pull both ways (anti-entropy)
        peer.pullFrom(peers[other]!);
        peers[other]!.pullFrom(peer);
        refresh();
      };
      syncRow.append(btn);
    }
    card.append(syncRow);
  }
}

function renderView(): void {
  const root = ($("root") as HTMLInputElement).value;
  const viewer = ($("viewer") as HTMLSelectElement).value;
  const schemaKind = ($("schema") as HTMLSelectElement).value;
  const audit = ($("audit") as HTMLInputElement).checked;
  const asOfRaw = ($("asof") as HTMLInputElement).value;
  const asOf = Number(asOfRaw) >= clock ? undefined : Number(asOfRaw);
  ($("asof") as HTMLInputElement).max = String(clock);
  $("asof-label").textContent = asOf === undefined ? "now" : `t≤${asOf}`;

  const peer = peers[viewer]!;
  const hview = hviewAt(peer, root, asOf, audit);

  if (audit) {
    const lines: string[] = [];
    for (const [prop, entries] of [...hview.props.entries()].sort()) {
      for (const e of entries) {
        lines.push(
          `${e.negated ? "✗" : "✓"} ${prop} = ${valueOf(e.delta.claims)}  — ${whoIs(e.delta.claims.author)} @ t=${e.delta.claims.timestamp}${e.negated ? "  [retracted]" : ""}`,
        );
      }
    }
    $("view-output").textContent = lines.join("\n") || "(nothing here yet)";
  } else {
    const resolved: View = resolveView(schemaFor(schemaKind), hview);
    $("view-output").textContent = JSON.stringify(resolved, null, 2);
  }

  // provenance
  const plainView = hviewAt(peer, root, asOf, true);
  const prov: string[] = [];
  for (const [prop, entries] of [...plainView.props.entries()].sort()) {
    for (const e of entries) {
      prov.push(
        `${prop}: ${e.delta.id.slice(4, 14)}… by ${whoIs(e.delta.claims.author)} t=${e.delta.claims.timestamp}${e.negated ? " [retracted]" : ""}`,
      );
    }
  }
  $("provenance").textContent = prov.join("\n") || "(no contributing deltas)";
}

function refresh(): void {
  renderPeers();
  renderView();
}

// --- wire up ----------------------------------------------------------------------------------

for (const id of ["root", "viewer", "schema", "audit", "asof"]) {
  $(id).addEventListener("input", renderView);
}
refresh();
