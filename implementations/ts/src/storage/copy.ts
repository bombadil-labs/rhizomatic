// Copies that cut every reference between a caller and what a store or a scope source holds
// (SPEC-18 proposal §4.1: a store owns what it holds).

import type { Claims, Delta } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import type { VerifiedDelta } from "./store.js";

// The store's own copy of a delta's claims: the canonical fields and nothing else. A caller's
// object never enters the store and a stored object never leaves it, so no caller can change
// what a peer reads. A bytes payload cannot be frozen, which is why reads copy too. The payload
// is copied with the Uint8Array constructor: `slice` on a Node Buffer returns a view of the
// same memory.
export function copyClaims(claims: Claims): Claims {
  return {
    timestamp: claims.timestamp,
    validFrom: claims.validFrom,
    ...(claims.validUntil === undefined ? {} : { validUntil: claims.validUntil }),
    author: claims.author,
    pointers: claims.pointers.map(({ role, target }) => {
      switch (target.kind) {
        case "primitive":
          return { role, target: { kind: "primitive", value: target.value } };
        case "entity":
          return {
            role,
            target: {
              kind: "entity",
              entity:
                target.entity.context === undefined
                  ? { id: target.entity.id }
                  : { id: target.entity.id, context: target.entity.context },
            },
          };
        case "delta":
          return {
            role,
            target: {
              kind: "delta",
              deltaRef:
                target.deltaRef.context === undefined
                  ? { delta: target.deltaRef.delta }
                  : { delta: target.deltaRef.delta, context: target.deltaRef.context },
            },
          };
        case "bytes":
          return {
            role,
            target: { kind: "bytes", mime: target.mime, value: new Uint8Array(target.value) },
          };
      }
    }),
  };
}

export function copyArrival(arrival: ArrivalRecord): ArrivalRecord {
  const { id, at, sequence, transfer, sender } = arrival;
  return { id, at, sequence, transfer, sender };
}

export function copyMember({ delta, arrival }: VerifiedDelta): VerifiedDelta {
  const claims = copyClaims(delta.claims);
  const copy: Delta =
    delta.sig === undefined ? { id: delta.id, claims } : { id: delta.id, claims, sig: delta.sig };
  return { delta: copy, arrival: copyArrival(arrival) };
}
