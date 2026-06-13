// The briefing: what a session should have top-of-mind, computed fresh from the store. This
// is the MEMORY.md of Chorus — except every line has provenance, contested facts surface as
// contested instead of last-write-wins, and standing trust edits rehydrate into the lens.

import { evalTerm, parseTerm, type Delta } from "@rhizomatic/core";
import type { ChorusAgent } from "./agent.js";
import { sameAsClass, topics, type Topic } from "./discovery.js";
import { identityIndex } from "./identity.js";
import {
  ROLE_ABOUT,
  ROLE_KIND,
  ROLE_TRUST_AUTHOR,
  ROLE_TRUST_REASON,
  ROLE_TRUST_VERDICT,
  ROLE_VALUE,
} from "./vocab.js";

function surviving(agent: ChorusAgent): Delta[] {
  const result = evalTerm(parseTerm({ op: "mask", policy: "drop", in: "input" }), agent.snapshot());
  if (result.sort !== "dset") throw new Error("mask must yield a DSet");
  return [...result.set];
}

interface BeliefRow {
  readonly entity: string;
  readonly attribute: string;
  readonly value: string | number | boolean;
  readonly author: string;
  readonly timestamp: number;
  readonly deltaId: string;
}

function beliefRows(deltas: readonly Delta[]): { row: BeliefRow; kind: string }[] {
  const out: { row: BeliefRow; kind: string }[] = [];
  for (const d of deltas) {
    let entity: string | undefined;
    let attribute: string | undefined;
    let value: string | number | boolean | undefined;
    let kind = "observation";
    for (const p of d.claims.pointers) {
      if (p.role === ROLE_ABOUT && p.target.kind === "entity") {
        if (p.target.entity.context !== undefined) {
          entity = p.target.entity.id;
          attribute = p.target.entity.context;
        }
      } else if (p.role === ROLE_VALUE) {
        value =
          p.target.kind === "primitive"
            ? p.target.value
            : p.target.kind === "entity"
              ? p.target.entity.id
              : undefined;
      } else if (p.role === ROLE_KIND && p.target.kind === "primitive") {
        kind = String(p.target.value);
      }
    }
    if (entity === undefined || attribute === undefined || value === undefined) continue;
    out.push({
      row: {
        entity,
        attribute,
        value,
        author: d.claims.author,
        timestamp: d.claims.timestamp,
        deltaId: d.id,
      },
      kind,
    });
  }
  return out;
}

// Latest surviving belief per (entity, attribute) of a kind.
function latestOfKind(rows: { row: BeliefRow; kind: string }[], kind: string): BeliefRow[] {
  const best = new Map<string, BeliefRow>();
  for (const { row, kind: k } of rows) {
    if (k !== kind) continue;
    const key = `${row.entity}\u0000${row.attribute}`;
    const prior = best.get(key);
    if (prior === undefined || row.timestamp > prior.timestamp) best.set(key, row);
  }
  return [...best.values()].sort((a, b) => b.timestamp - a.timestamp);
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly model: string;
  readonly startedAt?: number;
  readonly purpose?: string;
  readonly summary?: string;
  readonly endedAt?: number;
  readonly topics?: readonly string[];
}

// A briefing scope: what this session declared itself to be ABOUT (begin-session topics).
// Real entity ids scope exactly; a trailing-":" value scopes a whole id-prefix family.
export interface BriefingScope {
  readonly topics: readonly string[];
}

export interface Briefing {
  readonly preferences: readonly BeliefRow[]; // ALWAYS global: they are about the principal,
  // who is party to every session — scope governs what's about the world, not the user
  readonly openTasks: readonly BeliefRow[]; // task-kind beliefs, latest per slot, in scope
  readonly recentSessions: readonly SessionSummary[];
  readonly topics: readonly Topic[];
  readonly contested: readonly { entity: string; attribute: string; values: unknown[] }[];
  readonly distrusted: readonly { author: string; reason?: string; by: string }[];
  readonly scope?: { declared: readonly string[]; entities: number };
  // Disagreement outside the scope is never hidden — it compresses to an honest count.
  // Discoverable beats injected: the contests are one topics/recall away.
  readonly contestedElsewhere?: number;
}

// Surviving belief deltas whose value is an entity REFERENCE: (about, referent) pairs.
// These are the typed edges remember {value: {entity}} writes — the scope crawls them.
function referencePairs(deltas: readonly Delta[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const d of deltas) {
    let about: string | undefined;
    let ref: string | undefined;
    for (const p of d.claims.pointers) {
      if (p.role === ROLE_ABOUT && p.target.kind === "entity") {
        if (p.target.entity.context !== undefined) about = p.target.entity.id;
      } else if (p.role === ROLE_VALUE && p.target.kind === "entity") {
        ref = p.target.entity.id;
      }
    }
    if (about !== undefined && ref !== undefined) pairs.push([about, ref]);
  }
  return pairs;
}

// Expand declared topics into the in-scope entity set: exact ids, their sameAs equivalence
// classes, prefix-pattern matches — then one hop along typed references, both directions.
function scopeEntities(
  agent: ChorusAgent,
  alive: readonly Delta[],
  declared: readonly string[],
  allEntities: readonly string[],
): Set<string> {
  const exact = declared.filter((t) => !t.endsWith(":"));
  const prefixes = declared.filter((t) => t.endsWith(":"));
  const seeds = new Set<string>(exact);
  for (const id of exact) for (const member of sameAsClass(agent, id)) seeds.add(member);
  for (const e of allEntities) if (prefixes.some((p) => e.startsWith(p))) seeds.add(e);
  const inScope = new Set(seeds);
  for (const [about, ref] of referencePairs(alive)) {
    if (seeds.has(about)) inScope.add(ref);
    if (seeds.has(ref)) inScope.add(about);
  }
  return inScope;
}

// Standing trust edits in the store, applied to this agent's lens (non-writing).
export function rehydrateTrust(
  agent: ChorusAgent,
): { author: string; reason?: string; by: string }[] {
  const edits: { author: string; reason?: string; by: string }[] = [];
  for (const d of surviving(agent)) {
    let author: string | undefined;
    let verdict: string | undefined;
    let reason: string | undefined;
    for (const p of d.claims.pointers) {
      if (p.role === ROLE_TRUST_AUTHOR && p.target.kind === "primitive") {
        author = String(p.target.value);
      } else if (p.role === ROLE_TRUST_VERDICT && p.target.kind === "primitive") {
        verdict = String(p.target.value);
      } else if (p.role === ROLE_TRUST_REASON && p.target.kind === "primitive") {
        reason = String(p.target.value);
      }
    }
    if (author === undefined || verdict !== "distrusted") continue;
    agent.applyDistrust(author);
    edits.push({ author, ...(reason === undefined ? {} : { reason }), by: d.claims.author });
  }
  return edits;
}

export function briefing(agent: ChorusAgent, userAuthor?: string, scope?: BriefingScope): Briefing {
  const distrusted = rehydrateTrust(agent); // the lens honors standing edits before reading
  const alive = surviving(agent);
  const rows = beliefRows(alive);
  const identities = identityIndex(agent.snapshot(), userAuthor);

  // The lens: a session that declared topics reads the world through them. No declaration =
  // the global view (small stores, fresh users, the console — the keyholder's seat).
  const allTopics = topics(agent, { limit: Number.MAX_SAFE_INTEGER });
  const declared = scope?.topics ?? [];
  const inScope =
    declared.length === 0
      ? undefined
      : scopeEntities(
          agent,
          alive,
          declared,
          allTopics.map((t) => t.entity),
        );
  const within = (entity: string) => inScope === undefined || inScope.has(entity);

  // Session summaries: identity claims joined with summary/endedAt beliefs at session:<id>.
  const sessions = new Map<string, SessionSummary>();
  for (const id of identities.values()) {
    if (id.kind !== "session" || id.sessionId === undefined) continue;
    sessions.set(id.sessionId, {
      sessionId: id.sessionId,
      model: id.model ?? "unknown",
      ...(id.startedAt === undefined ? {} : { startedAt: id.startedAt }),
      ...(id.purpose === undefined ? {} : { purpose: id.purpose }),
      ...(id.topics === undefined ? {} : { topics: id.topics }),
    });
  }
  for (const { row } of rows) {
    if (!row.entity.startsWith("session:")) continue;
    const sid = row.entity.slice("session:".length);
    const s = sessions.get(sid);
    if (s === undefined) continue;
    if (row.attribute === "summary") sessions.set(sid, { ...s, summary: String(row.value) });
    if (row.attribute === "endedAt" && typeof row.value === "number") {
      sessions.set(sid, { ...s, endedAt: row.value });
    }
  }
  // Continuity is per project, not per wall-clock: sessions sharing a declared topic first.
  const sharesScope = (s: SessionSummary): number =>
    (s.topics ?? []).some((t) => declared.includes(t) || (inScope?.has(t) ?? false)) ? 1 : 0;
  const recentSessions = [...sessions.values()]
    .sort((a, b) => sharesScope(b) - sharesScope(a) || (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, 5);

  // Contested: an attribute where surviving claims disagree ACROSS AUTHORS. Two values from
  // one author are a set (composed-of has many relata) or a superseded self — not a dispute;
  // a contest needs two voices. The SCAN is unbounded on purpose (disagreement does not
  // expire by recency); the BROADCAST is scoped: in-scope contests in full, the rest a count.
  const slots = new Map<
    string,
    {
      entity: string;
      attribute: string;
      values: unknown[];
      seen: Set<string>;
      authors: Set<string>;
    }
  >();
  for (const { row } of rows) {
    if (row.entity.startsWith("session:") || row.entity.startsWith("concept:")) continue;
    const key = `${row.entity}\u0000${row.attribute}`;
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = {
        entity: row.entity,
        attribute: row.attribute,
        values: [],
        seen: new Set(),
        authors: new Set(),
      };
      slots.set(key, slot);
    }
    const rendered = JSON.stringify(row.value);
    if (!slot.seen.has(rendered)) {
      slot.seen.add(rendered);
      if (slot.values.length < 4) slot.values.push(row.value);
    }
    slot.authors.add(row.author);
  }
  const contested: { entity: string; attribute: string; values: unknown[] }[] = [];
  let contestedElsewhere = 0;
  for (const slot of [...slots.values()].sort(
    (a, b) =>
      (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0) ||
      (a.attribute < b.attribute ? -1 : 1),
  )) {
    if (slot.seen.size < 2 || slot.authors.size < 2) continue;
    if (within(slot.entity)) {
      contested.push({ entity: slot.entity, attribute: slot.attribute, values: slot.values });
    } else contestedElsewhere += 1;
  }

  const notInternal = (r: BeliefRow) => !r.entity.startsWith("session:");
  return {
    preferences: latestOfKind(rows, "preference").filter(notInternal).slice(0, 15),
    openTasks: latestOfKind(rows, "task")
      .filter(notInternal)
      .filter((r) => within(r.entity))
      .slice(0, 15),
    recentSessions,
    topics: (inScope === undefined
      ? allTopics
      : allTopics.filter((t) => inScope.has(t.entity))
    ).slice(0, 10),
    contested: contested.slice(0, 10),
    distrusted,
    ...(inScope === undefined
      ? {}
      : { scope: { declared, entities: inScope.size }, contestedElsewhere }),
  };
}
