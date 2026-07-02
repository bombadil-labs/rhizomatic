// Session identity (the "who said this, exactly" layer). Every Claude session is a DISTINCT
// author: a keypair derived from one master seed + the session id, so the holder of the master
// seed can re-derive any session's key, and nobody else can forge one. The human is one
// PERSISTENT author across all sessions. Identity claims bind a session author to its model
// name, session id, and start time — signed by the session key itself, so the binding is
// exactly as trustworthy as the claims it scopes.

import { contentAddress, type Pointer } from "@rhizomes/core";
import { CHORUS_PREFIX } from "./vocab.js";

export const ROLE_ID_SESSION = `${CHORUS_PREFIX}.identity.session`;
export const ROLE_ID_MODEL = `${CHORUS_PREFIX}.identity.model`;
export const ROLE_ID_STARTED = `${CHORUS_PREFIX}.identity.startedAt`;
export const ROLE_ID_PURPOSE = `${CHORUS_PREFIX}.identity.purpose`;
export const ROLE_ID_TOPIC = `${CHORUS_PREFIX}.identity.topic`;
export const ROLE_ID_SURFACE = `${CHORUS_PREFIX}.identity.surface`;
export const ROLE_ID_MODE = `${CHORUS_PREFIX}.identity.mode`;
export const CTX_IDENTITY = `${CHORUS_PREFIX}.identity`;

export const sessionEntity = (sessionId: string): string => `session:${sessionId}`;

const utf8 = new TextEncoder();

// Derive a child seed from the master: blake3(master || "/" || label), hex. Deterministic —
// the master holder can re-derive and audit any session key; the derivation never leaves the
// process (only public keys enter the substrate).
export function deriveSeed(masterSeedHex: string, label: string): string {
  return contentAddress(utf8.encode(`${masterSeedHex}/${label}`)).slice(4); // strip multihash prefix
}

export const sessionSeed = (masterSeedHex: string, sessionId: string): string =>
  deriveSeed(masterSeedHex, `session/${sessionId}`);

export const userSeed = (masterSeedHex: string): string => deriveSeed(masterSeedHex, "user");

export interface SessionIdentity {
  readonly sessionId: string;
  readonly model: string;
  readonly startedAt: number;
  readonly purpose?: string;
  // Structured intent, all of it claims on the introduction delta and interval-bound like
  // the model name. Topics are what the session is ABOUT: real entity ids travel as
  // contextless entity REFERENCES (reference without filing — SPEC-1 §2.3 consent; no
  // backpointer pollution at the topic), while a trailing-":" value like "synchronicity:"
  // is a prefix PATTERN and travels as a string. You can only reference a thing; a pattern
  // is a spelling — the use–mention distinction, encoded in the delta.
  readonly topics?: readonly string[];
  readonly surface?: string; // where the session lives: claude-code | claude-desktop | …
  readonly mode?: string; // interaction type: work | conversation | research | retrospective…
}

// The identity claim: one delta, authored and signed by the session key, filed at the session
// entity. Binding author -> (model, session, start, intent) is itself auditable data.
export function identityPointers(info: SessionIdentity): Pointer[] {
  const pointers: Pointer[] = [
    {
      role: ROLE_ID_SESSION,
      target: {
        kind: "entity",
        entity: { id: sessionEntity(info.sessionId), context: CTX_IDENTITY },
      },
    },
    { role: ROLE_ID_MODEL, target: { kind: "primitive", value: info.model } },
    { role: ROLE_ID_STARTED, target: { kind: "primitive", value: info.startedAt } },
  ];
  if (info.purpose !== undefined) {
    pointers.push({ role: ROLE_ID_PURPOSE, target: { kind: "primitive", value: info.purpose } });
  }
  for (const topic of info.topics ?? []) {
    pointers.push({
      role: ROLE_ID_TOPIC,
      target: topic.endsWith(":")
        ? { kind: "primitive", value: topic }
        : { kind: "entity", entity: { id: topic } },
    });
  }
  if (info.surface !== undefined) {
    pointers.push({ role: ROLE_ID_SURFACE, target: { kind: "primitive", value: info.surface } });
  }
  if (info.mode !== undefined) {
    pointers.push({ role: ROLE_ID_MODE, target: { kind: "primitive", value: info.mode } });
  }
  return pointers;
}

export interface AuthorIdentity {
  readonly author: string;
  readonly kind: "session" | "user" | "unknown";
  readonly model?: string;
  readonly sessionId?: string;
  readonly startedAt?: number;
  readonly purpose?: string;
  readonly topics?: readonly string[]; // entity ids + trailing-":" prefix patterns
  readonly surface?: string;
  readonly mode?: string;
}

type DeltaLike = {
  readonly id: string;
  readonly claims: {
    readonly author: string;
    readonly pointers: readonly Pointer[];
  };
};

// Every introduction, per author, sorted by startedAt ascending. An author may introduce
// itself MORE THAN ONCE: the serving model can change mid-session (a safety-refusal
// failover, an upgrade), and the honest reading of a re-introduction is an INTERVAL —
// each introduction binds from its startedAt until the next one. The model name was
// always testimony about a span of time, never a property of the keypair.
export function identityIntroductions(
  deltas: Iterable<DeltaLike>,
  userAuthor?: string,
): Map<string, AuthorIdentity[]> {
  const intros = new Map<string, AuthorIdentity[]>();
  if (userAuthor !== undefined) intros.set(userAuthor, [{ author: userAuthor, kind: "user" }]);
  for (const d of deltas) {
    let sessionId: string | undefined;
    let model: string | undefined;
    let startedAt: number | undefined;
    let purpose: string | undefined;
    let surface: string | undefined;
    let mode: string | undefined;
    const topics: string[] = [];
    for (const p of d.claims.pointers) {
      if (p.role === ROLE_ID_SESSION && p.target.kind === "entity") {
        const id = p.target.entity.id;
        sessionId = id.startsWith("session:") ? id.slice("session:".length) : id;
      } else if (p.role === ROLE_ID_MODEL && p.target.kind === "primitive") {
        model = String(p.target.value);
      } else if (p.role === ROLE_ID_STARTED && p.target.kind === "primitive") {
        if (typeof p.target.value === "number") startedAt = p.target.value;
      } else if (p.role === ROLE_ID_PURPOSE && p.target.kind === "primitive") {
        purpose = String(p.target.value);
      } else if (p.role === ROLE_ID_TOPIC) {
        if (p.target.kind === "entity") topics.push(p.target.entity.id);
        else if (p.target.kind === "primitive") topics.push(String(p.target.value));
      } else if (p.role === ROLE_ID_SURFACE && p.target.kind === "primitive") {
        surface = String(p.target.value);
      } else if (p.role === ROLE_ID_MODE && p.target.kind === "primitive") {
        mode = String(p.target.value);
      }
    }
    if (sessionId === undefined || model === undefined) continue;
    const list = intros.get(d.claims.author) ?? [];
    list.push({
      author: d.claims.author,
      kind: "session",
      model,
      sessionId,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(purpose === undefined ? {} : { purpose }),
      ...(topics.length === 0 ? {} : { topics }),
      ...(surface === undefined ? {} : { surface }),
      ...(mode === undefined ? {} : { mode }),
    });
    intros.set(d.claims.author, list);
  }
  for (const list of intros.values()) {
    list.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }
  return intros;
}

// The introduction in effect at an instant: the latest startedAt at or before t. A claim
// earlier than the author's first introduction reads as the first — a session's opening
// binding covers its own lazy pre-introduction writes.
export function identityAt(
  intros: Map<string, AuthorIdentity[]>,
  author: string,
  t: number,
): AuthorIdentity | undefined {
  const list = intros.get(author);
  if (list === undefined || list.length === 0) return undefined;
  let current = list[0]!;
  for (const intro of list) {
    if ((intro.startedAt ?? 0) <= t) current = intro;
    else break;
  }
  return current;
}

// Resolve every author's CURRENT identity (the latest introduction). An author with no
// identity claim is "unknown" — visible as such in receipts, never silently trusted.
// For per-claim attribution use identityIntroductions + identityAt: a claim's model is
// the introduction in effect at ITS timestamp, never the latest label.
export function identityIndex(
  deltas: Iterable<DeltaLike>,
  userAuthor?: string,
): Map<string, AuthorIdentity> {
  const index = new Map<string, AuthorIdentity>();
  for (const [author, list] of identityIntroductions(deltas, userAuthor)) {
    const last = list[list.length - 1];
    if (last !== undefined) index.set(author, last);
  }
  return index;
}
