// Expected bytes from explicit wire grammar, independently of all new M1 code.
import { writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { type CborValue, encode, map, array, tstr, bstr, float, bool } from "../src/delta/cbor.js";
import { bytesToHex, contentAddress } from "../src/delta/hash.js";
import { parseClaims, claimsToJson } from "../src/delta/json-profile.js";
import { canonicalBytes, computeId } from "../src/delta/delta.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import { jsonToCbor } from "../src/syntax/term-io.js";
import type { Delta } from "../src/delta/types.js";
const seed = "00".repeat(32),
  pick = { pick: { order: "lexById" } },
  reading = { props: {}, default: pick };
const plant = { ...reading, name: "Plant" },
  other = { ...reading, name: "OtherPlant", alg: 1 };
const alternative = { ...plant, default: { pick: { order: { byTimestamp: "desc" } } } };
const holeReading = {
  ...plant,
  default: {
    pick: {
      order: {
        byPred: {
          pred: { match: { field: "author", cmp: "eq", const: { hole: "owner" } } },
          then: "lexById",
        },
      },
    },
  },
};
const boundReading = {
  ...plant,
  default: {
    pick: {
      order: {
        byPred: {
          pred: { match: { field: "author", cmp: "eq", const: authorForSeed(seed) } },
          then: "lexById",
        },
      },
    },
  },
};
function delta(timestamp: number, pointers: unknown[]): Delta {
  return signClaims(
    parseClaims({
      timestamp,
      validFrom: 0,
      validUntil: 2000,
      author: authorForSeed(seed),
      pointers,
    }),
    seed,
  );
}
const a = delta(10, [
  { role: "child", target: { id: "authored:first", context: "branch" } },
  { role: "child", target: { id: "authored:second" } },
  { role: "bytes", target: { mime: "text/plain", value: "AAEC" } },
]);
const b = delta(11, [{ role: "value", target: 42 }]);
const all = delta(12, [
  { role: "repeat", target: true },
  { role: "repeat", target: "é" },
  { role: "num", target: 1.5 },
  { role: "zero", target: -0 },
  { role: "entity", target: { id: "E", context: "ctx" } },
  { role: "delta", target: { delta: a.id, context: "ctx" } },
  { role: "bytes", target: { mime: "x/empty", value: "" } },
  { role: "bytes", target: { mime: "x/nonempty", value: "AP8" } },
]);
type Reading = Record<string, unknown>;
type Node = { id: string; props: Record<string, Entry[]> };
type Entry = {
  delta: Delta;
  negated: boolean;
  expanded?: [number, Node][];
  readings?: [number, Reading][];
};
const empty = (id = "fix:selected"): Node => ({ id, props: {} });
const entry = (d = a, options: Partial<Entry> = {}): Entry => ({
  delta: d,
  negated: false,
  ...options,
});
const view = (es: Entry[], props: Record<string, Entry[]> = {}): Node => ({
  id: "item:moss",
  props: { child: es, ...props },
});
const original = view([entry(a, { expanded: [[1, empty()]], readings: [[1, plant]] })]);
const meta = view([
  entry(a, {
    expanded: [
      [0, empty("one")],
      [1, empty("two")],
    ],
    readings: [
      [0, plant],
      [1, other],
    ],
  }),
]);
const legacy = view([entry(a, { expanded: [[1, empty()]] })]);
function native(n: Node): unknown {
  return {
    id: n.id,
    props: Object.fromEntries(
      Object.entries(n.props).map(([k, es]) => [
        k,
        es.map((e) => ({
          delta: {
            id: e.delta.id,
            claims: claimsToJson(e.delta.claims),
            ...(e.delta.sig === undefined ? {} : { sig: e.delta.sig }),
          },
          negated: e.negated,
          expanded: (e.expanded ?? []).map(([i, c]) => [i, native(c)]),
          readings: e.readings ?? [],
        })),
      ]),
    ),
  };
}
function readingBytes(r: Reading): Uint8Array {
  const fs: [string, CborValue][] = [
    ["body", bstr(encode(jsonToCbor({ props: r.props, default: r.default })))],
  ];
  if (r.name !== undefined) fs.push(["name", tstr(r.name as string)]);
  if (r.alg !== undefined) fs.push(["alg", float(r.alg as number)]);
  return encode(map(fs));
}
function appearance(d: Delta): Uint8Array {
  const fs: [string, CborValue][] = [
    ["id", tstr(d.id)],
    ["claims", bstr(canonicalBytes(d.claims))],
  ];
  if (d.sig !== undefined) fs.push(["sig", bstr(Buffer.from(d.sig, "hex"))]);
  return encode(map(fs));
}
function wire(n: Node): CborValue {
  const ds = new Map<string, Uint8Array>(),
    rs = new Map<string, Uint8Array>();
  const add = (t: Map<string, Uint8Array>, v: Uint8Array): string => {
    const k = contentAddress(v);
    t.set(k, v);
    return k;
  };
  const node = (n: Node): CborValue =>
    map([
      ["id", tstr(n.id)],
      [
        "props",
        map(
          Object.entries(n.props).map(([k, es]) => [
            k,
            array(
              es.map((e) =>
                map([
                  ["appearance", tstr(add(ds, appearance(e.delta)))],
                  ["negated", bool(e.negated)],
                  [
                    "expanded",
                    array(
                      (e.expanded ?? []).map(([i, c]) =>
                        map([
                          ["index", float(i)],
                          ["child", node(c)],
                        ]),
                      ),
                    ),
                  ],
                  [
                    "readings",
                    array(
                      (e.readings ?? []).map(([i, r]) =>
                        map([
                          ["index", float(i)],
                          ["reading", tstr(add(rs, readingBytes(r)))],
                        ]),
                      ),
                    ),
                  ],
                ]),
              ),
            ),
          ]),
        ),
      ],
    ]);
  const root = node(n);
  const records = (t: Map<string, Uint8Array>): CborValue =>
    array(
      [...t]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) =>
          map([
            ["key", tstr(k)],
            ["value", bstr(v)],
          ]),
        ),
    );
  return map([
    ["format", tstr("rhizomatic.hview-envelope/1")],
    ["root", root],
    ["appearances", records(ds)],
    ["readings", records(rs)],
  ]);
}
// Independent construction of the unchanged pre-existing render, including its omissions.
function oldView(n: Node): CborValue {
  return map([
    ["id", tstr(n.id)],
    [
      "props",
      map(
        Object.entries(n.props).map(([k, es]) => [
          k,
          array(
            es.map((e) => {
              const pointers = e.delta.claims.pointers.map((p, i) => {
                const c = e.expanded?.find(([s]) => s === i)?.[1],
                  r = e.readings?.find(([s]) => s === i)?.[1];
                let target: CborValue;
                if (c) {
                  target = oldView(c);
                  if (r && target.t === "map")
                    target = map([
                      ...target.v,
                      [
                        "reading",
                        tstr(
                          contentAddress(
                            encode(jsonToCbor({ props: r.props, default: r.default })),
                          ),
                        ),
                      ],
                    ]);
                } else {
                  const t = p.target;
                  switch (t.kind) {
                    case "primitive":
                      target =
                        typeof t.value === "string"
                          ? tstr(t.value)
                          : typeof t.value === "boolean"
                            ? bool(t.value)
                            : float(t.value);
                      break;
                    case "entity":
                      target = jsonToCbor(t.entity);
                      break;
                    case "delta":
                      target = jsonToCbor(t.deltaRef);
                      break;
                    case "bytes":
                      target = map([
                        ["mime", tstr(t.mime)],
                        ["value", bstr(t.value)],
                      ]);
                      break;
                  }
                }
                return map([
                  ["role", tstr(p.role)],
                  ["target", target],
                ]);
              });
              const fs: [string, CborValue][] = [
                ["id", tstr(e.delta.id)],
                [
                  "claims",
                  map([
                    ["author", tstr(e.delta.claims.author)],
                    ["timestamp", float(e.delta.claims.timestamp)],
                    ["pointers", array(pointers)],
                  ]),
                ],
              ];
              if (e.delta.sig !== undefined) fs.push(["sig", tstr(e.delta.sig)]);
              if (e.negated) fs.push(["negated", bool(true)]);
              return map(fs);
            }),
          ),
        ]),
      ),
    ],
  ]);
}
const positives: unknown[] = [],
  negative: unknown[] = [];
function positive(id: string, variant: string, n: Node, extra: Record<string, unknown> = {}): void {
  const bytes = encode(wire(n));
  positives.push({
    id,
    variant,
    native: native(n),
    envelopeHex: bytesToHex(bytes),
    transportId: contentAddress(bytes),
    existingHViewHex: bytesToHex(encode(oldView(n))),
    ...extra,
  });
}
function bad(
  id: string,
  variant: string,
  value: CborValue,
  error = "invalid-evidence",
  limits?: unknown,
  source?: Node,
): void {
  negative.push({
    id,
    variant,
    envelopeHex: bytesToHex(encode(value)),
    error,
    ...(limits ? { limits } : {}),
    ...(source ? { native: native(source) } : {}),
  });
}
const field = (v: CborValue, k: string): CborValue => {
  if (v.t !== "map") throw Error("map");
  return v.v.find(([key]) => key === k)![1];
};
const edit = (v: CborValue, k: string, next: CborValue): CborValue => {
  if (v.t !== "map") throw Error("map");
  return map(v.v.map(([key, value]) => [key, key === k ? next : value]));
};
function rootEntry(w: CborValue, f: (e: CborValue) => CborValue): CborValue {
  const root = field(w, "root"),
    props = field(root, "props"),
    es = field(props, "child");
  if (es.t !== "array") throw Error("entries");
  return edit(w, "root", edit(root, "props", edit(props, "child", array(es.v.map(f)))));
}
positive("env_original_appearance", "original", original);
positive(
  "env_signed_unsigned_same_id",
  "unsigned",
  view([entry(a), entry({ id: a.id, claims: a.claims })]),
);
const arbitraryClaims = { ...a.claims, author: "native:unsigned-author" };
positive(
  "env_signed_unsigned_same_id",
  "unsigned-native-author",
  view([entry({ id: computeId(arbitraryClaims), claims: arbitraryClaims })]),
);
positive("env_signature_choice", "canonical", view([entry(a)], { other: [entry(a)] }));
positive(
  "env_entry_order_repeat",
  "repeats",
  view([entry(b), entry(a), entry(a)], { other: [entry(a)], empty: [] }),
);
positive("env_negation_annotation", "annotations", view([entry(b, { negated: true }), entry(b)]));
positive("env_reading_metadata", "metadata", meta);
positive(
  "env_same_name_different_pin",
  "pins",
  view([
    entry(a, {
      expanded: [
        [0, empty()],
        [1, empty()],
      ],
      readings: [
        [0, plant],
        [1, alternative],
      ],
    }),
  ]),
);
positive("env_legacy_missing_reading", "legacy", legacy, { resolve: "missing-reading" });
positive("env_all_pointer_sorts", "all-targets", view([entry(all)]));
positive(
  "env_bound_reading",
  "bound",
  view([entry(a, { expanded: [[1, empty()]], readings: [[1, boundReading]] })]),
  { originalReading: holeReading },
);
const reserved = JSON.parse(
  '{"props":{"__proto__":{"pick":{"order":"lexById"}},"constructor":{"merge":"count"}},"default":{"pick":{"order":"lexById"}},"name":"Reserved"}',
) as Reading;
positive(
  "env_reading_metadata",
  "reserved-keys",
  view([entry(a, { expanded: [[1, empty()]], readings: [[1, reserved]] })]),
);
for (const [label, d, slot] of [
  ["out-of-range", a, 3],
  ["bytes", a, 2],
  ["primitive", all, 0],
  ["delta", all, 5],
] as const)
  bad(
    "env_invalid_expansion_indices",
    label,
    wire(view([entry(d, { expanded: [[slot, empty()]] })])),
  );
bad(
  "env_invalid_expansion_indices",
  "orphan",
  rootEntry(wire(original), (e) => edit(e, "expanded", array([]))),
);

for (const key of ["expanded", "readings"]) {
  const w = wire(meta),
    items = field(
      field(field(field(w, "root"), "props"), "child").t === "array"
        ? (
            field(field(field(w, "root"), "props"), "child") as {
              t: "array";
              v: readonly CborValue[];
            }
          ).v[0]!
        : map([]),
      key,
    );
  if (items.t !== "array") throw Error("slots");
  bad(
    "env_invalid_expansion_indices",
    `duplicate-${key}-slot`,
    rootEntry(w, (e) => edit(e, key, array([items.v[0]!, items.v[0]!]))),
  );
  bad(
    "env_invalid_expansion_indices",
    `reversed-${key}-slots`,
    rootEntry(w, (e) => edit(e, key, array([...items.v].reverse()))),
  );
}
for (const t of ["appearances", "readings"]) {
  const w = wire(original),
    tab = field(w, t);
  if (tab.t !== "array") throw Error("table");
  bad("env_missing_extra_table", `missing-${t}`, edit(w, t, array([])));
  bad("env_missing_extra_table", `duplicate-${t}`, edit(w, t, array([...tab.v, ...tab.v])));
  const extra = t === "appearances" ? appearance(b) : readingBytes(other),
    records = [
      ...tab.v,
      map([
        ["key", tstr(contentAddress(extra))],
        ["value", bstr(extra)],
      ]),
    ].sort((a, b) => {
      const ka = field(a, "key"),
        kb = field(b, "key");
      if (ka.t !== "tstr" || kb.t !== "tstr") throw Error("key");
      return ka.v < kb.v ? -1 : 1;
    });
  bad("env_missing_extra_table", `extra-${t}`, edit(w, t, array(records)));
}
const w = wire(original);
if (w.t !== "map") throw Error("map");
const wh = bytesToHex(encode(w));
const duplicateFields = [...w.v, w.v[0]!].sort(([a], [b]) =>
  Buffer.compare(Buffer.from(encode(tstr(a))), Buffer.from(encode(tstr(b)))),
);
negative.push({
  id: "env_missing_extra_table",
  variant: "duplicate-map",
  envelopeHex: bytesToHex(
    Uint8Array.from([
      0xa5,
      ...duplicateFields.flatMap(([k, v]) => [...encode(tstr(k)), ...encode(v)]),
    ]),
  ),
  error: "invalid-evidence",
});
bad("env_canonical_malformed", "unknown-field", map([...w.v, ["unknown", bool(true)]]));
bad(
  "env_canonical_malformed",
  "annotation-type",
  rootEntry(w, (e) => edit(e, "negated", tstr("false"))),
);
for (const [variant, envelopeHex] of [
  ["trailing", wh + "f4"],
  ["invalid-utf8", "61ff"],
  ["integer-index", wh.replace("65696e646578f93c00", "65696e64657801")],
  ["nonshort-float-index", wh.replace("65696e646578f93c00", "65696e646578fa3f800000")],
])
  negative.push({ id: "env_canonical_malformed", variant, envelopeHex, error: "invalid-evidence" });
const chunks = w.v.map(([k, v]) => ({ k, bytes: encode(map([[k, v]])).slice(1) }));
chunks.sort((a, b) =>
  a.k === "format"
    ? -1
    : b.k === "format"
      ? 1
      : Buffer.compare(Buffer.from(encode(tstr(a.k))), Buffer.from(encode(tstr(b.k)))),
);
negative.push({
  id: "env_canonical_malformed",
  variant: "map-order",
  envelopeHex: bytesToHex(Uint8Array.from([0xa4, ...chunks.flatMap((f) => [...f.bytes])])),
  error: "invalid-evidence",
});
bad(
  "env_signature_choice",
  "invalid-signature",
  wire(view([entry({ ...a, sig: "00".repeat(64) })])),
);
const upperClaims = {
    ...a.claims,
    author: a.claims.author.toUpperCase().replace("ED25519:", "ed25519:"),
  },
  upperId = computeId(upperClaims);
const upper = {
  id: upperId,
  claims: upperClaims,
  sig: bytesToHex(ed25519.sign(Buffer.from(upperId, "hex"), Buffer.from(seed, "hex"))),
};
const nativeReject = [
  {
    id: "env_signature_choice",
    variant: "uppercase-signature",
    native: native(view([entry({ ...a, sig: a.sig!.toUpperCase() })])),
    error: "invalid-evidence",
  },
  {
    id: "env_signature_choice",
    variant: "uppercase-author",
    native: native(view([entry(upper)])),
    error: "invalid-evidence",
  },
];
const counts = {
  appearances: 2,
  entries: 2,
  nodes: 2,
  depth: 2,
  pointers: 3,
  buckets: 2,
  readings: 2,
  syntaxNodes: 3,
  syntaxDepth: 3,
  artifactBytes: encode(wire(original)).length,
};
for (const [key, exact] of Object.entries(counts)) {
  const n =
    key === "appearances"
      ? view([entry(a), entry(b)])
      : key === "entries"
        ? view([entry(a), entry(a)])
        : key === "buckets"
          ? view([entry(a)], { empty: [] })
          : key === "readings"
            ? meta
            : original;
  positive("env_finite_bounds", `at-${key}`, n, { limits: { [key]: exact } });
  bad("env_finite_bounds", `over-${key}`, wire(n), "resource-limit", { [key]: exact - 1 }, n);
}
// Independent exact wire sizes, not the codecs' conservative preallocation counters.
const payloadA = delta(40, [{ role: "payload", target: "x".repeat(2048) }]);
const payloadB = delta(41, [{ role: "payload", target: "y".repeat(2048) }]);
const primitiveMetadata = {
  ...plant,
  default: {
    pick: {
      order: {
        byAuthorRank: Array.from({ length: 32 }, (_, i) => `author-${i}-${"é".repeat(64)}`),
      },
    },
  },
};
for (const [variant, n] of [
  ["cumulative-payload-bytes", view([entry(payloadA), entry(payloadB)])],
  [
    "repeated-node-text-bytes",
    view([
      entry(a, {
        expanded: [
          [0, empty("é".repeat(1024))],
          [1, empty("é".repeat(1024))],
        ],
      }),
    ]),
  ],
  [
    "primitive-metadata-bytes",
    view([entry(a, { expanded: [[1, empty()]], readings: [[1, primitiveMetadata]] })]),
  ],
] as const) {
  const exact = encode(wire(n)).length;
  positive("env_finite_bounds", `at-${variant}`, n, { limits: { artifactBytes: exact } });
  bad(
    "env_finite_bounds",
    `over-${variant}`,
    wire(n),
    "resource-limit",
    { artifactBytes: exact - 1 },
    n,
  );
}
// Invalid map keys cannot be counted as semantic value nodes by a guard.
const emptyWire = wire(empty());
if (emptyWire.t !== "map") throw Error("map");
const badRootKey = Uint8Array.from([
  0xa4,
  ...emptyWire.v
    .slice()
    .sort(([a], [b]) => Buffer.compare(Buffer.from(encode(tstr(a))), Buffer.from(encode(tstr(b)))))
    .flatMap(([k, v]) => [...encode(tstr(k)), ...(k === "root" ? [0xa1, 0xa0, 0xa0] : encode(v))]),
]);
negative.push({
  id: "env_canonical_malformed",
  variant: "container-map-key-under-node-bound",
  envelopeHex: bytesToHex(badRootKey),
  error: "invalid-evidence",
  limits: { nodes: 1 },
});
const readingFixtures = [
  reading,
  plant,
  other,
  alternative,
  holeReading,
  boundReading,
  reserved,
].map((r, i) => ({
  variant: `reading-${i}`,
  native: r,
  appearanceHex: bytesToHex(readingBytes(r)),
  semanticPin: contentAddress(encode(jsonToCbor({ props: r.props, default: r.default }))),
}));
// Hand-counted semantic grammar boundaries; wrappers add zero, family positions add one.
const syntaxBudgets = [
  { variant: "empty-scalars", native: reading, nodes: 3, depth: 3, valid: true },
  {
    variant: "chain-leaves",
    native: {
      ...reading,
      default: {
        pick: {
          order: { chain: ["lexById", { byTimestamp: "asc" }, { byAuthorRank: ["one", "two"] }] },
        },
      },
    },
    nodes: 6,
    depth: 4,
    valid: true,
  },
  {
    variant: "ppred-hole-wrappers",
    native: {
      ...reading,
      default: {
        pick: {
          order: {
            byPred: {
              pred: {
                hasPointer: {
                  role: { exact: "r" },
                  targetEntity: { hole: "entity" },
                  targetValue: { vcmp: { cmp: "eq", value: { hole: "value" } } },
                },
              },
              then: "lexById",
            },
          },
        },
      },
    },
    nodes: 10,
    depth: 7,
    valid: true,
  },
  {
    variant: "aliased-trust-leaf",
    native: {
      ...reading,
      default: {
        pick: {
          order: {
            byPred: {
              pred: { hasPointer: { role: { aliased: { name: "Alias", trust: "true" } } } },
              then: "lexById",
            },
          },
        },
      },
    },
    nodes: 8,
    depth: 7,
    valid: true,
  },
  {
    variant: "principal-policy",
    native: {
      ...reading,
      default: {
        pick: {
          order: {
            byPred: {
              pred: {
                actsFor: { root: authorForSeed(seed), policy: { kind: "exact", scope: "read" } },
              },
              then: "lexById",
            },
          },
        },
      },
    },
    nodes: 6,
    depth: 5,
    valid: true,
  },
  // Inline Schema/Term/Mask/Group/Extract positions are counted even if the old policy
  // grammar subsequently refuses inView. This budget probe makes no legal-codec-domain claim.
  {
    variant: "inline-schema-scalars",
    native: {
      ...reading,
      default: {
        pick: {
          order: {
            byPred: {
              pred: {
                inView: {
                  term: {
                    op: "resolve",
                    schema: reading,
                    in: {
                      op: "prune",
                      keep: "all",
                      in: {
                        op: "group",
                        key: "byRole",
                        in: { op: "mask", policy: "drop", in: "input" },
                      },
                    },
                  },
                  field: "id",
                  extract: { field: "id" },
                },
              },
              then: "lexById",
            },
          },
        },
      },
    },
    nodes: 16,
    depth: 9,
    valid: false,
  },
];
writeFileSync(
  new URL("../../../vectors/materialization/evidence-envelope.json", import.meta.url),
  JSON.stringify(
    {
      format: "rhizomatic.evidence-vectors/1",
      oracle:
        "Explicit MR04-07 grammar using pre-existing C/hash/sign only. No M1 codec imports; independent Python empty oracles supplement these goldens.",
      positives,
      negative,
      nativeReject,
      readingFixtures,
      syntaxBudgets,
    },
    null,
    2,
  ) + "\n",
);
