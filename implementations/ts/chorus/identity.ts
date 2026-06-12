// Session identity (the "who said this, exactly" layer). Every Claude session is a DISTINCT
// author: a keypair derived from one master seed + the session id, so the holder of the master
// seed can re-derive any session's key, and nobody else can forge one. The human is one
// PERSISTENT author across all sessions. Identity claims bind a session author to its model
// name, session id, and start time — signed by the session key itself, so the binding is
// exactly as trustworthy as the claims it scopes.

import { contentAddress, type Pointer } from "../src/index.js";
import { CHORUS_PREFIX } from "./vocab.js";

export const ROLE_ID_SESSION = `${CHORUS_PREFIX}.identity.session`;
export const ROLE_ID_MODEL = `${CHORUS_PREFIX}.identity.model`;
export const ROLE_ID_STARTED = `${CHORUS_PREFIX}.identity.startedAt`;
export const ROLE_ID_PURPOSE = `${CHORUS_PREFIX}.identity.purpose`;
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
}

// The identity claim: one delta, authored and signed by the session key, filed at the session
// entity. Binding author -> (model, session, start) is itself auditable data.
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
  return pointers;
}

export interface AuthorIdentity {
  readonly author: string;
  readonly kind: "session" | "user" | "unknown";
  readonly model?: string;
  readonly sessionId?: string;
  readonly startedAt?: number;
  readonly purpose?: string;
}

// Resolve every author's identity from the identity claims in a set of deltas. An author with
// no identity claim is "unknown" — visible as such in receipts, never silently trusted.
export function identityIndex(
  deltas: Iterable<{
    readonly id: string;
    readonly claims: {
      readonly author: string;
      readonly pointers: readonly Pointer[];
    };
  }>,
  userAuthor?: string,
): Map<string, AuthorIdentity> {
  const index = new Map<string, AuthorIdentity>();
  if (userAuthor !== undefined) index.set(userAuthor, { author: userAuthor, kind: "user" });
  for (const d of deltas) {
    let sessionId: string | undefined;
    let model: string | undefined;
    let startedAt: number | undefined;
    let purpose: string | undefined;
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
      }
    }
    if (sessionId === undefined || model === undefined) continue;
    // Re-introductions refine: the claim with the latest startedAt wins (tie: higher delta id).
    const prior = index.get(d.claims.author);
    if (prior?.kind === "session" && (prior.startedAt ?? 0) > (startedAt ?? 0)) {
      continue;
    }
    index.set(d.claims.author, {
      author: d.claims.author,
      kind: "session",
      model,
      sessionId,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(purpose === undefined ? {} : { purpose }),
    });
  }
  return index;
}
