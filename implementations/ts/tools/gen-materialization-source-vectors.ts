// Independent SPEC-16 MR-10 formulas over existing L0 primitives. Never imports the source codec.
import { writeFileSync } from "node:fs";
import { array, bstr, encode, float, map, tstr, type CborValue } from "../src/delta/cbor.js";
import { canonicalBytes } from "../src/delta/delta.js";
import { contentAddress, bytesToHex } from "../src/delta/hash.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
const seed = "01".repeat(32),
  p = authorForSeed(seed),
  q = authorForSeed("02".repeat(32));
const id = (n: number) => "1e20" + n.toString(16).padStart(2, "0").repeat(32);
const binding = id(21),
  authority = id(22),
  selection = contentAddress(
    encode(
      map([
        ["profile", tstr("host-authorized-snapshot/1")],
        ["parameters", bstr(encode(map([])))],
      ]),
    ),
  );
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
const claims = canonicalBytes(fact.claims),
  sig = Uint8Array.from(fact.sig!.match(/../g)!, (x) => parseInt(x, 16));
const appearance = encode(
    map([
      ["id", tstr(fact.id)],
      ["claims", bstr(claims)],
      ["sig", bstr(sig)],
    ]),
  ),
  aKey = contentAddress(appearance);
const excluded = id(25);
function snapshot(time: number, rows: boolean, provenance = false, auth = authority): CborValue {
  const peers = provenance ? [p, q].sort() : [p];
  const components = peers.map((peer) =>
    map([
      ["peer", tstr(peer)],
      ["revision", tstr(id(peer === p ? 23 : 24))],
      ["capturedAt", float(time + (peer === q ? 1 : 0))],
      [
        "rawIds",
        array((rows ? (peer === q ? [fact.id, excluded] : [fact.id]) : []).sort().map(tstr)),
      ],
      ["operandIds", array(rows && peer === p ? [tstr(fact.id)] : [])],
    ]),
  );
  const appearances = rows
    ? [
        map([
          ["key", tstr(aKey)],
          ["value", bstr(appearance)],
        ]),
      ]
    : [];
  const operands = rows
    ? [
        map([
          ["id", tstr(fact.id)],
          ["appearance", tstr(aKey)],
          ["peers", array([tstr(p)])],
        ]),
      ]
    : [];
  const exclusions =
    rows && provenance
      ? [
          map([
            ["id", tstr(excluded)],
            ["peers", array([tstr(q)])],
            ["reason", tstr("not-permitted")],
          ]),
        ]
      : [];
  const membership = contentAddress(encode(array(rows ? [tstr(fact.id)] : []))),
    appearanceDigest = contentAddress(encode(array(rows ? [tstr(aKey)] : [])));
  const bases = components.map((c) =>
    c.t === "map" ? map(c.v.filter(([k]) => k !== "capturedAt")) : c,
  );
  const revision = contentAddress(
    encode(
      map([
        ["binding", tstr(binding)],
        ["authority", tstr(auth)],
        ["selection", tstr(selection)],
        ["components", array(bases)],
        ["membership", tstr(membership)],
        ["appearanceDigest", tstr(appearanceDigest)],
        ["exclusions", array(exclusions)],
      ]),
    ),
  );
  return map([
    ["format", tstr("rhizomatic.source-snapshot/1")],
    ["binding", tstr(binding)],
    ["authority", tstr(auth)],
    ["selection", tstr(selection)],
    ["revision", tstr(revision)],
    ["servingAt", float(time)],
    ["components", array(components)],
    ["appearances", array(appearances)],
    ["operands", array(operands)],
    ["exclusions", array(exclusions)],
    ["membership", tstr(membership)],
    ["appearanceDigest", tstr(appearanceDigest)],
  ]);
}
const positives = [
  ["empty", snapshot(1000, false)],
  ["one", snapshot(1000, true)],
  ["fresh_observation", snapshot(1100, true)],
  ["authority_change", snapshot(1000, true, false, id(26))],
  ["provenance", snapshot(1000, true, true)],
] as const;
const fixtures = positives.map(([name, value]) => {
  if (value.t !== "map") throw Error();
  const fs = new Map(value.v),
    payload = encode(value);
  const basis = map([
    ...value.v.filter(([k]) => k !== "format" && k !== "appearances"),
    ["format", tstr("rhizomatic.source-basis/1")],
    ["snapshot", tstr(contentAddress(payload))],
  ]);
  return {
    id: name,
    snapshotHex: bytesToHex(payload),
    basisHex: bytesToHex(encode(basis)),
    expected: {
      revision: fs.get("revision")!.v,
      membership: fs.get("membership")!.v,
      appearanceDigest: fs.get("appearanceDigest")!.v,
      operandIds: name === "empty" ? [] : [fact.id],
      components: name === "provenance" ? 2 : 1,
      excludedId: name === "provenance" ? excluded : undefined,
    },
  };
});
const base = positives[1][1];
if (base.t !== "map") throw Error();
const mutate = (key: string, v: CborValue) => map(base.v.map(([k, x]) => [k, k === key ? v : x]));
const negatives = [
  ...["revision", "membership", "appearanceDigest"].map((k) => ({
    id: "wrong_" + k,
    snapshotHex: bytesToHex(encode(mutate(k, tstr(id(29))))),
    expected: "invalid-source",
  })),
  {
    id: "format",
    snapshotHex: bytesToHex(encode(mutate("format", tstr("unknown/1")))),
    expected: "invalid-source",
  },
  {
    id: "known_appearance_bound",
    snapshotHex: fixtures[1]!.snapshotHex,
    limits: { appearances: 1, components: 1, inventoryIds: 1, artifactBytes: 1, pointers: 256 },
    expected: "resource-limit",
  },
];
writeFileSync(
  new URL("../../../vectors/materialization/source-snapshot.json", import.meta.url),
  JSON.stringify(
    {
      format: "rhizomatic-source-snapshot-vectors/1",
      oracle:
        "Manually selected operand42 and provenance memberships; independent MR10 commitment formulas using existing L0 C/hash/sign only. No new source codec/gather or command implementation imports.",
      positives: fixtures,
      negatives,
    },
    null,
    2,
  ) + "\n",
);
