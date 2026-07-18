// The HyperView: the output sort of group/expand/prune — SPEC-3 §4, encoded per ERRATA-2 E7/E11.
// Provenance-complete: every entry carries the full delta; expansion is view structure keyed by
// pointer index, never a mutation of the delta.

import { type CborValue, array, bool, bstr, encode, float, map, tstr } from "./cbor.js";
import { bytesToHex } from "./hash.js";
import type { Schema } from "./resolution.js";
import type { Claims, Delta, Target } from "./types.js";

export interface HVEntry {
  readonly delta: Delta;
  // Annotate tag threaded through group from a mask(annotate) operand (E7).
  readonly negated: boolean;
  // expand replacements: pointer index (authored order) -> nested HView (E11).
  readonly expanded?: ReadonlyMap<number, HView>;
  // The reading (child's resolution Schema) each expansion resolves through, same keying
  // (issue #23). In-memory only: readings are program state, so they never enter the HView's
  // canonical form — hview identity is data identity.
  readonly readings?: ReadonlyMap<number, Schema>;
}

export interface HView {
  readonly id: string;
  readonly props: ReadonlyMap<string, readonly HVEntry[]>;
}

function targetToCborWithExpansion(t: Target, expansion: HView | undefined): CborValue {
  if (expansion !== undefined) return hviewToCbor(expansion);
  switch (t.kind) {
    case "primitive": {
      const v = t.value;
      if (typeof v === "string") return tstr(v);
      if (typeof v === "boolean") return bool(v);
      return float(v);
    }
    case "entity": {
      const entries: Array<[string, CborValue]> = [["id", tstr(t.entity.id)]];
      if (t.entity.context !== undefined) entries.push(["context", tstr(t.entity.context)]);
      return map(entries);
    }
    case "delta": {
      const entries: Array<[string, CborValue]> = [["delta", tstr(t.deltaRef.delta)]];
      if (t.deltaRef.context !== undefined) entries.push(["context", tstr(t.deltaRef.context)]);
      return map(entries);
    }
    case "bytes":
      return map([
        ["mime", tstr(t.mime)],
        ["value", bstr(t.value)],
      ]);
  }
}

// Claims rendered for an HVEntry: identical to the L1 canonical claims encoding, except that
// expanded pointer targets are replaced by nested HView maps (E11). Never used for hashing.
function claimsToCborWithExpansions(
  claims: Claims,
  expanded: ReadonlyMap<number, HView> | undefined,
): CborValue {
  return map([
    ["author", tstr(claims.author)],
    [
      "pointers",
      array(
        claims.pointers.map((p, i) =>
          map([
            ["role", tstr(p.role)],
            ["target", targetToCborWithExpansion(p.target, expanded?.get(i))],
          ]),
        ),
      ),
    ],
    ["timestamp", float(claims.timestamp)],
  ]);
}

export function hvEntryToCbor(e: HVEntry): CborValue {
  const entries: Array<[string, CborValue]> = [
    ["id", tstr(e.delta.id)],
    ["claims", claimsToCborWithExpansions(e.delta.claims, e.expanded)],
  ];
  if (e.delta.sig !== undefined) entries.push(["sig", tstr(e.delta.sig)]);
  if (e.negated) entries.push(["negated", bool(true)]);
  return map(entries);
}

export function hviewToCbor(h: HView): CborValue {
  const props: Array<[string, CborValue]> = [...h.props.entries()].map(([prop, entries]) => [
    prop,
    array(entries.map(hvEntryToCbor)),
  ]);
  return map([
    ["id", tstr(h.id)],
    ["props", map(props)],
  ]);
}

// HyperViews are content-addressable (SPEC-3 §4): same (schema, DSet) => byte-identical form.
export function hviewCanonicalHex(h: HView): string {
  return bytesToHex(encode(hviewToCbor(h)));
}
