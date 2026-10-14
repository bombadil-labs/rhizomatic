// Scoped source snapshots (SPEC-17 §7): the MR-10 formulas plus a `scope` that joins the snapshot,
// the basis and the revision, and operands that are exactly S(scope). Independent formulas over L0
// primitives only; never imports the source codec or the anchored evaluator.
import { writeFileSync } from "node:fs";
import { array, bstr, encode, float, map, tstr, type CborValue } from "../src/delta/cbor.js";
import { canonicalBytes } from "../src/delta/delta.js";
import { contentAddress, bytesToHex } from "../src/delta/hash.js";
import { makeNegationClaims } from "../src/delta/set.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import type { Delta } from "../src/delta/types.js";

const seed = "01".repeat(32),
  p = authorForSeed(seed);
const id = (n: number) => "1e20" + n.toString(16).padStart(2, "0").repeat(32);
const binding = id(21),
  authority = id(22);
const selectionOf = (profile: string) =>
  map([
    ["profile", tstr(profile)],
    ["parameters", bstr(encode(map([])))],
  ]);
const scopedSelection = selectionOf("scoped-snapshot/1");
const selection = contentAddress(encode(scopedSelection));

const fact = signClaims(
  {
    author: p,
    timestamp: 10,
    validFrom: 0,
    pointers: [
      { role: "height", target: { kind: "primitive", value: 42 } },
      { role: "on", target: { kind: "entity", entity: { id: "fern" } } },
    ],
  },
  seed,
);
const strike = signClaims(makeNegationClaims(p, 11, fact.id), seed);

const appearanceOf = (d: Delta) =>
  encode(
    map([
      ["id", tstr(d.id)],
      ["claims", bstr(canonicalBytes(d.claims))],
      ["sig", bstr(Uint8Array.from(d.sig!.match(/../g)!, (x) => parseInt(x, 16)))],
    ]),
  );

function snapshot(
  scope: readonly string[],
  rows: readonly Delta[],
  revisionScope: readonly string[] | null = scope,
): CborValue {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const keyed = sorted.map((d) => ({
    d,
    bytes: appearanceOf(d),
    key: contentAddress(appearanceOf(d)),
  }));
  const ids = sorted.map((d) => tstr(d.id));
  const component = map([
    ["peer", tstr(p)],
    ["revision", tstr(id(23))],
    ["capturedAt", float(1000)],
    ["rawIds", array(ids)],
    ["operandIds", array(ids)],
  ]);
  const membership = contentAddress(encode(array(ids))),
    appearanceDigest = contentAddress(
      encode(array(keyed.map((k) => tstr(k.key)).sort((a, b) => (a.v < b.v ? -1 : 1)))),
    );
  const revision = contentAddress(
    encode(
      map([
        ["binding", tstr(binding)],
        ["authority", tstr(authority)],
        ["selection", tstr(selection)],
        [
          "components",
          array([
            map(component.t === "map" ? component.v.filter(([k]) => k !== "capturedAt") : []),
          ]),
        ],
        ["membership", tstr(membership)],
        ["appearanceDigest", tstr(appearanceDigest)],
        ["exclusions", array([])],
        ...(revisionScope === null ? [] : [["scope", array(revisionScope.map(tstr))] as const]),
      ]),
    ),
  );
  return map([
    ["format", tstr("rhizomatic.source-snapshot/1")],
    ["binding", tstr(binding)],
    ["authority", tstr(authority)],
    ["selection", tstr(selection)],
    ["revision", tstr(revision)],
    ["servingAt", float(1000)],
    ["scope", array(scope.map(tstr))],
    ["components", array([component])],
    [
      "appearances",
      array(
        [...keyed]
          .sort((a, b) => (a.key < b.key ? -1 : 1))
          .map((k) =>
            map([
              ["key", tstr(k.key)],
              ["value", bstr(k.bytes)],
            ]),
          ),
      ),
    ],
    [
      "operands",
      array(
        keyed.map((k) =>
          map([
            ["id", tstr(k.d.id)],
            ["appearance", tstr(k.key)],
            ["peers", array([tstr(p)])],
          ]),
        ),
      ),
    ],
    ["exclusions", array([])],
    ["membership", tstr(membership)],
    ["appearanceDigest", tstr(appearanceDigest)],
  ]);
}

const basisOf = (value: CborValue) => {
  if (value.t !== "map") throw Error();
  return map([
    ...value.v.filter(([k]) => k !== "format" && k !== "appearances"),
    ["format", tstr("rhizomatic.source-basis/1")],
    ["snapshot", tstr(contentAddress(encode(value)))],
  ]);
};

const positives = [
  { id: "scoped_one", scope: ["fern"], rows: [fact] },
  { id: "scoped_with_negation_chain", scope: ["fern"], rows: [fact, strike] },
  { id: "scoped_two_entities", scope: ["fern", "moss"], rows: [fact] },
  // UTF-8 byte order, which is code point order: U+E000 before U+10000.
  { id: "scoped_supplementary_order", scope: ["fern", "\uE000", "\u{10000}"], rows: [fact] },
].map((c) => {
  const value = snapshot(c.scope, c.rows);
  if (value.t !== "map") throw Error();
  const fs = new Map(value.v);
  return {
    id: c.id,
    snapshotHex: bytesToHex(encode(value)),
    basisHex: bytesToHex(encode(basisOf(value))),
    expected: {
      revision: fs.get("revision")!.v,
      scope: c.scope,
      operandIds: c.rows.map((d) => d.id).sort(),
    },
  };
});

const negatives = [
  // An operand outside S(scope): it points at fern, and the scope is moss.
  { id: "operand_outside_scope", value: snapshot(["moss"], [fact]) },
  // A negator whose target is not an operand is not in S(scope) either.
  { id: "stray_negator", value: snapshot(["fern"], [strike]) },
  { id: "unsorted_scope", value: snapshot(["moss", "fern"], [fact]) },
  // UTF-16 code unit order puts U+10000 (a surrogate pair) before U+E000; the wire order is UTF-8.
  { id: "utf16_ordered_scope", value: snapshot(["fern", "\u{10000}", "\uE000"], [fact]) },
  { id: "empty_scope", value: snapshot([], []) },
  // The revision must commit to the scope.
  { id: "revision_without_scope", value: snapshot(["fern"], [fact], null) },
].map((c) => ({ id: c.id, snapshotHex: bytesToHex(encode(c.value)), expected: "invalid-source" }));

const bindings = [
  { id: "scoped", profile: "scoped-snapshot/1", scoped: true },
  { id: "full", profile: "host-authorized-snapshot/1", scoped: false },
].map((b) => ({
  id: b.id,
  specHex: bytesToHex(
    encode(
      map([
        ["sourceId", tstr("loam-primary")],
        ["capturer", tstr(p)],
        ["authorityRoot", tstr(id(24))],
        ["selection", selectionOf(b.profile)],
      ]),
    ),
  ),
  expected: { scoped: b.scoped },
}));

writeFileSync(
  new URL("../../../vectors/materialization/scoped-source.json", import.meta.url),
  JSON.stringify(
    {
      format: "rhizomatic-scoped-source-vectors/1",
      oracle:
        "SPEC-17 §7: MR-10 commitments plus a scope that joins the revision; operands exactly S(scope). Independent formulas over L0 C/hash/sign only.",
      bindings,
      positives,
      negatives,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `wrote ${bindings.length} binding, ${positives.length} positive and ${negatives.length} negative scoped-source vectors`,
);
