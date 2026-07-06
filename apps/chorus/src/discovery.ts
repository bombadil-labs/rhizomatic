// Discovery: what does this store know about, and which names co-refer? Topics and search
// answer the first; sameAs claims answer the second — canonical identity as JUDGMENT, not as
// a registry. A "DNS" here is just an author whose sameAs/naming claims you rank highly.

import { evalTerm, parseTerm, type Delta, type Pointer, type View } from "@bombadil/rhizomatic";
import type { ChorusAgent, RecallOptions } from "./agent.js";
import { CHORUS_PREFIX, ROLE_ABOUT, ROLE_VALUE } from "./vocab.js";

export const ROLE_SAME = `${CHORUS_PREFIX}.same.entity`;
export const ROLE_SAME_REASON = `${CHORUS_PREFIX}.same.reason`;

const INTERNAL_PREFIXES = ["session:", "concept:"];
const isInternalEntity = (id: string): boolean => INTERNAL_PREFIXES.some((p) => id.startsWith(p));
const isInternalContext = (ctx: string): boolean =>
  ctx.startsWith("chorus.") || ctx.startsWith("rhizomatic.");

// The surviving set: negations applied once, then scanned (discovery never counts the dead).
function surviving(agent: ChorusAgent): Delta[] {
  const result = evalTerm(parseTerm({ op: "mask", policy: "drop", in: "input" }), agent.snapshot());
  if (result.sort !== "dset") throw new Error("mask must yield a DSet");
  return [...result.set];
}

export interface Topic {
  readonly entity: string;
  readonly attributes: readonly string[];
  readonly claims: number;
  readonly authors: number;
  readonly lastTimestamp: number;
}

// Every entity the store holds beliefs about, most recently touched first.
export function topics(
  agent: ChorusAgent,
  opts: { prefix?: string; limit?: number } = {},
): Topic[] {
  const acc = new Map<
    string,
    { attributes: Set<string>; claims: number; authors: Set<string>; last: number }
  >();
  for (const d of surviving(agent)) {
    for (const p of d.claims.pointers) {
      if (p.target.kind !== "entity") continue;
      const id = p.target.entity.id;
      const ctx = p.target.entity.context;
      if (isInternalEntity(id)) continue;
      if (ctx === undefined || isInternalContext(ctx)) continue;
      if (opts.prefix !== undefined && !id.startsWith(opts.prefix)) continue;
      let t = acc.get(id);
      if (t === undefined) {
        t = { attributes: new Set(), claims: 0, authors: new Set(), last: 0 };
        acc.set(id, t);
      }
      t.attributes.add(ctx);
      t.claims += 1;
      t.authors.add(d.claims.author);
      t.last = Math.max(t.last, d.claims.timestamp);
    }
  }
  return [...acc.entries()]
    .map(([entity, t]) => ({
      entity,
      attributes: [...t.attributes].sort(),
      claims: t.claims,
      authors: t.authors.size,
      lastTimestamp: t.last,
    }))
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp || (a.entity < b.entity ? -1 : 1))
    .slice(0, opts.limit ?? 50);
}

export interface SearchHit {
  readonly entity: string;
  readonly attribute: string;
  readonly value: string | number | boolean;
  readonly deltaId: string;
  readonly author: string;
  readonly timestamp: number;
}

// Case-insensitive substring search over belief values, attribute names, and entity ids.
export function search(agent: ChorusAgent, query: string, limit = 25): SearchHit[] {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const d of surviving(agent)) {
    let about: { id: string; attribute: string } | undefined;
    let value: string | number | boolean | undefined;
    for (const p of d.claims.pointers) {
      if (p.role === ROLE_ABOUT && p.target.kind === "entity") {
        const ctx = p.target.entity.context;
        if (ctx !== undefined) about = { id: p.target.entity.id, attribute: ctx };
      } else if (p.role === ROLE_VALUE) {
        value =
          p.target.kind === "primitive"
            ? p.target.value
            : p.target.kind === "entity"
              ? p.target.entity.id
              : undefined;
      }
    }
    if (about === undefined || value === undefined) continue;
    const haystack = `${about.id} ${about.attribute} ${String(value)}`.toLowerCase();
    if (!haystack.includes(q)) continue;
    hits.push({
      entity: about.id,
      attribute: about.attribute,
      value,
      deltaId: d.id,
      author: d.claims.author,
      timestamp: d.claims.timestamp,
    });
    if (hits.length >= limit) break;
  }
  return hits.sort((a, b) => b.timestamp - a.timestamp || (a.deltaId < b.deltaId ? -1 : 1));
}

// Assert that two ids name the same thing — a signed, negatable, confidence-bearing judgment.
export function sameAsPointers(a: string, b: string, reason?: string): Pointer[] {
  const pointers: Pointer[] = [
    { role: ROLE_SAME, target: { kind: "entity", entity: { id: a } } },
    { role: ROLE_SAME, target: { kind: "entity", entity: { id: b } } },
  ];
  if (reason !== undefined) {
    pointers.push({ role: ROLE_SAME_REASON, target: { kind: "primitive", value: reason } });
  }
  return pointers;
}

// The equivalence class of an entity under surviving sameAs claims (union-find, one pass).
export function sameAsClass(agent: ChorusAgent, entity: string): string[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx < ry ? ry : rx, rx < ry ? rx : ry);
  };
  for (const d of surviving(agent)) {
    const members = d.claims.pointers
      .filter((p) => p.role === ROLE_SAME && p.target.kind === "entity")
      .map((p) => (p.target.kind === "entity" ? p.target.entity.id : ""));
    for (let i = 1; i < members.length; i++) union(members[0]!, members[i]!);
  }
  const root = find(entity);
  const cls = new Set<string>([entity, root]);
  for (const key of parent.keys()) if (find(key) === root) cls.add(key);
  return [...cls].sort();
}

// Recall through the equivalence class: every co-referring id's beliefs, one view. Properties
// claimed under several ids merge; conflicting values surface as arrays (visible, not hidden).
export function recallUnified(
  agent: ChorusAgent,
  entity: string,
  opts: RecallOptions = {},
): { view: View; class: string[] } {
  const cls = sameAsClass(agent, entity);
  const merged: Record<string, View> = {};
  for (const member of cls) {
    const view = agent.recall(member, opts);
    if (typeof view !== "object" || Array.isArray(view)) continue;
    for (const [prop, value] of Object.entries(view)) {
      const prior = merged[prop];
      if (prior === undefined) {
        merged[prop] = value;
      } else if (JSON.stringify(prior) !== JSON.stringify(value)) {
        merged[prop] = Array.isArray(prior) ? [...prior, value] : [prior, value];
      }
    }
  }
  return { view: merged, class: cls };
}
