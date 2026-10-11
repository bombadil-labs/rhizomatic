// Independent MR-08..21 oracles. No M2 codec, endpoint, evaluator or result-reader imports.
// Existing L0 signing/hash/C and native syntax encoders supply cryptographic primitives only.
// Selected HViews and terminal Views below are hand constructed from each fixture's facts.
import { writeFileSync, mkdirSync } from "node:fs";
import {
  array,
  bool,
  bstr,
  decode,
  encode,
  float,
  map,
  tstr,
  type CborValue,
} from "../src/delta/cbor.js";
import { canonicalBytes, claimsToCbor } from "../src/delta/delta.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import { ed25519 } from "@noble/curves/ed25519";
import { hexToBytes } from "@noble/hashes/utils";
import { bytesToHex, contentAddress } from "../src/delta/hash.js";
import { claimsToJson, parseClaims } from "../src/delta/json-profile.js";
function serializeCommandDelta(d: Delta) {
  return {
    id: d.id,
    claims: claimsToJson(d.claims),
    ...(d.sig === undefined ? {} : { sig: d.sig }),
  };
}
import {
  termCanonicalHex,
  termHash,
  schemaCanonicalHex,
  schemaHash,
} from "../src/syntax/term-io.js";
import { hviewCanonicalHex, type HView } from "../src/algebra/hview.js";
import type { Delta, Target } from "../src/delta/types.js";
import type { Schema, Term } from "../src/syntax/model.js";
const C_EMPTY = encode(map([]));
const prefix = "rhizomatic.materialization.";
const seeds = {
  receiver: "03".repeat(32),
  caller: "04".repeat(32),
  definition: "05".repeat(32),
  capturer: "06".repeat(32),
  peer: "07".repeat(32),
};
const keys = Object.fromEntries(Object.entries(seeds).map(([k, v]) => [k, authorForSeed(v)]));
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const p = (value: string | number | boolean): Target => ({ kind: "primitive", value });
const ent = (id: string): Target => ({ kind: "entity", entity: { id } });
const ref = (delta: string): Target => ({ kind: "delta", deltaRef: { delta } });
const blob = (value: Uint8Array): Target => ({ kind: "bytes", mime: "application/cbor", value });
const digest = (ids: string[]) => contentAddress(encode(array([...ids].sort().map(tstr))));
const limits = {
  artifactBytes: 16777216,
  deliveryAppearances: 8192,
  deliveryBytes: 33554432,
  appearances: 4096,
  entries: 16384,
  nodes: 4096,
  depth: 32,
  pointers: 256,
  buckets: 256,
  readings: 256,
  definitions: 256,
  syntaxDepth: 64,
  syntaxNodes: 16384,
  roots: 64,
  registrations: 64,
  components: 64,
  inventoryIds: 16384,
};
function description(
  kind: string,
  fields: readonly (readonly [string, Target | readonly Target[]])[],
  seed = seeds.caller,
  time = 1000,
): Delta {
  return signClaims(
    {
      author: authorForSeed(seed),
      timestamp: time,
      validFrom: time,
      pointers: [
        { role: prefix + "kind", target: p(kind) },
        ...fields.flatMap(([k, v]) =>
          (Array.isArray(v) ? v : [v]).map((target) => ({
            role: prefix + k,
            target: target as Target,
          })),
        ),
      ],
    },
    seed,
  );
}
const operations = ["gather", "resolve"].map((verb) =>
  description(
    "operation/1",
    [
      ["name", ent(prefix + verb)],
      ["interpreter", p(prefix + verb + "/1")],
      ["input-contract", p(prefix + verb + "/1")],
      ["output-contract", p(prefix + "outcome/1")],
      ["effect", p("none")],
      ["replay", p("re-evaluate/1")],
      ["dependencies", p("explicit-support/1")],
    ],
    seeds.receiver,
    0,
  ),
);
const root = "item:fern";
const term: Term = {
  kind: "group",
  key: { kind: "byTargetContext" },
  of: {
    kind: "select",
    pred: { kind: "hasPointer", ppred: { targetEntity: { kind: "root" } } },
    of: { kind: "mask", policy: { kind: "drop" }, of: { kind: "input" } },
  },
};
const reading: Schema = {
  name: "Plant",
  alg: 1,
  props: new Map([["tag", { kind: "all", order: { kind: "byTimestamp", dir: "asc" } }]]),
  default: { kind: "pick", order: { kind: "byTimestamp", dir: "desc" } },
};
function definition(kind: "hyper" | "reading", bodyHex: string, name: string): Delta {
  const ns = kind === "hyper" ? "hyperschema" : "schema";
  return signClaims(
    {
      author: keys.definition!,
      timestamp: 0,
      validFrom: 0,
      pointers: [
        {
          role: `rhizomatic.${ns}.defines`,
          target: { kind: "entity", entity: { id: `definition:${name}`, context: "definition" } },
        },
        { role: `rhizomatic.${ns}.name`, target: p(name) },
        { role: `rhizomatic.${ns}.alg`, target: p(1) },
        { role: `rhizomatic.${ns}.term`, target: p(bodyHex) },
      ],
    },
    seeds.definition,
  );
}
const hyper = definition("hyper", termCanonicalHex(term), "Plant"),
  schema = definition("reading", schemaCanonicalHex(reading), "Plant");
const defs = [hyper, schema].sort((a, b) => (a.id < b.id ? -1 : 1));
const authorityRoot = contentAddress(encode(tstr("native-fixture-authority-root")));
const selection = map([
  ["profile", tstr("host-authorized-snapshot/1")],
  ["parameters", bstr(encode(map([])))],
]);
const binding = description(
  "source-binding/1",
  [
    ["receiver", ent(keys.receiver!)],
    [
      "spec",
      blob(
        encode(
          map([
            ["sourceId", tstr("primary")],
            ["capturer", tstr(keys.capturer!)],
            ["authorityRoot", tstr(authorityRoot)],
            ["selection", selection],
          ]),
        ),
      ),
    ],
  ],
  seeds.receiver,
  0,
);
const authorityOriginal = description(
  "authority/1",
  [
    ["source-binding", ref(binding.id)],
    [
      "spec",
      blob(
        encode(
          map([
            ["root", tstr(authorityRoot)],
            ["epoch", float(1)],
            ["context", bstr(encode(map([])))],
          ]),
        ),
      ),
    ],
  ],
  seeds.capturer,
  0,
);
const authority = signClaims({ ...authorityOriginal.claims, validUntil: 2000 }, seeds.capturer);
function configuration(overrides: Record<string, number> = {}, selectedBinding = binding) {
  return description(
    "endpoint/1",
    [
      ["receiver", ent(keys.receiver!)],
      ["caller", p(keys.caller!)],
      ["administrator", p(keys.caller!)],
      [
        "installed",
        operations
          .map((o) => o.id)
          .sort()
          .map(ref),
      ],
      ["source-binding", [ref(selectedBinding.id)]],
      [
        "limits",
        blob(
          encode(map(Object.entries({ ...limits, ...overrides }).map(([k, v]) => [k, float(v)]))),
        ),
      ],
    ],
    seeds.receiver,
    0,
  );
}
const config = configuration();
function fact(prop: string, value: Target, timestamp: number) {
  return signClaims(
    {
      author: keys.peer!,
      timestamp,
      validFrom: 0,
      pointers: [
        { role: "subject", target: { kind: "entity", entity: { id: root, context: prop } } },
        { role: "value", target: value },
      ],
    },
    seeds.peer,
  );
}
const a = fact("height", p(42), 10),
  t = fact("tag", p("shade"), 11),
  x = fact(
    "payload",
    { kind: "bytes", mime: "application/octet-stream", value: hex("00ff01") },
    12,
  );
const n1 = signClaims(
  {
    author: keys.peer!,
    timestamp: 30,
    validFrom: 30,
    pointers: [{ role: "negates", target: ref(a.id) }],
  },
  seeds.peer,
);
const n2 = signClaims(
  {
    author: keys.peer!,
    timestamp: 40,
    validFrom: 40,
    pointers: [{ role: "negates", target: ref(n1.id) }],
  },
  seeds.peer,
);
function appearance(d: Delta) {
  return encode(
    map([
      ["id", tstr(d.id)],
      ["claims", bstr(canonicalBytes(d.claims))],
      ["sig", bstr(hex(d.sig!))],
    ]),
  );
}
function source(
  rows: Delta[],
  observation = 1000,
  auth = authority,
  historicalCutoff?: number,
  selectedBinding = binding,
) {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const originals = sorted.map((d) => ({
    d,
    bytes: appearance(d),
    key: contentAddress(appearance(d)),
  }));
  const components = [
    map([
      ["peer", tstr(keys.peer!)],
      ["revision", tstr(digest(sorted.map((d) => d.id)))],
      ["capturedAt", float(observation)],
      ["rawIds", array(sorted.map((d) => tstr(d.id)))],
      ["operandIds", array(sorted.map((d) => tstr(d.id)))],
    ]),
  ];
  const membership = digest(sorted.map((d) => d.id)),
    appearanceDigest = digest(originals.map((o) => o.key));
  const revision = contentAddress(
    encode(
      map([
        ["binding", tstr(selectedBinding.id)],
        ["authority", tstr(auth.id)],
        ["selection", tstr(contentAddress(encode(selection)))],
        [
          "components",
          array(
            components.map((c) =>
              c.t === "map" ? map(c.v.filter(([k]) => k !== "capturedAt")) : c,
            ),
          ),
        ],
        ["membership", tstr(membership)],
        ["appearanceDigest", tstr(appearanceDigest)],
        ["exclusions", array([])],
      ]),
    ),
  );
  const common: (readonly [string, CborValue])[] = [
    ["binding", tstr(selectedBinding.id)],
    ["authority", tstr(auth.id)],
    ["selection", tstr(contentAddress(encode(selection)))],
    ["revision", tstr(revision)],
    ["servingAt", float(observation)],
    ...(historicalCutoff === undefined
      ? []
      : [["historicalCutoff", float(historicalCutoff)] as const]),
    ["components", array(components)],
    [
      "operands",
      array(
        originals.map((o) =>
          map([
            ["id", tstr(o.d.id)],
            ["appearance", tstr(o.key)],
            ["peers", array([tstr(keys.peer!)])],
          ]),
        ),
      ),
    ],
    ["exclusions", array([])],
    ["membership", tstr(membership)],
    ["appearanceDigest", tstr(appearanceDigest)],
  ];
  const payload = encode(
    map([
      ["format", tstr("rhizomatic.source-snapshot/1")],
      ...common,
      [
        "appearances",
        array(
          [...originals]
            .sort((a, b) => (a.key < b.key ? -1 : 1))
            .map((o) =>
              map([
                ["key", tstr(o.key)],
                ["value", bstr(o.bytes)],
              ]),
            ),
        ),
      ],
    ]),
  );
  const basis = encode(
    map([
      ["format", tstr("rhizomatic.source-basis/1")],
      ...common,
      ["snapshot", tstr(contentAddress(payload))],
    ]),
  );
  return {
    snapshot: description("snapshot/1", [["data", blob(payload)]], seeds.capturer, observation),
    capture: description(
      "capture/1",
      [
        ["source-binding", ref(selectedBinding.id)],
        ["authority", ref(auth.id)],
        ["basis", blob(basis)],
      ],
      seeds.capturer,
      observation,
    ),
    revision,
    membership,
    appearanceDigest,
    components,
    payload,
    authorityId: auth.id,
  };
}
function request(
  s: ReturnType<typeof source>,
  cfg = config,
  operandAt = 1000,
  definitionAt = 1000,
  selectedHyper = hyper,
  selectedSchema = schema,
  hyperPin = termHash(term),
  schemaPin = schemaHash(reading),
  extra: Delta[] = [],
  rootId = root,
  historicalCutoff?: number,
  bindings = C_EMPTY,
) {
  return description("request/1", [
    ["receiver", ent(keys.receiver!)],
    ["configuration", ref(cfg.id)],
    ["operation", ref(operations[0]!.id)],
    ["capture", ref(s.capture.id)],
    ["snapshot", ref(s.snapshot.id)],
    ["root", ent(rootId)],
    ["at", p(operandAt)],
    ["serving-at", p(1000)],
    ["interpretation", p("core/1")],
    ["hyperschema", ref(selectedHyper.id)],
    ["hyperschema-pin", p(hyperPin)],
    ["schema", ref(selectedSchema.id)],
    ["schema-pin", p(schemaPin)],
    ["bindings", blob(bindings)],
    ["definition-at", p(definitionAt)],
    [
      "definition",
      extra
        .map((d) => d.id)
        .sort()
        .map(ref),
    ],
    ...(historicalCutoff === undefined
      ? []
      : [["historical-cutoff", p(historicalCutoff)] as const]),
  ]);
}
function envelope(view: HView) {
  const originals = new Map<string, Uint8Array>(),
    readings = new Map<string, Uint8Array>();
  const node = (h: HView): CborValue =>
    map([
      ["id", tstr(h.id)],
      [
        "props",
        map(
          [...h.props].map(([k, entries]) => [
            k,
            array(
              entries.map((e) => {
                const bytes = appearance(e.delta),
                  key = contentAddress(bytes);
                originals.set(key, bytes);
                const expanded = [...(e.expanded ?? [])]
                  .sort(([a], [b]) => a - b)
                  .map(([index, child]) =>
                    map([
                      ["index", float(index)],
                      ["child", node(child)],
                    ]),
                  );
                const childReadings = [...(e.readings ?? [])]
                  .sort(([a], [b]) => a - b)
                  .map(([index, reading]) => {
                    const value = encode(
                        map([
                          ["body", bstr(hex(schemaCanonicalHex(reading)))],
                          ...(reading.name === undefined
                            ? []
                            : [["name", tstr(reading.name)] as const]),
                          ...(reading.alg === undefined
                            ? []
                            : [["alg", float(reading.alg)] as const]),
                        ]),
                      ),
                      key = contentAddress(value);
                    readings.set(key, value);
                    return map([
                      ["index", float(index)],
                      ["reading", tstr(key)],
                    ]);
                  });
                return map([
                  ["appearance", tstr(key)],
                  ["negated", bool(e.negated)],
                  ["expanded", array(expanded)],
                  ["readings", array(childReadings)],
                ]);
              }),
            ),
          ]),
        ),
      ],
    ]);
  const rootValue = node(view),
    records = (table: Map<string, Uint8Array>) =>
      array(
        [...table]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, value]) =>
            map([
              ["key", tstr(key)],
              ["value", bstr(value)],
            ]),
          ),
      );
  return encode(
    map([
      ["format", tstr("rhizomatic.hview-envelope/1")],
      ["root", rootValue],
      ["appearances", records(originals)],
      ["readings", records(readings)],
    ]),
  );
}
function gatherBody(
  s: ReturnType<typeof source>,
  q: Delta,
  view: HView,
  at = 1000,
  definitionAt = 1000,
  historicalCutoff?: number,
  program = {
    hyper,
    schema,
    hyperPin: termHash(term),
    schemaPin: schemaHash(reading),
    definitions: defs,
    bindings: C_EMPTY,
  },
) {
  const env = envelope(view);
  const basis = map([
    ["binding", tstr(binding.id)],
    ["revision", tstr(s.revision)],
    ["authority", tstr(s.authorityId)],
    ["selection", tstr(contentAddress(encode(selection)))],
    ["membership", tstr(s.membership)],
    ["appearanceDigest", tstr(s.appearanceDigest)],
    [
      "components",
      array(
        s.components.map((c) =>
          c.t === "map"
            ? map(c.v.filter(([k]) => ["peer", "revision", "capturedAt"].includes(k)))
            : c,
        ),
      ),
    ],
    ["at", float(at)],
    [
      "servingAt",
      float(
        q.claims.pointers.find((p) => p.role === prefix + "serving-at")!.target.kind === "primitive"
          ? Number(
              (
                q.claims.pointers.find((p) => p.role === prefix + "serving-at")!.target as {
                  kind: "primitive";
                  value: number;
                }
              ).value,
            )
          : 1000,
      ),
    ],
    ["bindings", bstr(program.bindings)],
    ["definitionAt", float(definitionAt)],
    ["interpretation", tstr("core/1")],
    ["hyperschema", tstr(program.hyper.id)],
    ["hyperschemaPin", tstr(program.hyperPin)],
    ["schema", tstr(program.schema.id)],
    ["schemaPin", tstr(program.schemaPin)],
    ["definitions", array(program.definitions.map((d) => bstr(appearance(d))))],
    ["definitionDigest", tstr(digest(program.definitions.map((d) => d.id)))],
    ...(historicalCutoff === undefined
      ? []
      : [["historicalCutoff", float(historicalCutoff)] as const]),
  ]);
  return map([
    ["kind", tstr("gather")],
    ["root", tstr(view.id)],
    ["basis", basis],
    ["envelope", bstr(env)],
    ["transport", tstr(contentAddress(env))],
    ["hview", tstr(contentAddress(hex(hviewCanonicalHex(view))))],
  ]);
}
function outcome(q: Delta, body: CborValue, status = "completed", cfg = config) {
  return description(
    "outcome/1",
    [
      ["receiver", ent(keys.receiver!)],
      ["configuration", ref(cfg.id)],
      ["request", ref(q.id)],
      ["status", p(status)],
      ["result", blob(encode(body))],
    ],
    seeds.receiver,
  );
}
type DebugDelta = ReturnType<typeof serializeCommandDelta>;
interface CommandFixture {
  id: string;
  receivedAt?: number;
  rows: DebugDelta[];
  source: {
    binding: string;
    revision: string;
    authority: string;
    servingAt: number;
    requiredSupport: string[];
    cutoff?: number;
  };
  request: DebugDelta;
  delivery: DebugDelta[];
  resolve: DebugDelta;
  resolveDelivery: DebugDelta[];
  capture: DebugDelta;
  snapshot: DebugDelta;
  expected: {
    gather: DebugDelta;
    gatherBodyHex: string;
    resolve: DebugDelta;
    resolveBodyHex: string;
    valueHex: string;
  };
  boot?: ReturnType<typeof bootJson>;
}
const positives: CommandFixture[] = [];
for (const [id, rows, selected, at, definitionAt, cutoff, rootId] of [
  ["plant", [a, t, x], [a, t, x], 1000, 1000, undefined, root],
  ["empty", [a, t, x], [], 1000, 1000, undefined, "item:moss"],
  ["negated", [a, t, x, n1], [t, x], 1000, 1000, undefined, root],
  ["restored", [a, t, x, n1, n2], [a, t, x], 1000, 1000, undefined, root],
  ["historical", [a, t, x, n1, n2], [a, t, x], 20, 0, 20, root],
] as const) {
  const s = source([...rows], 1000, authority, cutoff),
    q = request(
      s,
      config,
      at,
      definitionAt,
      hyper,
      schema,
      termHash(term),
      schemaHash(reading),
      [],
      rootId,
      cutoff,
    );
  const view: HView = {
    id: rootId,
    props: new Map(
      selected.map((d) => [
        d === a ? "height" : d === t ? "tag" : "payload",
        [{ delta: d, negated: false }],
      ]),
    ),
  };
  const gathered = gatherBody(s, q, view, at, definitionAt, cutoff);
  const evidence = description("evidence/1", [["result", blob(encode(gathered))]]);
  const resolve = description("request/1", [
    ["receiver", ent(keys.receiver!)],
    ["configuration", ref(config.id)],
    ["operation", ref(operations[1]!.id)],
    ["evidence", ref(evidence.id)],
  ]);
  const value = encode(
    map(
      selected.map((d) => [
        d === a ? "height" : d === t ? "tag" : "payload",
        d === a
          ? float(42)
          : d === t
            ? array([tstr("shade")])
            : map([
                ["mime", tstr("application/octet-stream")],
                ["value", bstr(hex("00ff01"))],
              ]),
      ]),
    ),
  );
  if (gathered.t !== "map") throw Error();
  const resolved = map([
    ["kind", tstr("resolve")],
    ...gathered.v.filter(([k]) => ["root", "basis", "transport", "hview"].includes(k)),
    ["value", bstr(value)],
    ["view", tstr(contentAddress(value))],
  ]);
  positives.push({
    id,
    rows: rows.map(serializeCommandDelta),
    source: {
      binding: binding.id,
      revision: s.revision,
      authority: authority.id,
      servingAt: 1000,
      ...(cutoff === undefined ? {} : { cutoff }),
      requiredSupport: defs.map((d) => d.id),
    },
    request: serializeCommandDelta(q),
    delivery: [q, s.capture, s.snapshot, authority, ...defs].map(serializeCommandDelta),
    resolve: serializeCommandDelta(resolve),
    resolveDelivery: [resolve, evidence].map(serializeCommandDelta),
    capture: serializeCommandDelta(s.capture),
    snapshot: serializeCommandDelta(s.snapshot),
    expected: {
      gather: serializeCommandDelta(outcome(q, gathered)),
      gatherBodyHex: bytesToHex(encode(gathered)),
      resolve: serializeCommandDelta(outcome(resolve, resolved)),
      resolveBodyHex: bytesToHex(encode(resolved)),
      valueHex: bytesToHex(value),
    },
  });
}
const s = source([a, t, x]);
const reflective = definition(
  "reading",
  bytesToHex(
    encode(
      map([
        ["props", map([])],
        [
          "default",
          map([
            [
              "pick",
              map([
                [
                  "byPred",
                  map([
                    [
                      "pred",
                      map([
                        [
                          "inView",
                          map([
                            ["term", tstr("input")],
                            ["field", tstr("id")],
                            ["extract", map([["field", tstr("id")]])],
                          ]),
                        ],
                      ]),
                    ],
                    ["then", tstr("lexById")],
                  ]),
                ],
              ]),
            ],
          ]),
        ],
      ]),
    ),
  ),
  "Reflective",
);
const hostileRequests = [
  [
    "reflective_top",
    request(s, config, 1000, 1000, hyper, reflective),
    [hyper, reflective],
    "invalid-definition",
  ],
  [
    "reflective_wrong_pin",
    request(s, config, 1000, 1000, hyper, reflective, termHash(term), authorityRoot),
    [hyper, reflective],
    "invalid-definition",
  ],
] as const;
const negatives = hostileRequests.map(([id, q, definitions, code]) => ({
  id,
  request: serializeCommandDelta(q),
  delivery: [q, s.capture, s.snapshot, authority, ...definitions].map(serializeCommandDelta),
  source: {
    binding: binding.id,
    revision: s.revision,
    authority: authority.id,
    servingAt: 1000,
    requiredSupport: definitions.map((d) => d.id).sort(),
  },
  expected: {
    code,
    outcome: serializeCommandDelta(outcome(q, map([["code", tstr(code)]]), "refused")),
  },
}));

// Negative expected codes are phase-oracles, not generated by either witness.
const bootJson = (cfg: Delta) => ({
  configuration: serializeCommandDelta(cfg),
  declarations: operations.map(serializeCommandDelta),
  bindings: [serializeCommandDelta(binding)],
});
const update = (value: CborValue, key: string, data: CborValue): CborValue =>
  value.t === "map"
    ? map(value.v.map(([k, v]) => [k, k === key ? data : v]))
    : (() => {
        throw Error();
      })();
function repoint(d: Delta, role: string, target: Target, seed = seeds.caller): Delta {
  return signClaims(
    {
      ...d.claims,
      pointers: d.claims.pointers.map((p) => (p.role === prefix + role ? { ...p, target } : p)),
    },
    seed,
  );
}
const extraNegatives: Record<string, unknown>[] = [];
function negative(
  id: string,
  q: Delta,
  delivery: unknown[],
  code: string,
  options: {
    cfg?: Delta;
    receivedAt?: number;
    preflight?: string;
    actions?: string[];
    source?: ReturnType<typeof source>;
    definitions?: Delta[];
    fixtureSourceId?: string;
    nativeRows?: Delta[];
    first?: { receivedAt: number; outcome: Delta };
  } = {},
) {
  const cfg = options.cfg ?? config,
    at = options.receivedAt ?? 1000,
    src = options.source ?? s;
  let expectedOutcome = outcome(q, map([["code", tstr(code)]]), "refused", cfg);
  if (at !== 1000)
    expectedOutcome = signClaims(
      { ...expectedOutcome.claims, timestamp: at, validFrom: at },
      seeds.receiver,
    );
  extraNegatives.push({
    id,
    ...(options.first
      ? {
          first: {
            receivedAt: options.first.receivedAt,
            outcome: serializeCommandDelta(options.first.outcome),
          },
        }
      : {}),
    fixtureSourceId: options.fixtureSourceId ?? "plant",
    ...(options.nativeRows === undefined
      ? {}
      : {
          nativeSource: {
            rows: options.nativeRows.map(serializeCommandDelta),
            snapshot: serializeCommandDelta(src.snapshot),
            source: {
              binding: binding.id,
              requiredSupport: (options.definitions ?? defs).map((d) => d.id).sort(),
            },
          },
        }),
    boot: bootJson(cfg),
    receivedAt: at,
    request: serializeCommandDelta(q),
    delivery,
    actions: options.actions ?? [],
    source: {
      binding: binding.id,
      revision: src.revision,
      authority: authority.id,
      servingAt: at,
      requiredSupport: (options.definitions ?? defs).map((d) => d.id).sort(),
    },
    expected: {
      code,
      preflight: options.preflight ?? code,
      outcome: serializeCommandDelta(expectedOutcome),
    },
  });
}
const sourceDelivery = (q: Delta, src = s, ds: Delta[] = defs) =>
  [q, src.capture, src.snapshot, authority, ...ds].map(serializeCommandDelta);
const good = request(s);
for (const [id, delivery, code] of [
  ["missing_capture", sourceDelivery(good).filter((d) => d.id !== s.capture.id), "missing-support"],
  [
    "missing_authority",
    sourceDelivery(good).filter((d) => d.id !== authority.id),
    "missing-support",
  ],
  ["extra_boot", [...sourceDelivery(good), serializeCommandDelta(config)], "unexpected-support"],
  ["extra_ordinary", [...sourceDelivery(good), serializeCommandDelta(a)], "unexpected-support"],
  [
    "missing_and_extra",
    [...sourceDelivery(good).filter((d) => d.id !== hyper.id), serializeCommandDelta(a)],
    "missing-support",
  ],
  [
    "invalid_duplicate",
    [...sourceDelivery(good), { ...serializeCommandDelta(hyper), sig: "00".repeat(64) }],
    "invalid-appearance",
  ],
  [
    "invalid_duplicate_reverse",
    [{ ...serializeCommandDelta(hyper), sig: "00".repeat(64) }, ...sourceDelivery(good).reverse()],
    "invalid-appearance",
  ],
  ["unknown_appearance_size", [null, ...sourceDelivery(good)], "invalid-appearance"],
] as const)
  negative(id, good, [...delivery], code);
negative("absent_grant", good, sourceDelivery(good), "unauthorized", {
  preflight: "input-valid",
  actions: ["absent-grant"],
});
negative("refused_support", good, sourceDelivery(good), "unauthorized", {
  preflight: "input-valid",
  actions: ["refuse-support-before"],
});
negative("refused_support_final", good, sourceDelivery(good), "unauthorized", {
  preflight: "input-valid",
  actions: ["refuse-support-after-first-check"],
});
negative("physical_remove", good, sourceDelivery(good), "source-changed", {
  preflight: "input-valid",
  actions: ["remove-row-before"],
});
negative("equal_count_replace", good, sourceDelivery(good), "source-changed", {
  preflight: "input-valid",
  actions: ["replace-row-before"],
});
negative("changed_final", good, sourceDelivery(good), "source-changed", {
  preflight: "input-valid",
  actions: ["remove-row-after-first-check"],
});
negative("revoked_after_success", good, sourceDelivery(good), "unauthorized", {
  preflight: "input-valid",
  actions: ["success-then-revoke"],
});
const wrongPin = request(s, config, 1000, 1000, hyper, schema, authorityRoot);
negative("wrong_top_pin", wrongPin, sourceDelivery(wrongPin), "pin-mismatch");
const principalReading: Schema = {
  props: new Map(),
  default: {
    kind: "pick",
    order: {
      kind: "byPred",
      pred: { kind: "actsFor", root: keys.peer!, policy: { kind: "exact", scope: "read" } },
      then: { kind: "lexById" },
    },
  },
};
const principalDef = definition("reading", schemaCanonicalHex(principalReading), "Principal");
for (const [id, pin, code] of [
  ["native_valid_principal", schemaHash(principalReading), "invalid-program"],
  ["native_valid_principal_wrong_pin", authorityRoot, "pin-mismatch"],
] as const) {
  const q = request(s, config, 1000, 1000, hyper, principalDef, termHash(term), pin);
  negative(id, q, sourceDelivery(q, s, [hyper, principalDef]), code, {
    definitions: [hyper, principalDef],
  });
}
const childTerm: Term = {
  kind: "expand",
  role: { kind: "exact", value: "subject" },
  schema: { kind: "name", name: "Plant" },
  reading: { kind: "name", name: "Reflective" },
  of: term,
};
const childHyper = definition("hyper", termCanonicalHex(childTerm), "BedReflective");
for (const [id, pin] of [
  ["reflective_child", termHash(childTerm)],
  ["reflective_child_wrong_pin", authorityRoot],
] as const) {
  const q = request(s, config, 1000, 1000, childHyper, schema, pin, schemaHash(reading), [
    hyper,
    reflective,
  ]);
  negative(
    id,
    q,
    sourceDelivery(q, s, [childHyper, schema, hyper, reflective]),
    "invalid-definition",
    { definitions: [childHyper, schema, hyper, reflective] },
  );
}
const childView: HView = {
  id: root,
  props: new Map([
    [
      "height",
      [
        {
          delta: a,
          negated: false,
          expanded: new Map([[0, { id: "item:bed", props: new Map() }]]),
          readings: new Map([[0, principalReading]]),
        },
      ],
    ],
  ]),
};
const supplied = gatherBody(s, good, childView);
function resolveEvidence(id: string, body: CborValue, code: string, cfg = config) {
  const evidence = description("evidence/1", [["result", blob(encode(body))]]),
    q = description("request/1", [
      ["receiver", ent(keys.receiver!)],
      ["configuration", ref(cfg.id)],
      ["operation", ref(operations[1]!.id)],
      ["evidence", ref(evidence.id)],
    ]);
  negative(id, q, [q, evidence].map(serializeCommandDelta), code, { cfg });
}
resolveEvidence("supplied_child_feature", supplied, "invalid-program");
resolveEvidence(
  "supplied_child_nodes_priority",
  supplied,
  "resource-limit",
  configuration({ nodes: 1 }),
);
resolveEvidence(
  "supplied_child_context_priority",
  update(supplied, "transport", tstr(authorityRoot)),
  "invalid-evidence",
);
const badBasis =
  supplied.t === "map"
    ? new Map(supplied.v).get("basis")!
    : (() => {
        throw Error();
      })();
const badDefs = [hyper, reflective].sort((a, b) => (a.id < b.id ? -1 : 1));
const originalBad = update(
  update(
    update(
      update(badBasis, "definitions", array(badDefs.map((d) => bstr(appearance(d))))),
      "schema",
      tstr(reflective.id),
    ),
    "schemaPin",
    tstr(authorityRoot),
  ),
  "definitionDigest",
  tstr(digest(badDefs.map((d) => d.id))),
);
resolveEvidence(
  "original_definition_before_envelope_nodes",
  update(supplied, "basis", originalBad),
  "invalid-definition",
  configuration({ nodes: 1 }),
);
// Envelope is illegal structurally as well as unsupported semantically; codec must win.
const malformedEnv = encode(
  map([
    ["format", tstr("rhizomatic.hview-envelope/1")],
    ["appearances", array([])],
    ["readings", array([])],
    [
      "root",
      map([
        ["id", tstr(root)],
        ["props", tstr("wrong")],
      ]),
    ],
  ]),
);
resolveEvidence(
  "supplied_child_malformed_priority",
  update(supplied, "envelope", bstr(malformedEnv)),
  "invalid-evidence",
);
// Body closure defects reached only through exact request+evidence delivery.
const baseBody = decode(hex(positives[0]!.expected.gatherBodyHex));
const baseBasis =
  baseBody.t === "map"
    ? new Map(baseBody.v).get("basis")!
    : (() => {
        throw Error();
      })();
for (const d of defs) {
  const remaining = defs.filter((x) => x.id !== d.id);
  const basis = update(
    update(baseBasis, "definitions", array(remaining.map((d) => bstr(appearance(d))))),
    "definitionDigest",
    tstr(digest(remaining.map((d) => d.id))),
  );
  resolveEvidence(
    d === hyper ? "missing_embedded_hyper" : "missing_embedded_schema",
    update(baseBody, "basis", basis),
    "definition-closure",
  );
}
const unsigned = decode(appearance(a));
if (unsigned.t !== "map") throw Error();
const rawSnapshot = decode(s.payload);
if (rawSnapshot.t !== "map") throw Error();
const unsignedBytes = encode(map(unsigned.v.filter(([k]) => k !== "sig"))),
  unsignedKey = contentAddress(unsignedBytes);
const rawFields = new Map(rawSnapshot.v),
  oldKey = contentAddress(appearance(a));
const alteredAppearances = rawFields.get("appearances")!;
if (alteredAppearances.t !== "array") throw Error();
const altered = update(
  rawSnapshot,
  "appearances",
  array(
    alteredAppearances.v
      .map((v) =>
        v.t === "map" && new Map(v.v).get("key")!.v === oldKey
          ? map([
              ["key", tstr(unsignedKey)],
              ["value", bstr(unsignedBytes)],
            ])
          : v,
      )
      .sort((a, b) =>
        a.t === "map" && b.t === "map"
          ? String(new Map(a.v).get("key")!.v).localeCompare(String(new Map(b.v).get("key")!.v))
          : 0,
      ),
  ),
);
const unsignedCarrier = description(
  "snapshot/1",
  [["data", blob(encode(altered))]],
  seeds.capturer,
);
const unsignedRequest = repoint(good, "snapshot", ref(unsignedCarrier.id));
negative(
  "unsigned_embedded_source",
  unsignedRequest,
  sourceDelivery(unsignedRequest).map((d) =>
    d.id === s.snapshot.id ? serializeCommandDelta(unsignedCarrier) : d,
  ),
  "invalid-source",
);
for (const k of ["revision", "membership", "appearanceDigest", "selection"]) {
  const carrier = description(
      "snapshot/1",
      [["data", blob(encode(update(rawSnapshot, k, tstr(authorityRoot))))]],
      seeds.capturer,
    ),
    q = repoint(good, "snapshot", ref(carrier.id));
  negative(
    "source_bad_" + k,
    q,
    sourceDelivery(q).map((d) => (d.id === s.snapshot.id ? serializeCommandDelta(carrier) : d)),
    "invalid-source",
  );
  if (k === "revision")
    negative(
      "malformed_source_absent_grant",
      q,
      sourceDelivery(q).map((d) => (d.id === s.snapshot.id ? serializeCommandDelta(carrier) : d)),
      "unauthorized",
      { preflight: "invalid-source", actions: ["absent-grant"] },
    );
}
// Bounds: same signed definition/delivery proves phase projection, never output dispatch assurance.
const countCfg = configuration({ deliveryAppearances: 1 }),
  countQ = request(s, countCfg);
negative(
  "known_count_invalid_signature",
  countQ,
  [...sourceDelivery(countQ), { ...serializeCommandDelta(hyper), sig: "00".repeat(64) }],
  "resource-limit",
  { cfg: countCfg },
);

// Bed's fix-local want=10 must override global want=20 in its evaluated child's reading.
const localReading: Schema = {
  name: "PlantLocal",
  alg: 1,
  props: new Map(),
  default: {
    kind: "pick",
    order: {
      kind: "byPred",
      pred: {
        kind: "match",
        field: "timestamp",
        cmp: "eq",
        constant: { kind: "hole", name: "want" },
      },
      then: { kind: "byTimestamp", dir: "desc" },
    },
  },
};
const localDef = definition("reading", schemaCanonicalHex(localReading), "PlantLocal");
const bed: Term = {
  kind: "expand",
  role: { kind: "exact", value: "value" },
  schema: { kind: "name", name: "Plant" },
  reading: { kind: "name", name: "PlantLocal" },
  of: term,
};
const bedDef = definition("hyper", termCanonicalHex(bed), "Bed");
const start: Term = {
  kind: "fix",
  schema: { kind: "name", name: "Bed" },
  entity: "item:bed",
  bindings: new Map([["want", 10]]),
};
const startDef = definition("hyper", termCanonicalHex(start), "BedStart");
const link = signClaims(
  {
    author: keys.peer!,
    timestamp: 13,
    validFrom: 0,
    pointers: [
      {
        role: "subject",
        target: { kind: "entity", entity: { id: "item:bed", context: "plants" } },
      },
      { role: "value", target: ent(root) },
    ],
  },
  seeds.peer,
);
const newer = fact("height", p(55), 20);
const nestedRows = [link, a, newer, t, x],
  nestedSource = source(nestedRows),
  nestedDefs = [startDef, schema, bedDef, hyper, localDef].sort((a, b) => (a.id < b.id ? -1 : 1)),
  bindings = encode(map([["want", float(20)]]));
const nestedRequest = request(
  nestedSource,
  config,
  1000,
  1000,
  startDef,
  schema,
  termHash(start),
  schemaHash(reading),
  [bedDef, hyper, localDef],
  "item:bed",
  undefined,
  bindings,
);
const evaluated: Schema = {
  ...localReading,
  default: {
    kind: "pick",
    order: {
      kind: "byPred",
      pred: { kind: "match", field: "timestamp", cmp: "eq", constant: 10 },
      then: { kind: "byTimestamp", dir: "desc" },
    },
  },
};
const child: HView = {
  id: root,
  props: new Map([
    [
      "height",
      [a, newer].sort((a, b) => (a.id < b.id ? -1 : 1)).map((delta) => ({ delta, negated: false })),
    ],
    ["tag", [{ delta: t, negated: false }]],
    ["payload", [{ delta: x, negated: false }]],
  ]),
};
const nestedView: HView = {
  id: "item:bed",
  props: new Map([
    [
      "plants",
      [
        {
          delta: link,
          negated: false,
          expanded: new Map([[1, child]]),
          readings: new Map([[1, evaluated]]),
        },
      ],
    ],
  ]),
};
const nestedBody = gatherBody(nestedSource, nestedRequest, nestedView, 1000, 1000, undefined, {
  hyper: startDef,
  schema,
  hyperPin: termHash(start),
  schemaPin: schemaHash(reading),
  definitions: nestedDefs,
  bindings,
});
const nestedEvidence = description("evidence/1", [["result", blob(encode(nestedBody))]]);
const nestedResolve = description("request/1", [
  ["receiver", ent(keys.receiver!)],
  ["configuration", ref(config.id)],
  ["operation", ref(operations[1]!.id)],
  ["evidence", ref(nestedEvidence.id)],
]);
const nestedValue = encode(
  map([
    [
      "plants",
      map([
        ["height", float(42)],
        ["tag", tstr("shade")],
        [
          "payload",
          map([
            ["mime", tstr("application/octet-stream")],
            ["value", bstr(hex("00ff01"))],
          ]),
        ],
      ]),
    ],
  ]),
);
if (nestedBody.t !== "map") throw Error();
const nestedResolved = map([
  ["kind", tstr("resolve")],
  ...nestedBody.v.filter(([k]) => ["root", "basis", "transport", "hview"].includes(k)),
  ["value", bstr(nestedValue)],
  ["view", tstr(contentAddress(nestedValue))],
]);
positives.push({
  id: "nested_local",
  rows: nestedRows.map(serializeCommandDelta),
  source: {
    binding: binding.id,
    revision: nestedSource.revision,
    authority: authority.id,
    servingAt: 1000,
    requiredSupport: nestedDefs.map((d) => d.id),
  },
  request: serializeCommandDelta(nestedRequest),
  delivery: sourceDelivery(nestedRequest, nestedSource, nestedDefs),
  resolve: serializeCommandDelta(nestedResolve),
  resolveDelivery: [nestedResolve, nestedEvidence].map(serializeCommandDelta),
  capture: serializeCommandDelta(nestedSource.capture),
  snapshot: serializeCommandDelta(nestedSource.snapshot),
  expected: {
    gather: serializeCommandDelta(outcome(nestedRequest, nestedBody)),
    gatherBodyHex: bytesToHex(encode(nestedBody)),
    resolve: serializeCommandDelta(outcome(nestedResolve, nestedResolved)),
    resolveBodyHex: bytesToHex(encode(nestedResolved)),
    valueHex: bytesToHex(nestedValue),
  },
});
const outputCfg = configuration({ nodes: 1 }),
  outputRequest = repoint(nestedRequest, "configuration", ref(outputCfg.id));
negative(
  "input_valid_output_nodes_overflow",
  outputRequest,
  sourceDelivery(outputRequest, nestedSource, nestedDefs),
  "resource-limit",
  {
    cfg: outputCfg,
    preflight: "input-valid",
    source: nestedSource,
    definitions: nestedDefs,
    fixtureSourceId: "nested_local",
  },
);
const nestedBasis = new Map(nestedBody.v).get("basis")!;
const dependency = bedDef,
  remaining = nestedDefs.filter((d) => d.id !== dependency.id),
  removedBasis = update(
    update(nestedBasis, "definitions", array(remaining.map((d) => bstr(appearance(d))))),
    "definitionDigest",
    tstr(digest(remaining.map((d) => d.id))),
  );
resolveEvidence(
  "missing_embedded_dependency",
  update(nestedBody, "basis", removedBasis),
  "definition-closure",
);
const badSigned = signClaims(
  {
    ...hyper.claims,
    pointers: hyper.claims.pointers.map((p) =>
      p.role === "rhizomatic.hyperschema.alg"
        ? { ...p, target: { kind: "primitive", value: 2 } }
        : p,
    ),
  },
  seeds.definition,
);
const badDefinitionRequest = request(s, config, 1000, 1000, badSigned, schema);
negative(
  "bad_definition_version",
  badDefinitionRequest,
  sourceDelivery(badDefinitionRequest, s, [badSigned, schema]),
  "invalid-definition",
  { definitions: [badSigned, schema] },
);
const duplicate = signClaims({ ...hyper.claims, timestamp: 1 }, seeds.definition),
  ambiguityRequest = request(
    s,
    config,
    1000,
    1000,
    hyper,
    schema,
    termHash(term),
    schemaHash(reading),
    [duplicate],
  );
negative(
  "ambiguous_definition",
  ambiguityRequest,
  sourceDelivery(ambiguityRequest, s, [hyper, schema, duplicate]),
  "ambiguous-definition",
  { definitions: [hyper, schema, duplicate] },
);
const pinAmbiguity = request(
  s,
  config,
  1000,
  1000,
  hyper,
  schema,
  authorityRoot,
  schemaHash(reading),
  [duplicate],
);
negative(
  "pin_before_ambiguity",
  pinAmbiguity,
  sourceDelivery(pinAmbiguity, s, [hyper, schema, duplicate]),
  "pin-mismatch",
  { definitions: [hyper, schema, duplicate] },
);
const noEdge = request(s, config, 1000, 1000, hyper, schema, termHash(term), schemaHash(reading), [
  bedDef,
]);
negative(
  "unreachable_definition",
  noEdge,
  sourceDelivery(noEdge, s, [hyper, schema, bedDef]),
  "definition-closure",
  { definitions: [hyper, schema, bedDef] },
);
const cyclic: Term = { kind: "fix", schema: { kind: "name", name: "Cycle" }, entity: root },
  cycleDef = definition("hyper", termCanonicalHex(cyclic), "Cycle"),
  cycleQ = request(s, config, 1000, 1000, cycleDef, schema, termHash(cyclic));
negative(
  "definition_cycle",
  cycleQ,
  sourceDelivery(cycleQ, s, [cycleDef, schema]),
  "definition-cycle",
  { definitions: [cycleDef, schema] },
);
const holeQ = request(
  s,
  config,
  1000,
  1000,
  hyper,
  localDef,
  termHash(term),
  schemaHash(localReading),
);
negative(
  "unbound_reading_hole",
  holeQ,
  sourceDelivery(holeQ, s, [hyper, localDef]),
  "invalid-program",
  { definitions: [hyper, localDef] },
);

function positive(
  id: string,
  src: ReturnType<typeof source>,
  q: Delta,
  view: HView,
  program: {
    hyper: Delta;
    schema: Delta;
    hyperPin: string;
    schemaPin: string;
    definitions: Delta[];
    bindings: Uint8Array;
  },
  options: {
    at?: number;
    definitionAt?: number;
    receivedAt?: number;
    cutoff?: number;
    auth?: Delta;
    rows?: Delta[];
    value?: CborValue;
  } = {},
) {
  const at = options.at ?? 1000,
    definitionAt = options.definitionAt ?? 1000,
    receivedAt = options.receivedAt ?? 1000,
    auth = options.auth ?? authority;
  const gathered = gatherBody(src, q, view, at, definitionAt, options.cutoff, program),
    evidence = description(
      "evidence/1",
      [["result", blob(encode(gathered))]],
      seeds.caller,
      receivedAt,
    ),
    resolve = description(
      "request/1",
      [
        ["receiver", ent(keys.receiver!)],
        ["configuration", ref(config.id)],
        ["operation", ref(operations[1]!.id)],
        ["evidence", ref(evidence.id)],
      ],
      seeds.caller,
      receivedAt,
    );
  const value = encode(
    options.value ??
      map([
        ["height", float(42)],
        ["tag", array([tstr("shade")])],
        [
          "payload",
          map([
            ["mime", tstr("application/octet-stream")],
            ["value", bstr(hex("00ff01"))],
          ]),
        ],
      ]),
  );
  if (gathered.t !== "map") throw Error();
  const resolved = map([
    ["kind", tstr("resolve")],
    ...gathered.v.filter(([k]) => ["root", "basis", "transport", "hview"].includes(k)),
    ["value", bstr(value)],
    ["view", tstr(contentAddress(value))],
  ]);
  const signedOutcome = (request: Delta, body: CborValue) => {
    const d = outcome(request, body);
    return signClaims(
      { ...d.claims, timestamp: receivedAt, validFrom: receivedAt },
      seeds.receiver,
    );
  };
  positives.push({
    id,
    receivedAt,
    rows: (options.rows ?? [a, t, x]).map(serializeCommandDelta),
    source: {
      binding: binding.id,
      revision: src.revision,
      authority: auth.id,
      servingAt: receivedAt,
      ...(options.cutoff === undefined ? {} : { cutoff: options.cutoff }),
      requiredSupport: program.definitions.map((d) => d.id),
    },
    request: serializeCommandDelta(q),
    delivery: [q, src.capture, src.snapshot, auth, ...program.definitions].map(
      serializeCommandDelta,
    ),
    resolve: serializeCommandDelta(resolve),
    resolveDelivery: [resolve, evidence].map(serializeCommandDelta),
    capture: serializeCommandDelta(src.capture),
    snapshot: serializeCommandDelta(src.snapshot),
    expected: {
      gather: serializeCommandDelta(signedOutcome(q, gathered)),
      gatherBodyHex: bytesToHex(encode(gathered)),
      resolve: serializeCommandDelta(signedOutcome(resolve, resolved)),
      resolveBodyHex: bytesToHex(encode(resolved)),
      valueHex: bytesToHex(value),
    },
  } as (typeof positives)[number]);
}
const standardProgram = {
  hyper,
  schema,
  hyperPin: termHash(term),
  schemaPin: schemaHash(reading),
  definitions: defs,
  bindings: C_EMPTY,
};
const standardView: HView = {
  id: root,
  props: new Map([
    ["height", [{ delta: a, negated: false }]],
    ["tag", [{ delta: t, negated: false }]],
    ["payload", [{ delta: x, negated: false }]],
  ]),
};
const freshCarrier = description("snapshot/1", [["data", blob(s.payload)]], seeds.caller, 1100);
const oldCapture = signClaims({ ...s.capture.claims, validUntil: 1050 }, seeds.capturer),
  freshSource = { ...s, snapshot: freshCarrier, capture: oldCapture },
  freshRequest = repoint(request(freshSource), "serving-at", p(1100));
positive("fresh_carrier_old_capture", freshSource, freshRequest, standardView, standardProgram, {
  receivedAt: 1100,
});
const observedAgain = source([a, t, x], 1100),
  observedRequest = repoint(request(observedAgain), "serving-at", p(1100));
positive(
  "new_observation_same_revision",
  observedAgain,
  observedRequest,
  standardView,
  standardProgram,
  { receivedAt: 1100 },
);
const laterHyper = signClaims(
    { ...hyper.claims, timestamp: 300, validFrom: 300 },
    seeds.definition,
  ),
  laterSchema = signClaims({ ...schema.claims, timestamp: 300, validFrom: 300 }, seeds.definition),
  laterDefs = [laterHyper, laterSchema].sort((a, b) => (a.id < b.id ? -1 : 1)),
  historicalSource = source([a, t, x], 1000, authority, 100);
for (const definitionAt of [900, 1000]) {
  const q = request(
    historicalSource,
    config,
    100,
    definitionAt,
    laterHyper,
    laterSchema,
    termHash(term),
    schemaHash(reading),
    [],
    root,
    100,
  );
  positive(
    "three_times_definition_" + definitionAt,
    historicalSource,
    q,
    standardView,
    { ...standardProgram, hyper: laterHyper, schema: laterSchema, definitions: laterDefs },
    { at: 100, definitionAt, cutoff: 100 },
  );
}
const earlyDefinition = request(
  historicalSource,
  config,
  100,
  100,
  laterHyper,
  laterSchema,
  termHash(term),
  schemaHash(reading),
  [],
  root,
  100,
);
negative(
  "three_times_definition_not_yet_valid",
  earlyDefinition,
  sourceDelivery(earlyDefinition, historicalSource, laterDefs),
  "invalid-definition",
  { source: historicalSource, definitions: laterDefs },
);
const badServing = repoint(good, "serving-at", p(1001));
negative("serving_at_mismatch", badServing, sourceDelivery(badServing), "invalid-arguments");
const authorityExpired = repoint(good, "serving-at", p(2000));
negative(
  "authority_expired",
  authorityExpired,
  sourceDelivery(authorityExpired),
  "invalid-source",
  { receivedAt: 2000 },
);
const invalidCapture = serializeCommandDelta(s.capture);
const invalidCaptureClaims = invalidCapture.claims;
if (typeof invalidCaptureClaims !== "object" || invalidCaptureClaims === null) throw Error();
negative(
  "invalid_capture_interval",
  good,
  sourceDelivery(good).map((d) =>
    d.id === s.capture.id
      ? { ...invalidCapture, claims: { ...invalidCaptureClaims, validUntil: 1000 } }
      : d,
  ),
  "invalid-appearance",
);
const changedAuthority = description(
  "authority/1",
  [
    ["source-binding", ref(binding.id)],
    [
      "spec",
      blob(
        encode(
          map([
            ["root", tstr(authorityRoot)],
            ["epoch", float(2)],
            ["context", bstr(encode(map([["allowed", bool(true)]])))],
          ]),
        ),
      ),
    ],
  ],
  seeds.capturer,
  0,
);
const changedSource = source([a, t, x], 1000, changedAuthority),
  changedRequest = request(changedSource);
positive(
  "same_rows_changed_authority",
  changedSource,
  changedRequest,
  standardView,
  standardProgram,
  { auth: changedAuthority },
);
negative("old_authority_reuse", good, sourceDelivery(good), "source-changed", {
  preflight: "input-valid",
  actions: ["change-authority-before"],
});
// Delivery permutation changes request identity, never program/source basis or execution meaning.
const permuted = signClaims(
  { ...good.claims, pointers: [...good.claims.pointers].reverse() },
  seeds.caller,
);
positive("permuted_delivery", s, permuted, standardView, standardProgram);
const permutedFixture = positives[positives.length - 1]!;
permutedFixture.delivery.reverse();
// Private raw-only inventory is committed but never copied into public Basis.
const sentinel = contentAddress(encode(tstr("E_SENTINEL"))),
  qPeer = keys.receiver!,
  raw0 = decode(s.payload);
if (raw0.t !== "map") throw Error();
const provenanceComponents = [
  ...s.components,
  map([
    ["peer", tstr(qPeer)],
    ["revision", tstr(digest([a.id, sentinel]))],
    ["capturedAt", float(1001)],
    ["rawIds", array([a.id, sentinel].sort().map(tstr))],
    ["operandIds", array([])],
  ]),
].sort((a, b) =>
  String(new Map((a as Extract<CborValue, { t: "map" }>).v).get("peer")!.v).localeCompare(
    String(new Map((b as Extract<CborValue, { t: "map" }>).v).get("peer")!.v),
  ),
);
const provenanceExclusions = array([
  map([
    ["id", tstr(sentinel)],
    ["peers", array([tstr(qPeer)])],
    ["reason", tstr("not-permitted")],
  ]),
]);
const provenanceRevision = contentAddress(
  encode(
    map([
      ["binding", tstr(binding.id)],
      ["authority", tstr(authority.id)],
      ["selection", tstr(contentAddress(encode(selection)))],
      [
        "components",
        array(
          provenanceComponents.map((c) =>
            c.t === "map" ? map(c.v.filter(([k]) => k !== "capturedAt")) : c,
          ),
        ),
      ],
      ["membership", tstr(s.membership)],
      ["appearanceDigest", tstr(s.appearanceDigest)],
      ["exclusions", provenanceExclusions],
    ]),
  ),
);
const provenanceRaw = map(
  raw0.v.map(([k, v]) => [
    k,
    k === "components"
      ? array(provenanceComponents)
      : k === "revision"
        ? tstr(provenanceRevision)
        : k === "exclusions"
          ? provenanceExclusions
          : v,
  ]),
);
if (provenanceRaw.t !== "map") throw Error();
const provenancePayload = encode(provenanceRaw),
  provenanceBasis = encode(
    map([
      ...provenanceRaw.v.filter(([k]) => k !== "format" && k !== "appearances"),
      ["format", tstr("rhizomatic.source-basis/1")],
      ["snapshot", tstr(contentAddress(provenancePayload))],
    ]),
  );
const provenanceSource = {
  ...s,
  payload: provenancePayload,
  revision: provenanceRevision,
  components: provenanceComponents,
  snapshot: description("snapshot/1", [["data", blob(provenancePayload)]], seeds.capturer),
  capture: description(
    "capture/1",
    [
      ["source-binding", ref(binding.id)],
      ["authority", ref(authority.id)],
      ["basis", blob(provenanceBasis)],
    ],
    seeds.capturer,
  ),
};
positive(
  "private_provenance",
  provenanceSource,
  request(provenanceSource),
  standardView,
  standardProgram,
);
function parseDebug(d: ReturnType<typeof serializeCommandDelta>): Delta {
  return {
    id: d.id,
    claims: parseClaims(d.claims),
    ...(d.sig === undefined ? {} : { sig: d.sig }),
  };
}
const resultRejections: Record<string, unknown>[] = [];
const baseGather = parseDebug(positives[0]!.expected.gather);
function rejectResult(
  id: string,
  d: Delta,
  kind: "gather" | "resolve",
  context: Record<string, unknown> = {},
) {
  resultRejections.push({ id, outcome: serializeCommandDelta(d), fixture: "plant", kind, context });
}
rejectResult("receiver_context", baseGather, "gather", { receiver: keys.peer });
rejectResult("configuration_context", baseGather, "gather", { configuration: authorityRoot });
rejectResult("request_context", baseGather, "gather", { request: authorityRoot });
rejectResult("source_revision_context", baseGather, "gather", { revision: authorityRoot });
for (const key of ["transport", "hview"]) {
  rejectResult(
    "gather_" + key,
    outcome(parseDebug(positives[0]!.request), update(baseBody, key, tstr(authorityRoot))),
    "gather",
  );
}
for (const [key, v] of [
  ["root", tstr("item:wrong")],
  ["at", float(999)],
  ["servingAt", float(999)],
  ["definitionAt", float(999)],
  ["bindings", bstr(encode(map([["want", float(3)]])))],
  ["schemaPin", tstr(authorityRoot)],
] as const) {
  const changed =
    key === "root"
      ? update(baseBody, key, v)
      : update(baseBody, "basis", update(baseBasis, key, v));
  rejectResult("basis_" + key, outcome(parseDebug(positives[0]!.request), changed), "gather");
}
const resolveBody = decode(hex(positives[0]!.expected.resolveBodyHex));
rejectResult(
  "view_digest",
  outcome(parseDebug(positives[0]!.resolve), update(resolveBody, "view", tstr(authorityRoot))),
  "resolve",
);
rejectResult(
  "bytes_leaf_changed",
  outcome(
    parseDebug(positives[0]!.resolve),
    update(
      resolveBody,
      "value",
      bstr(
        encode(
          map([
            [
              "payload",
              map([
                ["mime", tstr("application/octet-stream")],
                ["value", bstr(hex("00ff02"))],
              ]),
            ],
          ]),
        ),
      ),
    ),
  ),
  "resolve",
);
rejectResult(
  "status_body_mismatch",
  outcome(parseDebug(positives[0]!.request), baseBody, "refused"),
  "gather",
);
// Structurally valid supplied testimony differs from actual gather: no execution certificate.
const falseView: HView = {
  id: root,
  props: new Map([
    ["height", [{ delta: a, negated: true }]],
    ["tag", [{ delta: t, negated: false }]],
    ["payload", [{ delta: x, negated: false }]],
  ]),
};
positive("supplied_testimony", s, good, falseView, standardProgram, {
  value: map([
    ["height", float(42)],
    ["tag", array([tstr("shade")])],
    [
      "payload",
      map([
        ["mime", tstr("application/octet-stream")],
        ["value", bstr(hex("00ff01"))],
      ]),
    ],
  ]),
});
const testimony = positives[positives.length - 1]!;
// Invocation's gather oracle remains actual S0; supplied resolve evidence is intentionally false.
testimony.expected.gather = positives[0]!.expected.gather;
testimony.expected.gatherBodyHex = positives[0]!.expected.gatherBodyHex;
for (const [id, q, code] of [
  [
    "unknown_role",
    signClaims(
      {
        ...good.claims,
        pointers: [...good.claims.pointers, { role: prefix + "unknown", target: p(true) }],
      },
      seeds.caller,
    ),
    "invalid-arguments",
  ],
  [
    "repeated_root",
    signClaims(
      {
        ...good.claims,
        pointers: [...good.claims.pointers, { role: prefix + "root", target: ent(root) }],
      },
      seeds.caller,
    ),
    "invalid-arguments",
  ],
  [
    "repeated_receiver",
    signClaims(
      {
        ...good.claims,
        pointers: [
          ...good.claims.pointers,
          { role: prefix + "receiver", target: ent(keys.receiver!) },
        ],
      },
      seeds.caller,
    ),
    "invalid-request",
  ],
  [
    "contextual_capture_ref",
    repoint(good, "capture", { kind: "delta", deltaRef: { delta: s.capture.id, context: "bad" } }),
    "invalid-arguments",
  ],
  [
    "bindings_wrong_mime",
    repoint(good, "bindings", { kind: "bytes", mime: "application/octet-stream", value: C_EMPTY }),
    "invalid-arguments",
  ],
  [
    "unsupported_operation",
    repoint(good, "operation", ref(authorityRoot)),
    "unsupported-operation",
  ],
  [
    "configuration_before_unauthorized",
    repoint(
      signClaims({ ...good.claims, author: keys.peer! }, seeds.peer),
      "configuration",
      ref(authorityRoot),
      seeds.peer,
    ),
    "configuration-mismatch",
  ],
] as const)
  negative(id, q, sourceDelivery(q), code);
const extraResolve = parseDebug(positives[0]!.resolve),
  extraResolveDelivery = positives[0]!.resolveDelivery;
negative(
  "resolve_extra_definition",
  extraResolve,
  [...extraResolveDelivery, serializeCommandDelta(hyper)],
  "unexpected-support",
);
negative(
  "resolve_missing_evidence",
  extraResolve,
  [serializeCommandDelta(extraResolve)],
  "missing-support",
);
// Native-supported gather alias/reflection need no lowering or ambient permissions.
const aliasOne = signClaims(
  {
    author: keys.peer!,
    timestamp: 1,
    validFrom: 0,
    pointers: [
      { role: "rhizomatic.alias.fragment", target: p("stature") },
      { role: "rhizomatic.alias.slot", target: ent("alias:height") },
    ],
  },
  seeds.peer,
);
const aliasTwo = signClaims(
  {
    author: keys.peer!,
    timestamp: 2,
    validFrom: 0,
    pointers: [
      { role: "rhizomatic.alias.fragment", target: p("height") },
      { role: "rhizomatic.alias.slot", target: ent("alias:height") },
    ],
  },
  seeds.peer,
);
const aliasTerm: Term = {
  kind: "group",
  key: { kind: "byTargetContext" },
  of: {
    kind: "select",
    pred: {
      kind: "hasPointer",
      ppred: { targetEntity: { kind: "root" }, context: { kind: "aliased", name: "stature" } },
    },
    of: { kind: "input" },
  },
};
const aliasDef = definition("hyper", termCanonicalHex(aliasTerm), "AliasPlant"),
  aliasSource = source([a, t, x, aliasOne, aliasTwo]),
  aliasRequest = request(aliasSource, config, 1000, 1000, aliasDef, schema, termHash(aliasTerm));
const justHeight: HView = {
  id: root,
  props: new Map([["height", [{ delta: a, negated: false }]]]),
};
positive(
  "ordinary_alias",
  aliasSource,
  aliasRequest,
  justHeight,
  {
    ...standardProgram,
    hyper: aliasDef,
    hyperPin: termHash(aliasTerm),
    definitions: [aliasDef, schema].sort((a, b) => (a.id < b.id ? -1 : 1)),
  },
  { rows: [a, t, x, aliasOne, aliasTwo], value: map([["height", float(42)]]) },
);
const reflectiveTerm: Term = {
  kind: "group",
  key: { kind: "byTargetContext" },
  of: {
    kind: "select",
    pred: {
      kind: "inView",
      term: {
        kind: "select",
        pred: { kind: "hasPointer", ppred: { context: { kind: "exact", value: "height" } } },
        of: { kind: "input" },
      },
      field: "id",
      extract: { kind: "field", field: "id" },
    },
    of: { kind: "input" },
  },
};
const reflectiveHyper = definition("hyper", termCanonicalHex(reflectiveTerm), "ReflectionPlant"),
  reflectionRequest = request(
    s,
    config,
    1000,
    1000,
    reflectiveHyper,
    schema,
    termHash(reflectiveTerm),
  );
positive(
  "ordinary_reflection",
  s,
  reflectionRequest,
  justHeight,
  {
    ...standardProgram,
    hyper: reflectiveHyper,
    hyperPin: termHash(reflectiveTerm),
    definitions: [reflectiveHyper, schema].sort((a, b) => (a.id < b.id ? -1 : 1)),
  },
  { value: map([["height", float(42)]]) },
);
const trustTerm: Term = {
  ...aliasTerm,
  of: {
    kind: "select",
    pred: {
      kind: "hasPointer",
      ppred: {
        targetEntity: { kind: "root" },
        context: {
          kind: "aliased",
          name: "stature",
          trust: { kind: "actsFor", root: keys.peer!, policy: { kind: "exact", scope: "read" } },
        },
      },
    },
    of: { kind: "input" },
  },
};
const trustDef = definition("hyper", termCanonicalHex(trustTerm), "GovernedAlias"),
  trustQ = request(s, config, 1000, 1000, trustDef, schema, termHash(trustTerm));
negative(
  "alias_trust_principal",
  trustQ,
  sourceDelivery(trustQ, s, [trustDef, schema]),
  "invalid-definition",
  { definitions: [trustDef, schema] },
);

const pointerBound = good.claims.pointers.length;
const pointerCfg = configuration({ pointers: pointerBound - 1 }),
  pointerQ = repoint(good, "configuration", ref(pointerCfg.id));
negative("request_pointers_over", pointerQ, sourceDelivery(pointerQ), "resource-limit", {
  cfg: pointerCfg,
});
negative(
  "request_pointers_over_bad_signature",
  pointerQ,
  [
    { ...serializeCommandDelta(pointerQ), sig: "00".repeat(64) },
    ...sourceDelivery(pointerQ).slice(1).reverse(),
  ],
  "resource-limit",
  { cfg: pointerCfg },
);
const knownUnknown = [null, ...sourceDelivery(pointerQ)];
negative(
  "unknown_pointer_count_before_pointer_budget",
  pointerQ,
  knownUnknown,
  "invalid-appearance",
  { cfg: pointerCfg },
);
const exactCfg = configuration({ pointers: pointerBound }),
  exactQ = repoint(good, "configuration", ref(exactCfg.id));
// Exact-bound positive boot is supplied explicitly; output same semantic Basis.
positive("request_pointers_exact", s, exactQ, standardView, standardProgram);
const exactFixture = positives[positives.length - 1]!;
Object.assign(exactFixture, { boot: bootJson(exactCfg) });
const exactGather = parseDebug(exactFixture.expected.gather),
  exactResolved = parseDebug(exactFixture.expected.resolve);
exactFixture.expected.gather = serializeCommandDelta(
  repoint(exactGather, "configuration", ref(exactCfg.id), seeds.receiver),
);
const exactResolve = repoint(parseDebug(exactFixture.resolve), "configuration", ref(exactCfg.id));
exactFixture.resolve = serializeCommandDelta(exactResolve);
exactFixture.resolveDelivery[0] = serializeCommandDelta(exactResolve);
exactFixture.expected.resolve = serializeCommandDelta(
  repoint(
    repoint(exactResolved, "configuration", ref(exactCfg.id), seeds.receiver),
    "request",
    ref(exactResolve.id),
    seeds.receiver,
  ),
);
for (const [label, base, seed] of [
  ["carrier", s.snapshot, seeds.capturer],
  ["definition", hyper, seeds.definition],
] as const) {
  const extra = Array.from(
    { length: pointerBound + 1 - base.claims.pointers.length },
    () => base.claims.pointers[0]!,
  );
  const over = signClaims({ ...base.claims, pointers: [...base.claims.pointers, ...extra] }, seed);
  const q =
    label === "carrier"
      ? repoint(exactQ, "snapshot", ref(over.id))
      : repoint(exactQ, "hyperschema", ref(over.id));
  const delivered = sourceDelivery(q).map((d) =>
    d.id === base.id ? serializeCommandDelta(over) : d,
  );
  negative(label + "_pointers_over", q, delivered, "resource-limit", { cfg: exactCfg });
  negative(
    label + "_pointers_over_bad_signature",
    q,
    delivered.map((d) => (d.id === over.id ? { ...d, sig: "00".repeat(64) } : d)).reverse(),
    "resource-limit",
    { cfg: exactCfg },
  );
}
const repeats = [
  ...sourceDelivery(exactQ),
  serializeCommandDelta(hyper),
  serializeCommandDelta(hyper),
];
const repeatsCfg = configuration({ deliveryAppearances: repeats.length - 1 }),
  repeatQ = repoint(exactQ, "configuration", ref(repeatsCfg.id));
negative(
  "repeated_delivery_count_before_dedup",
  repeatQ,
  repeats.map((d) => (d.id === exactQ.id ? serializeCommandDelta(repeatQ) : d)),
  "resource-limit",
  { cfg: repeatsCfg },
);
// Independent finite-input/output boundaries. Config references are fixed-width IDs, so
// changing the selected cap does not change canonical request byte size.
const deliveryCost = (ds: Delta[]) =>
  ds.reduce((n, d) => n + canonicalBytes(d.claims).length + (d.sig?.length ?? 0) / 2, 0);
function positiveWithConfig(id: string, cfg: Delta) {
  positive(id, s, repoint(good, "configuration", ref(cfg.id)), standardView, standardProgram);
  const f = positives[positives.length - 1]!;
  Object.assign(f, { boot: bootJson(cfg) });
  const q = parseDebug(f.request),
    rq = repoint(parseDebug(f.resolve), "configuration", ref(cfg.id));
  f.resolve = serializeCommandDelta(rq);
  f.resolveDelivery[0] = serializeCommandDelta(rq);
  f.expected.gather = serializeCommandDelta(
    repoint(parseDebug(f.expected.gather), "configuration", ref(cfg.id), seeds.receiver),
  );
  f.expected.resolve = serializeCommandDelta(
    repoint(
      repoint(parseDebug(f.expected.resolve), "configuration", ref(cfg.id), seeds.receiver),
      "request",
      ref(rq.id),
      seeds.receiver,
    ),
  );
  if (!q.id) throw Error("request binding");
}
const canonicalDelivery = sourceDelivery(good).map(parseDebug),
  deliveryBytes = deliveryCost(canonicalDelivery);
positiveWithConfig("delivery_bytes_exact", configuration({ deliveryBytes }));
for (const permutation of [false, true]) {
  const cfg = configuration({ deliveryBytes: deliveryBytes - 1 }),
    q = repoint(good, "configuration", ref(cfg.id));
  const ds = sourceDelivery(q);
  if (permutation) ds.reverse();
  negative("delivery_bytes_over" + (permutation ? "_reverse" : ""), q, ds, "resource-limit", {
    cfg,
  });
}
// Allocation guard schedules: a well-formed oversized carrier plus a malformed sibling
// must still report malformed appearance, independently of delivery permutation.
const allocationCfg = configuration({ deliveryBytes: deliveryBytes - 1 }),
  allocationQ = repoint(good, "configuration", ref(allocationCfg.id));
const allocationDelivery = sourceDelivery(allocationQ);
for (const [label, change] of [
  [
    "base64_alphabet",
    (d: ReturnType<typeof serializeCommandDelta>) => {
      const x = d as { claims: { pointers: { target: unknown }[] } };
      x.claims.pointers[0]!.target = { mime: "application/octet-stream", value: "!!!" };
    },
  ],
  [
    "base64_trailing_bits",
    (d: ReturnType<typeof serializeCommandDelta>) => {
      const x = d as { claims: { pointers: { target: unknown }[] } };
      x.claims.pointers[0]!.target = { mime: "application/octet-stream", value: "AB" };
    },
  ],
  [
    "base64_length",
    (d: ReturnType<typeof serializeCommandDelta>) => {
      const x = d as { claims: { pointers: { target: unknown }[] } };
      x.claims.pointers[0]!.target = { mime: "application/octet-stream", value: "A" };
    },
  ],
  [
    "number_shape",
    (d: ReturnType<typeof serializeCommandDelta>) => {
      const x = d as { claims: { timestamp: unknown } };
      x.claims.timestamp = "1000";
    },
  ],
  [
    "signature_odd",
    (d: ReturnType<typeof serializeCommandDelta>) => {
      (d as { sig: string }).sig = "0";
    },
  ],
  [
    "signature_nonhex",
    (d: ReturnType<typeof serializeCommandDelta>) => {
      (d as { sig: string }).sig = "gg";
    },
  ],
] as const) {
  const bad = structuredClone(serializeCommandDelta(hyper));
  change(bad);
  for (const reverse of [false, true]) {
    const ds = [...allocationDelivery, bad];
    if (reverse) ds.reverse();
    negative(
      "delivery_scan_" + label + (reverse ? "_reverse" : ""),
      allocationQ,
      ds,
      "invalid-appearance",
      { cfg: allocationCfg },
    );
  }
}
const oversizedCarrier = signClaims(
  {
    ...s.snapshot.claims,
    pointers: s.snapshot.claims.pointers.map((p) =>
      p.target.kind === "bytes"
        ? {
            ...p,
            target: { kind: "bytes" as const, mime: p.target.mime, value: new Uint8Array(16384) },
          }
        : p,
    ),
  },
  seeds.capturer,
);
const oversizedQ = repoint(allocationQ, "snapshot", ref(oversizedCarrier.id));
const oversizedDelivery = sourceDelivery(oversizedQ).map((d) =>
  d.id === s.snapshot.id ? serializeCommandDelta(oversizedCarrier) : d,
);
negative("delivery_scan_oversized_carrier", oversizedQ, oversizedDelivery, "resource-limit", {
  cfg: allocationCfg,
});
for (const reverse of [false, true]) {
  const bad = structuredClone(serializeCommandDelta(hyper)) as { sig: string };
  bad.sig = "gg";
  const ds = [...oversizedDelivery, bad];
  if (reverse) ds.reverse();
  negative(
    "delivery_scan_oversized_malformed_sibling" + (reverse ? "_reverse" : ""),
    oversizedQ,
    ds,
    "invalid-appearance",
    { cfg: allocationCfg },
  );
}
const exactArtifact = Math.max(
  s.payload.length,
  encode(baseBody).length,
  hex(positives[0]!.expected.resolveBodyHex).length,
);
positiveWithConfig("artifact_bytes_exact", configuration({ artifactBytes: exactArtifact }));
for (const [label, overrides] of Object.entries({
  snapshot_bytes: { artifactBytes: s.payload.length - 1 },
  snapshot_appearances: { appearances: 2 },
  snapshot_inventory: { inventoryIds: 2 },
  definition_count: { definitions: 1 },
  definition_syntax_nodes: { syntaxNodes: 1 },
  definition_syntax_depth: { syntaxDepth: 1 },
})) {
  const cfg = configuration(overrides),
    q = repoint(good, "configuration", ref(cfg.id));
  negative(label + "_over", q, sourceDelivery(q), "resource-limit", { cfg });
  negative(label + "_over_reverse", q, sourceDelivery(q).reverse(), "resource-limit", { cfg });
}
resolveEvidence(
  "resolve_outer_bytes_over",
  baseBody,
  "resource-limit",
  configuration({ artifactBytes: encode(baseBody).length - 1 }),
);
resolveEvidence(
  "resolve_definition_syntax_nodes",
  baseBody,
  "resource-limit",
  configuration({ syntaxNodes: 1 }),
);
resolveEvidence(
  "resolve_definition_syntax_depth",
  baseBody,
  "resource-limit",
  configuration({ syntaxDepth: 1 }),
);
resolveEvidence(
  "resolve_envelope_depth_over",
  nestedBody,
  "resource-limit",
  configuration({ depth: 1 }),
);
const aggregateCfg = configuration({ artifactBytes: encode(baseBody).length - 1 }),
  aggregateQ = repoint(good, "configuration", ref(aggregateCfg.id));
negative("output_aggregate_bytes_over", aggregateQ, sourceDelivery(aggregateQ), "resource-limit", {
  cfg: aggregateCfg,
  preflight: "input-valid",
});
// MR-21 stage 4: Basis field grammar refuses before any stage-7 definition category.
const basisOf = (body: CborValue) =>
  body.t === "map"
    ? new Map(body.v).get("basis")!
    : (() => {
        throw Error();
      })();
const emptyClosure = update(basisOf(baseBody), "definitions", array([]));
resolveEvidence(
  "resolve_basis_pin_grammar_before_closure",
  update(baseBody, "basis", update(emptyClosure, "hyperschemaPin", tstr("bad"))),
  "invalid-evidence",
);
resolveEvidence(
  "resolve_basis_bindings_grammar_before_closure",
  update(baseBody, "basis", update(emptyClosure, "bindings", bstr(Uint8Array.of(0xff)))),
  "invalid-evidence",
);
// MR-21 stage 8: a produced definition appearance over artifactBytes is a known refusal.
// The reading's claims fit the bound exactly; its full signed appearance does not.
const wideReading: Schema = {
  ...reading,
  props: new Map(Array.from({ length: 401 }, (_, i) => [`p${i}`, reading.props.get("tag")!])),
};
const wideSchema = definition("reading", schemaCanonicalHex(wideReading), "Plant");
const wideCfg = configuration({ artifactBytes: canonicalBytes(wideSchema.claims).length });
const wideDefs = [hyper, wideSchema].sort((a, b) => (a.id < b.id ? -1 : 1));
const wideQ = request(
  s,
  wideCfg,
  1000,
  1000,
  hyper,
  wideSchema,
  termHash(term),
  schemaHash(wideReading),
);
if (
  appearance(wideSchema).length <= canonicalBytes(wideSchema.claims).length ||
  Math.max(s.payload.length, appearance(hyper).length) >= canonicalBytes(wideSchema.claims).length
)
  throw Error("wide reading fixture does not isolate the produced appearance bound");
negative(
  "definition_appearance_bytes_over",
  wideQ,
  sourceDelivery(wideQ, s, wideDefs),
  "resource-limit",
  {
    cfg: wideCfg,
    definitions: wideDefs,
    preflight: "input-valid",
  },
);
const manyPointers = signClaims(
  { ...a.claims, pointers: Array.from({ length: 257 }, () => a.claims.pointers[0]!) },
  seeds.peer,
);
for (const badSignature of [false, true]) {
  const row = badSignature ? { ...manyPointers, sig: "00".repeat(64) } : manyPointers,
    src = source([row]),
    q = request(src);
  negative(
    "snapshot_pointers_over" + (badSignature ? "_bad_signature" : ""),
    q,
    sourceDelivery(q, src),
    "resource-limit",
    { source: src },
  );
}
// The supplied appearance-count bound wins before inspecting the corrupted embedded row.
const badRow = { ...a, sig: "00".repeat(64) },
  badRowsSource = source([badRow, t, x]),
  badRowsCfg = configuration({ appearances: 2 }),
  badRowsQ = request(badRowsSource, badRowsCfg);
negative(
  "snapshot_count_before_bad_row",
  badRowsQ,
  sourceDelivery(badRowsQ, badRowsSource),
  "resource-limit",
  { cfg: badRowsCfg, source: badRowsSource },
);
// Closed shapes and source metadata defects, separately signed outer deliveries.
const badKind = repoint(good, "kind", p("request/2"));
negative("unknown_request_kind", badKind, sourceDelivery(badKind), "invalid-request");
const malformedId = repoint(good, "snapshot", {
  kind: "delta",
  deltaRef: { delta: "not-a-content-id" },
});
negative("malformed_argument_id", malformedId, sourceDelivery(malformedId), "invalid-arguments");
const doubledDefinition = signClaims(
  {
    ...nestedRequest.claims,
    pointers: [
      ...nestedRequest.claims.pointers,
      nestedRequest.claims.pointers.find((p) => p.role === prefix + "definition")!,
    ],
  },
  seeds.caller,
);
negative(
  "duplicate_set_definition",
  doubledDefinition,
  sourceDelivery(doubledDefinition, nestedSource, nestedDefs),
  "invalid-arguments",
  { source: nestedSource, definitions: nestedDefs, fixtureSourceId: "nested_local" },
);
for (const [name, mutated] of [
  ["component_peer_set", update(rawSnapshot, "components", array([]))],
  [
    "excluded_operand_overlap",
    update(
      rawSnapshot,
      "exclusions",
      array([
        map([
          ["id", tstr(a.id)],
          ["peers", array([tstr(keys.peer!)])],
          ["reason", tstr("not-permitted")],
        ]),
      ]),
    ),
  ],
  [
    "operand_peer_set",
    update(
      rawSnapshot,
      "operands",
      array(
        (rawSnapshot.t === "map" && rawFields.get("operands")!.t === "array"
          ? (rawFields.get("operands")! as { t: "array"; v: readonly CborValue[] }).v
          : []
        ).map((o) => update(o, "peers", array([]))),
      ),
    ),
  ],
] as const) {
  const carrier = description("snapshot/1", [["data", blob(encode(mutated))]], seeds.capturer),
    q = repoint(good, "snapshot", ref(carrier.id));
  negative(
    "source_bad_" + name,
    q,
    sourceDelivery(q).map((d) => (d.id === s.snapshot.id ? serializeCommandDelta(carrier) : d)),
    "invalid-source",
  );
}
const privateFixture = positives.find((f) => f.id === "private_provenance")!,
  componentsCfg = configuration({ components: 1 }),
  componentsQ = repoint(parseDebug(privateFixture.request), "configuration", ref(componentsCfg.id));
negative(
  "source_components_over",
  componentsQ,
  privateFixture.delivery.map((d) =>
    d.id === privateFixture.request.id ? serializeCommandDelta(componentsQ) : d,
  ),
  "resource-limit",
  { cfg: componentsCfg, fixtureSourceId: "private_provenance" },
);
const signatureDefs = defs.map((d) => (d.id === schema.id ? { ...d, sig: "00".repeat(64) } : d));
resolveEvidence(
  "embedded_definition_bad_signature",
  update(
    baseBody,
    "basis",
    update(baseBasis, "definitions", array(signatureDefs.map((d) => bstr(appearance(d))))),
  ),
  "invalid-definition",
);
// Exponential DAG oracle: every level doubles the child occurrence count, independent of object sharing.
const branchRow = signClaims(
    {
      author: keys.peer!,
      timestamp: 10,
      validFrom: 0,
      pointers: [
        { role: "left", target: ent(root) },
        { role: "right", target: ent(root) },
        { role: "value", target: p(7) },
      ],
    },
    seeds.peer,
  ),
  branchSource = source([branchRow]);
const branchGroup: Term = {
  kind: "group",
  key: { kind: "const", prop: "branch" },
  of: { kind: "input" },
};
const branchReading: Schema = {
  name: "Branch",
  alg: 1,
  props: new Map(),
  default: { kind: "pick", order: { kind: "lexById" } },
};
const branchSchema = definition("reading", schemaCanonicalHex(branchReading), "Branch");
const branchDefinitions: Delta[] = [],
  branchTerms: Term[] = [];
for (let level = 0; level <= 16; level++) {
  const body: Term =
    level === 0
      ? branchGroup
      : {
          kind: "expand",
          role: { kind: "inSet", values: ["left", "right"] },
          schema: { kind: "name", name: "Branch" + (level - 1) },
          reading: { kind: "name", name: "Branch" },
          of: branchGroup,
        };
  branchTerms.push(body);
  branchDefinitions.push(definition("hyper", termCanonicalHex(body), "Branch" + level));
}
const branchView = (level: number): HView => {
  const child = level === 0 ? undefined : branchView(level - 1);
  return {
    id: root,
    props: new Map([
      [
        "branch",
        [
          {
            delta: branchRow,
            negated: false,
            ...(child === undefined
              ? {}
              : {
                  expanded: new Map([
                    [0, child],
                    [1, child],
                  ]),
                  readings: new Map([
                    [0, branchReading],
                    [1, branchReading],
                  ]),
                }),
          },
        ],
      ],
    ]),
  };
};
function branchCase(
  id: string,
  level: number,
  caps: Record<string, number>,
  refused = false,
  prune = false,
  wrappers = 0,
) {
  let body = branchTerms[level]!,
    top = branchDefinitions[level]!;
  if (prune) body = { kind: "prune", keep: { kind: "exact", value: "absent" }, of: body };
  for (let n = 0; n < wrappers; n++) body = { kind: "prune", keep: "all", of: body };
  if (prune || wrappers) top = definition("hyper", termCanonicalHex(body), "BranchWrapped");
  const ds = [branchSchema, ...branchDefinitions.slice(0, level), top].sort((a, b) =>
      a.id < b.id ? -1 : 1,
    ),
    cfg = configuration(caps);
  const q = request(
    branchSource,
    cfg,
    1000,
    1000,
    top,
    branchSchema,
    termHash(body),
    schemaHash(branchReading),
    ds.filter((d) => d.id !== top.id && d.id !== branchSchema.id),
  );
  if (refused) {
    negative(id, q, sourceDelivery(q, branchSource, ds), "resource-limit", {
      cfg,
      source: branchSource,
      fixtureSourceId: "bounded_dag_exact",
      definitions: ds,
      preflight: "input-valid",
    });
    return;
  }
  positive(
    id,
    branchSource,
    q,
    prune ? { id: root, props: new Map() } : branchView(level),
    {
      hyper: top,
      schema: branchSchema,
      hyperPin: termHash(body),
      schemaPin: schemaHash(branchReading),
      definitions: ds,
      bindings: C_EMPTY,
    },
    { rows: [branchRow], value: prune ? map([]) : map([["branch", float(7)]]) },
  );
  const f = positives[positives.length - 1]!;
  Object.assign(f, { boot: bootJson(cfg) });
  const rq = repoint(parseDebug(f.resolve), "configuration", ref(cfg.id));
  f.resolve = serializeCommandDelta(rq);
  f.resolveDelivery[0] = serializeCommandDelta(rq);
  f.expected.gather = serializeCommandDelta(
    repoint(parseDebug(f.expected.gather), "configuration", ref(cfg.id), seeds.receiver),
  );
  f.expected.resolve = serializeCommandDelta(
    repoint(
      repoint(parseDebug(f.expected.resolve), "configuration", ref(cfg.id), seeds.receiver),
      "request",
      ref(rq.id),
      seeds.receiver,
    ),
  );
}
branchCase("bounded_dag_exact", 3, { nodes: 15, entries: 15, buckets: 1, depth: 4 });
branchCase("bounded_dag_node_over", 3, { nodes: 14 }, true);
branchCase("bounded_dag_entry_over", 3, { entries: 14 }, true);
branchCase("bounded_dag_depth_over", 3, { depth: 3 }, true);
branchCase("bounded_dag_exponential_early_stop", 16, { nodes: 31 }, true);
branchCase("bounded_child_then_prune_over", 3, { nodes: 14 }, true, true);
branchCase("bounded_child_then_prune_exact", 3, { nodes: 15 }, false, true);
branchCase(
  "bounded_wrappers_non_cumulative",
  3,
  { nodes: 15, entries: 15, depth: 4 },
  false,
  false,
  20,
);
// Near-full parent accepts a globally bounded child intermediate100 -> pruned1.
const wideRow = signClaims(
    {
      author: keys.peer!,
      timestamp: 10,
      validFrom: 0,
      pointers: [
        ...Array.from({ length: 99 }, (_, n) => ({ role: "link" + n, target: ent(root) })),
        { role: "value", target: p(7) },
      ],
    },
    seeds.peer,
  ),
  wideSource = source([wideRow]);
const emptyTerm: Term = {
    kind: "group",
    key: { kind: "const", prop: "branch" },
    of: { kind: "select", pred: { kind: "false" }, of: { kind: "input" } },
  },
  emptyDef = definition("hyper", termCanonicalHex(emptyTerm), "EmptyBranch");
const wideTerm: Term = {
  kind: "expand",
  role: { kind: "prefix", value: "link" },
  schema: { kind: "name", name: "EmptyBranch" },
  reading: { kind: "name", name: "Branch" },
  of: branchGroup,
};
const prunedWideTerm: Term = {
    kind: "prune",
    keep: { kind: "exact", value: "absent" },
    of: wideTerm,
  },
  prunedWide = definition("hyper", termCanonicalHex(prunedWideTerm), "WidePruned");
const twoTerm: Term = {
    kind: "expand",
    of: branchGroup,
    schema: { kind: "name", name: "EmptyBranch" },
    reading: { kind: "name", name: "Branch" },
    role: { kind: "exact", value: "link0" },
  },
  twoDef = definition("hyper", termCanonicalHex(twoTerm), "TwoNodes");
for (const overflow of [false, true]) {
  const child = overflow ? twoDef : prunedWide,
    body: Term = {
      kind: "expand",
      role: { kind: "exact", value: "link0" },
      schema: { kind: "name", name: overflow ? "TwoNodes" : "WidePruned" },
      reading: { kind: "name", name: "Branch" },
      of: wideTerm,
    };
  const top = definition("hyper", termCanonicalHex(body), "PendingParent"),
    ds = [top, child, emptyDef, branchSchema].sort((a, b) => (a.id < b.id ? -1 : 1)),
    cfg = configuration({ nodes: 100, buckets: 1, depth: 3 }),
    q = request(
      wideSource,
      cfg,
      1000,
      1000,
      top,
      branchSchema,
      termHash(body),
      schemaHash(branchReading),
      ds.filter((d) => d.id !== top.id && d.id !== branchSchema.id),
    );
  if (overflow) {
    negative(
      "bounded_parent_attachment_over",
      q,
      sourceDelivery(q, wideSource, ds),
      "resource-limit",
      { cfg, source: wideSource, definitions: ds, preflight: "input-valid", nativeRows: [wideRow] },
    );
    continue;
  }
  const view: HView = {
    id: root,
    props: new Map([
      [
        "branch",
        [
          {
            delta: wideRow,
            negated: false,
            expanded: new Map(
              Array.from({ length: 99 }, (_, n) => [n, { id: root, props: new Map() }]),
            ),
            readings: new Map(Array.from({ length: 99 }, (_, n) => [n, branchReading])),
          },
        ],
      ],
    ]),
  };
  positive(
    "bounded_pending_child_prunes_to_one",
    wideSource,
    q,
    view,
    {
      hyper: top,
      schema: branchSchema,
      hyperPin: termHash(body),
      schemaPin: schemaHash(branchReading),
      definitions: ds,
      bindings: C_EMPTY,
    },
    { rows: [wideRow], value: map([["branch", float(7)]]) },
  );
  const f = positives[positives.length - 1]!;
  Object.assign(f, { boot: bootJson(cfg) });
  const rq = repoint(parseDebug(f.resolve), "configuration", ref(cfg.id));
  f.resolve = serializeCommandDelta(rq);
  f.resolveDelivery[0] = serializeCommandDelta(rq);
  f.expected.gather = serializeCommandDelta(
    repoint(parseDebug(f.expected.gather), "configuration", ref(cfg.id), seeds.receiver),
  );
  f.expected.resolve = serializeCommandDelta(
    repoint(
      repoint(parseDebug(f.expected.resolve), "configuration", ref(cfg.id), seeds.receiver),
      "request",
      ref(rq.id),
      seeds.receiver,
    ),
  );
}
// Separate native definition-shape defects, with valid outer signatures and selected new IDs.
for (const [id, changed] of [
  [
    "bad_definition_kind",
    hyper.claims.pointers.map((p) => ({
      ...p,
      role: p.role.replace("rhizomatic.hyperschema.", "rhizomatic.schema."),
    })),
  ],
  [
    "bad_definition_blob",
    hyper.claims.pointers.map((p) =>
      p.role === "rhizomatic.hyperschema.term"
        ? {
            ...p,
            target:
              p.target.kind === "primitive"
                ? { kind: "primitive" as const, value: "zz" }
                : p.target,
          }
        : p,
    ),
  ],
] as const) {
  const d = signClaims({ ...hyper.claims, pointers: [...changed] }, seeds.definition),
    q = request(s, config, 1000, 1000, d, schema);
  negative(id, q, sourceDelivery(q, s, [d, schema]), "invalid-definition", {
    definitions: [d, schema],
  });
}
const changedIntervalAuthority = signClaims(
    { ...authority.claims, validUntil: 3000 },
    seeds.capturer,
  ),
  changedIntervalSource = source([a, t, x], 1000, changedIntervalAuthority);
positive(
  "same_rows_changed_authority_interval",
  changedIntervalSource,
  request(changedIntervalSource),
  standardView,
  standardProgram,
  { auth: changedIntervalAuthority },
);
// Required signed binding validity is checked at stage6 after arguments, never by scanning unrelated boot bindings.
const expiredBinding = signClaims({ ...binding.claims, validUntil: 1050 }, seeds.receiver),
  boundAuthority = repoint(authority, "source-binding", ref(expiredBinding.id), seeds.capturer),
  expiredSource = source([a, t, x], 1000, boundAuthority, undefined, expiredBinding),
  expiredCfg = configuration({}, expiredBinding),
  expiredQ = repoint(request(expiredSource, expiredCfg), "serving-at", p(1100));
for (const badArgs of [false, true]) {
  const q = badArgs
    ? repoint(expiredQ, "bindings", { kind: "bytes", mime: "text/plain", value: C_EMPTY })
    : expiredQ;
  negative(
    badArgs ? "binding_expired_bad_args_priority" : "binding_expired_required",
    q,
    [q, expiredSource.capture, expiredSource.snapshot, boundAuthority, ...defs].map(
      serializeCommandDelta,
    ),
    badArgs ? "invalid-arguments" : "configuration-mismatch",
    { cfg: expiredCfg, receivedAt: 1100, source: expiredSource },
  );
  const f = extraNegatives[extraNegatives.length - 1]! as unknown as {
    boot: ReturnType<typeof bootJson>;
    source: { binding: string };
  };
  f.boot.bindings = [serializeCommandDelta(expiredBinding)];
  f.source.binding = expiredBinding.id;
}
// Exactly three original signed acts in embedded support: both top acts and one referenced gather.
const closureTopTerm: Term = {
    kind: "fix",
    schema: { kind: "name", name: "Plant" },
    entity: root,
    bindings: new Map(),
  },
  closureTop = definition("hyper", termCanonicalHex(closureTopTerm), "EmbeddedClosure"),
  closureDefs = [closureTop, schema, hyper].sort((a, b) => (a.id < b.id ? -1 : 1)),
  closureRequest = request(
    s,
    config,
    1000,
    1000,
    closureTop,
    schema,
    termHash(closureTopTerm),
    schemaHash(reading),
    [hyper],
  );
positive("embedded_three_originals", s, closureRequest, standardView, {
  hyper: closureTop,
  schema,
  hyperPin: termHash(closureTopTerm),
  schemaPin: schemaHash(reading),
  definitions: closureDefs,
  bindings: C_EMPTY,
});
// Same canonical request is re-evaluated at a fresh trusted time; request/config validity precedes args.
const expiringRequest = signClaims({ ...good.claims, validUntil: 1050 }, seeds.caller);
negative(
  "request_expired_after_success",
  expiringRequest,
  sourceDelivery(expiringRequest),
  "request-outside-validity",
  {
    receivedAt: 1100,
    first: { receivedAt: 1000, outcome: outcome(expiringRequest, baseBody) },
  },
);
const expiringConfig = signClaims({ ...config.claims, validUntil: 1050 }, seeds.receiver),
  configRequest = repoint(good, "configuration", ref(expiringConfig.id));
negative(
  "configuration_expired_after_success",
  configRequest,
  sourceDelivery(configRequest),
  "configuration-mismatch",
  {
    cfg: expiringConfig,
    receivedAt: 1100,
    first: {
      receivedAt: 1000,
      outcome: outcome(configRequest, baseBody, "completed", expiringConfig),
    },
  },
);
// A malformed authority role is a stage-4 closure defect, before source validation.
const malformedAuthorityCapture = repoint(
  s.capture,
  "authority",
  ent("not-a-delta-reference"),
  seeds.capturer,
);
const malformedAuthorityRequest = repoint(good, "capture", ref(malformedAuthorityCapture.id));
negative(
  "capture_authority_pointer_shape",
  malformedAuthorityRequest,
  sourceDelivery(malformedAuthorityRequest).map((d) =>
    d.id === s.capture.id ? serializeCommandDelta(malformedAuthorityCapture) : d,
  ),
  "unexpected-support",
);

// Capture's signed commitment must identify the exact supplied canonical snapshot payload.
const wrongSnapshotBasis = description("capture/1", readFieldsWithNewBasis(), seeds.capturer);
function readFieldsWithNewBasis(): readonly (readonly [string, Target | readonly Target[]])[] {
  return s.capture.claims.pointers
    .filter((p) => p.role !== prefix + "kind")
    .map((p) => {
      if (p.role !== prefix + "basis") return [p.role.slice(prefix.length), p.target] as const;
      const raw = decode((p.target as Extract<Target, { kind: "bytes" }>).value);
      return ["basis", blob(encode(update(raw, "snapshot", tstr(authorityRoot))))] as const;
    });
}
const wrongSnapshotQ = repoint(good, "capture", ref(wrongSnapshotBasis.id));
negative(
  "source_bad_snapshot_commitment",
  wrongSnapshotQ,
  [wrongSnapshotQ, wrongSnapshotBasis, s.snapshot, authority, ...defs].map(serializeCommandDelta),
  "invalid-source",
);
// Retained payloads are ordinary deltas, including future control descriptions. No lifecycle parser runs.
const retainedRegistration = description("registration/1", [
  ["receiver", ent(keys.receiver!)],
  ["configuration", ref(config.id)],
  ["root", ent(root)],
]);
const retainedInstall = description("request/1", [
  ["receiver", ent(keys.receiver!)],
  ["configuration", ref(config.id)],
  ["operation", ref(authorityRoot)],
  ["registration", ref(retainedRegistration.id)],
]);
negatives.push(...(extraNegatives as unknown as typeof negatives));
writeFileSync(
  new URL("../../../vectors/materialization/commands.json", import.meta.url),
  JSON.stringify(
    {
      format: "rhizomatic-materialization-command-vectors/1",
      oracle:
        "Hand selected Plant/empty/negation/historical HViews and scalar/bytes Views; complete MR19 bodies and strict original program closure manually constructed using existing L0/syntax encoders only. No new M2 helper imports, command invocation, or result reader.",
      seeds,
      keys,
      retention: [config, retainedRegistration, retainedInstall].map(serializeCommandDelta),
      boot: {
        configuration: serializeCommandDelta(config),
        declarations: operations.map(serializeCommandDelta),
        bindings: [serializeCommandDelta(binding)],
      },
      positives,
      negatives,
      resultRejections,
      sentinel,
    },
    null,
    2,
  ) + "\n",
);

// ---- SPEC-16 M3 lifecycle schedule (release B). Each step boots a fresh endpoint from an explicit
// control image; expected outcomes and images are assembled by hand from the plant fixture.
{
  const VERBS = [
    "gather",
    "resolve",
    "install",
    "replace-source",
    "advance-time",
    "retire",
    "read",
    "restore",
  ];
  const CONTROL = ["install", "replace-source", "advance-time", "retire"];
  const operationsB = VERBS.map((verb) =>
    description(
      "operation/1",
      [
        ["name", ent(prefix + verb)],
        ["interpreter", p(prefix + verb + "/1")],
        ["input-contract", p(prefix + verb + "/1")],
        ["output-contract", p(prefix + "outcome/1")],
        ["effect", p(CONTROL.includes(verb) ? "control" : "none")],
        ["replay", p("re-evaluate/1")],
        ["dependencies", p("explicit-support/1")],
      ],
      seeds.receiver,
      0,
    ),
  );
  const opB = (verb: string) => operationsB[VERBS.indexOf(verb)]!;
  const configB = description(
    "endpoint/1",
    [
      ["receiver", ent(keys.receiver!)],
      ["caller", p(keys.caller!)],
      ["administrator", p(keys.caller!)],
      [
        "installed",
        operationsB
          .map((o) => o.id)
          .sort()
          .map(ref),
      ],
      ["source-binding", [ref(binding.id)]],
      ["limits", blob(encode(map(Object.entries(limits).map(([k, v]) => [k, float(v)]))))],
    ],
    seeds.receiver,
    0,
  );
  const descriptor = description(
    "registration/1",
    [
      ["source-binding", ref(binding.id)],
      ["hyperschema", ref(hyper.id)],
      ["hyperschema-pin", p(termHash(term))],
      ["schema", ref(schema.id)],
      ["schema-pin", p(schemaHash(reading))],
      ["roots", ent(root)],
      ["bindings", blob(C_EMPTY)],
      ["definition-at", p(1000)],
      ["interpretation", p("core/1")],
      ["result-kind", p("hview-and-view/1")],
      ["time-policy", p("live-time/1")],
      ["alias", p("Plant")],
    ],
    seeds.definition,
    0,
  );
  const field = (v: CborValue, k: string): CborValue => {
    if (v.t !== "map") throw Error();
    const x = new Map(v.v).get(k);
    if (!x) throw Error(k);
    return x;
  };
  const plantGather = decode(hex(positives[0]!.expected.gatherBodyHex)),
    plantResolve = decode(hex(positives[0]!.expected.resolveBodyHex));
  const rootResult = map([
    ["root", tstr(root)],
    ["envelope", field(plantGather, "envelope")],
    ["transport", field(plantGather, "transport")],
    ["hview", field(plantGather, "hview")],
    ["value", field(plantResolve, "value")],
    ["view", field(plantResolve, "view")],
  ]);
  const basisAt = (at: number) => update(field(plantGather, "basis"), "at", float(at));
  const stateAct = (
    generation: number,
    priorControl: string,
    priorTransition: string,
    verb: string,
    at: number,
    capture?: string,
  ) =>
    description(
      "state/1",
      [
        ["registration", ref(descriptor.id)],
        ["generation", p(generation)],
        ["prior-control", p(priorControl)],
        ["prior-transition", p(priorTransition)],
        ["verb", p(verb)],
        ["source-revision", p(s.revision)],
        ["authority", p(authority.id)],
        ["at", p(at)],
        ["definition-at", p(1000)],
        ["hyperschema-pin", p(termHash(term))],
        ["schema-pin", p(schemaHash(reading))],
        ...(capture === undefined ? [] : [["capture", ref(capture)] as const]),
      ],
      seeds.receiver,
      1000,
    );
  interface Entry {
    status: "active" | "retired";
    transition: string;
    at: number;
    capture?: string;
  }
  const entryValue = (e: Entry) =>
    map([
      ["registration", tstr(descriptor.id)],
      ["status", tstr(e.status)],
      ["transition", tstr(e.transition)],
      ["sourceRevision", tstr(s.revision)],
      ["authority", tstr(authority.id)],
      ["at", float(e.at)],
      ["definitionAt", float(1000)],
      ["hyperschemaPin", tstr(termHash(term))],
      ["schemaPin", tstr(schemaHash(reading))],
      ...(e.capture === undefined ? [] : [["capture", tstr(e.capture)] as const]),
    ]);
  const image = (generation: number, entries: Entry[], support: Delta[]) =>
    encode(
      map([
        ["format", tstr("rhizomatic.materialization-control/1")],
        ["receiver", tstr(keys.receiver!)],
        ["configuration", tstr(configB.id)],
        ["generation", float(generation)],
        ["entries", array(entries.map(entryValue))],
        [
          "deltas",
          array(
            support
              .map(appearance)
              .sort((a, b) => {
                const ka = contentAddress(a),
                  kb = contentAddress(b);
                return ka < kb ? -1 : ka > kb ? 1 : 0;
              })
              .map(bstr),
          ),
        ],
      ]),
    );
  const revisionOf = (bytes: Uint8Array, generation: number) =>
    generation === 0 ? "" : contentAddress(bytes);
  const c0 = image(0, [], []);
  const t1 = stateAct(1, "", "", "install", 1000, s.capture.id);
  const c1 = image(
    1,
    [{ status: "active", transition: t1.id, at: 1000, capture: s.capture.id }],
    [descriptor, ...defs, s.capture, authority, t1],
  );
  const r1 = revisionOf(c1, 1);
  const t2 = stateAct(2, r1, t1.id, "advance-time", 1500, s.capture.id);
  const c2 = image(
    2,
    [{ status: "active", transition: t2.id, at: 1500, capture: s.capture.id }],
    [descriptor, ...defs, s.capture, authority, t2],
  );
  const r2 = revisionOf(c2, 2);
  const t3 = stateAct(3, r2, t2.id, "replace-source", 1500, s.capture.id);
  const c3 = image(
    3,
    [{ status: "active", transition: t3.id, at: 1500, capture: s.capture.id }],
    [descriptor, ...defs, s.capture, authority, t3],
  );
  const r3 = revisionOf(c3, 3);
  const t4 = stateAct(4, r3, t3.id, "retire", 1500);
  const c4 = image(4, [{ status: "retired", transition: t4.id, at: 1500 }], [t4]);
  const r4 = revisionOf(c4, 4);
  const requestB = (verb: string, fields: (readonly [string, Target | readonly Target[]])[]) =>
    description("request/1", [
      ["receiver", ent(keys.receiver!)],
      ["configuration", ref(configB.id)],
      ["operation", ref(opB(verb).id)],
      ...fields,
    ]);
  const installQ = (control: string) =>
    requestB("install", [
      ["expected-control", p(control)],
      ["registration", ref(descriptor.id)],
      ["capture", ref(s.capture.id)],
      ["snapshot", ref(s.snapshot.id)],
      ["at", p(1000)],
      ["serving-at", p(1000)],
    ]);
  const readQ = (control: string, source = s.revision) =>
    requestB("read", [
      ["expected-control", p(control)],
      ["registration", ref(descriptor.id)],
      ["expected-source", p(source)],
      ["snapshot", ref(s.snapshot.id)],
      ["serving-at", p(1000)],
    ]);
  const advanceQ = (control: string, at: number) =>
    requestB("advance-time", [
      ["expected-control", p(control)],
      ["registration", ref(descriptor.id)],
      ["expected-source", p(s.revision)],
      ["snapshot", ref(s.snapshot.id)],
      ["at", p(at)],
      ["serving-at", p(1000)],
    ]);
  const replaceQ = (control: string) =>
    requestB("replace-source", [
      ["expected-control", p(control)],
      ["registration", ref(descriptor.id)],
      ["expected-source", p(s.revision)],
      ["capture", ref(s.capture.id)],
      ["snapshot", ref(s.snapshot.id)],
      ["serving-at", p(1000)],
    ]);
  const retireQ = (control: string) =>
    requestB("retire", [
      ["expected-control", p(control)],
      ["registration", ref(descriptor.id)],
    ]);
  const restoreQ = (control: string) => requestB("restore", [["expected-control", p(control)]]);
  const installDelivery = (q: Delta) => [q, descriptor, s.capture, s.snapshot, authority, ...defs];
  const transitionBody = (
    kind: string,
    transition: Delta,
    control: string,
    generation: number,
    at: number,
  ) =>
    map([
      ["kind", tstr(kind)],
      ["registration", tstr(descriptor.id)],
      ["transition", tstr(transition.id)],
      ["control", tstr(control)],
      ["generation", float(generation)],
      ["basis", basisAt(at)],
      ["results", array([rootResult])],
    ]);
  const steps: Record<string, unknown>[] = [];
  const step = (
    id: string,
    q: Delta,
    delivery: Delta[],
    before: [Uint8Array, number],
    expected: {
      status: "completed" | "refused";
      body: CborValue;
      after?: Uint8Array;
      code?: string;
    },
    extra: Record<string, unknown> = {},
  ) => {
    // Every step names its MR-21 preflight projection; stage-5+ refusals project input-valid.
    const {
      preflight = { status: "input-valid" },
      boot: cfg = configB,
      receivedAt,
      ...rest
    } = extra as {
      preflight?: Record<string, unknown>;
      boot?: Delta;
      receivedAt?: number;
    } & Record<string, unknown>;
    // A step received later than 1000 signs its outcome at that time; only release-B boots do.
    if (receivedAt !== undefined && cfg !== configB) throw Error("receivedAt needs configB");
    steps.push({
      id,
      request: serializeCommandDelta(q),
      delivery: delivery.map(serializeCommandDelta),
      initialControl: { hex: bytesToHex(before[0]), revision: revisionOf(before[0], before[1]) },
      ...(receivedAt === undefined ? {} : { receivedAt }),
      expected: {
        status: expected.status,
        ...(expected.code === undefined ? {} : { code: expected.code }),
        outcome: serializeCommandDelta(
          receivedAt === undefined
            ? outcome(q, expected.body, expected.status, cfg as Delta)
            : outcomeAt(q, expected.body, expected.status, receivedAt),
        ),
        bodyHex: bytesToHex(encode(expected.body)),
        controlHex: bytesToHex(expected.after ?? before[0]),
        preflight,
      },
      ...rest,
    });
  };
  const invalidInput = (code: string) => ({ preflight: { status: "invalid-input", code } });
  const overLimit = { preflight: { status: "over-input-limit", code: "resource-limit" } };
  const refusal = (code: string) => ({
    status: "refused" as const,
    body: map([["code", tstr(code)]]),
    code,
  });
  step("install", installQ(""), installDelivery(installQ("")), [c0, 0], {
    status: "completed",
    body: transitionBody("install", t1, r1, 1, 1000),
    after: c1,
  });
  step("read_installed", readQ(r1), [readQ(r1), s.snapshot], [c1, 1], {
    status: "completed",
    body: map([
      ["kind", tstr("read")],
      ["registration", tstr(descriptor.id)],
      ["control", tstr(r1)],
      ["generation", float(1)],
      ["basis", basisAt(1000)],
      ["results", array([rootResult])],
    ]),
  });
  step("advance_time", advanceQ(r1, 1500), [advanceQ(r1, 1500), s.snapshot], [c1, 1], {
    status: "completed",
    body: transitionBody("advance-time", t2, r2, 2, 1500),
    after: c2,
  });
  step(
    "replace_source_same_basis",
    replaceQ(r2),
    [replaceQ(r2), s.capture, s.snapshot, authority],
    [c2, 2],
    {
      status: "completed",
      body: transitionBody("replace-source", t3, r3, 3, 1500),
      after: c3,
    },
  );
  step("retire", retireQ(r3), [retireQ(r3)], [c3, 3], {
    status: "completed",
    body: map([
      ["kind", tstr("retire")],
      ["registration", tstr(descriptor.id)],
      ["transition", tstr(t4.id)],
      ["control", tstr(r4)],
      ["generation", float(4)],
    ]),
    after: c4,
  });
  step("restore_retired", restoreQ(r4), [restoreQ(r4)], [c4, 4], {
    status: "completed",
    body: map([
      ["kind", tstr("restore")],
      ["control", tstr(r4)],
      ["generation", float(4)],
      [
        "selections",
        array([
          map([
            ["registration", tstr(descriptor.id)],
            ["status", tstr("retired")],
            ["sourceRevision", tstr(s.revision)],
            ["authority", tstr(authority.id)],
            ["at", float(1500)],
            ["definitionAt", float(1000)],
            ["hyperschemaPin", tstr(termHash(term))],
            ["schemaPin", tstr(schemaHash(reading))],
            ["availability", tstr("retired")],
          ]),
        ]),
      ],
    ]),
  });
  // Two more images the mixed towers restore and read after a crossing (M3 slice C).
  step("restore_installed", restoreQ(r1), [restoreQ(r1)], [c1, 1], {
    status: "completed",
    body: map([
      ["kind", tstr("restore")],
      ["control", tstr(r1)],
      ["generation", float(1)],
      [
        "selections",
        array([
          map([
            ["registration", tstr(descriptor.id)],
            ["status", tstr("active")],
            ["sourceRevision", tstr(s.revision)],
            ["authority", tstr(authority.id)],
            ["at", float(1000)],
            ["definitionAt", float(1000)],
            ["hyperschemaPin", tstr(termHash(term))],
            ["schemaPin", tstr(schemaHash(reading))],
            ["availability", tstr("unchecked")],
          ]),
        ]),
      ],
    ]),
  });
  const activeSelection = (at: number) =>
    map([
      ["registration", tstr(descriptor.id)],
      ["status", tstr("active")],
      ["sourceRevision", tstr(s.revision)],
      ["authority", tstr(authority.id)],
      ["at", float(at)],
      ["definitionAt", float(1000)],
      ["hyperschemaPin", tstr(termHash(term))],
      ["schemaPin", tstr(schemaHash(reading))],
      ["availability", tstr("unchecked")],
    ]);
  step("restore_advanced", restoreQ(r2), [restoreQ(r2)], [c2, 2], {
    status: "completed",
    body: map([
      ["kind", tstr("restore")],
      ["control", tstr(r2)],
      ["generation", float(2)],
      ["selections", array([activeSelection(1500)])],
    ]),
  });
  step("restore_replaced", restoreQ(r3), [restoreQ(r3)], [c3, 3], {
    status: "completed",
    body: map([
      ["kind", tstr("restore")],
      ["control", tstr(r3)],
      ["generation", float(3)],
      ["selections", array([activeSelection(1500)])],
    ]),
  });
  step("read_replaced", readQ(r3), [readQ(r3), s.snapshot], [c3, 3], {
    status: "completed",
    body: map([
      ["kind", tstr("read")],
      ["registration", tstr(descriptor.id)],
      ["control", tstr(r3)],
      ["generation", float(3)],
      ["basis", basisAt(1500)],
      ["results", array([rootResult])],
    ]),
  });
  step("read_advanced", readQ(r2), [readQ(r2), s.snapshot], [c2, 2], {
    status: "completed",
    body: map([
      ["kind", tstr("read")],
      ["registration", tstr(descriptor.id)],
      ["control", tstr(r2)],
      ["generation", float(2)],
      ["basis", basisAt(1500)],
      ["results", array([rootResult])],
    ]),
  });
  step("restore_empty", restoreQ(""), [restoreQ("")], [c0, 0], {
    status: "completed",
    body: map([
      ["kind", tstr("restore")],
      ["control", tstr("")],
      ["generation", float(0)],
      ["selections", array([])],
    ]),
  });
  // Known refusals leave the image unchanged (MR-16, MR-18).
  step(
    "install_already_installed",
    installQ(r1),
    installDelivery(installQ(r1)),
    [c1, 1],
    refusal("already-installed"),
  );
  step(
    "install_stale_control",
    installQ(""),
    installDelivery(installQ("")),
    [c1, 1],
    refusal("precondition-failed"),
  );
  step(
    "read_wrong_control",
    readQ(r2),
    [readQ(r2), s.snapshot],
    [c1, 1],
    refusal("precondition-failed"),
  );
  step(
    "read_wrong_source",
    readQ(r1, authorityRoot),
    [readQ(r1, authorityRoot), s.snapshot],
    [c1, 1],
    refusal("precondition-failed"),
  );
  step(
    "advance_time_regression",
    advanceQ(r2, 1200),
    [advanceQ(r2, 1200), s.snapshot],
    [c2, 2],
    refusal("time-regression"),
  );
  step("retire_missing", retireQ(""), [retireQ("")], [c0, 0], refusal("registration-missing"));
  step("read_retired", readQ(r4), [readQ(r4), s.snapshot], [c4, 4], refusal("retired"));
  step("retire_retired", retireQ(r4), [retireQ(r4)], [c4, 4], refusal("retired"));
  step("install_retired", installQ(r4), installDelivery(installQ(r4)), [c4, 4], refusal("retired"));
  step(
    "install_missing_closure",
    installQ(""),
    installDelivery(installQ("")).filter((d) => d.id !== hyper.id),
    [c0, 0],
    refusal("missing-support"),
    invalidInput("missing-support"),
  );
  step(
    "replace_redelivered_definition",
    replaceQ(r2),
    [replaceQ(r2), s.capture, s.snapshot, authority, hyper],
    [c2, 2],
    refusal("unexpected-support"),
    invalidInput("unexpected-support"),
  );
  {
    const q = requestB("install", [
      ["expected-control", p("")],
      ["registration", ref(s.capture.id)],
      ["capture", ref(s.capture.id)],
      ["snapshot", ref(s.snapshot.id)],
      ["at", p(1000)],
      ["serving-at", p(1000)],
    ]);
    step(
      "install_descriptor_not_registration",
      q,
      [q, s.capture, s.snapshot, authority],
      [c0, 0],
      refusal("invalid-arguments"),
      invalidInput("invalid-arguments"),
    );
  }
  {
    const corrupt = Uint8Array.from(c1);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0x01;
    step(
      "corrupt_image",
      readQ(r1),
      [readQ(r1), s.snapshot],
      [corrupt, 1],
      refusal("invalid-control"),
      {
        initialControlRevision: r1,
      },
    );
  }
  // ---- Slice C2: more sources, more descriptors and multi-entry images, still from the batch
  // oracles above. Every step keeps the plant program unless the step says otherwise.
  interface EntryX {
    registration: Delta;
    status: "active" | "retired";
    transition: string;
    revision: string;
    authority: string;
    at: number;
    definitionAt: number;
    hyperPin: string;
    schemaPin: string;
    capture?: string | undefined;
  }
  type EntryFields = Omit<EntryX, "status" | "transition">;
  const byId = (p: Delta, q: Delta) => (p.id < q.id ? -1 : 1);
  const entryX = (e: EntryX) =>
    map([
      ["registration", tstr(e.registration.id)],
      ["status", tstr(e.status)],
      ["transition", tstr(e.transition)],
      ["sourceRevision", tstr(e.revision)],
      ["authority", tstr(e.authority)],
      ["at", float(e.at)],
      ["definitionAt", float(e.definitionAt)],
      ["hyperschemaPin", tstr(e.hyperPin)],
      ["schemaPin", tstr(e.schemaPin)],
      ...(e.capture === undefined ? [] : [["capture", tstr(e.capture)] as const]),
    ]);
  const selectionX = (e: EntryX) =>
    map([
      ["registration", tstr(e.registration.id)],
      ["status", tstr(e.status)],
      ["sourceRevision", tstr(e.revision)],
      ["authority", tstr(e.authority)],
      ["at", float(e.at)],
      ["definitionAt", float(e.definitionAt)],
      ["hyperschemaPin", tstr(e.hyperPin)],
      ["schemaPin", tstr(e.schemaPin)],
      ["availability", tstr(e.status === "active" ? "unchecked" : "retired")],
    ]);
  const sortedEntries = (entries: EntryX[]) =>
    [...entries].sort((p, q) => (p.registration.id < q.registration.id ? -1 : 1));
  const imageX = (generation: number, entries: EntryX[], support: Delta[], cfg = configB) =>
    encode(
      map([
        ["format", tstr("rhizomatic.materialization-control/1")],
        ["receiver", tstr(keys.receiver!)],
        ["configuration", tstr(cfg.id)],
        ["generation", float(generation)],
        ["entries", array(sortedEntries(entries).map(entryX))],
        [
          "deltas",
          array(
            [...new Map(support.map((d) => [d.id, d])).values()]
              .map(appearance)
              .sort((a, b) => {
                const ka = contentAddress(a),
                  kb = contentAddress(b);
                return ka < kb ? -1 : ka > kb ? 1 : 0;
              })
              .map(bstr),
          ),
        ],
      ]),
    );
  const stateX = (
    generation: number,
    priorControl: string,
    priorTransition: string,
    verb: string,
    e: EntryFields,
    receivedAt = 1000,
  ) =>
    description(
      "state/1",
      [
        ["registration", ref(e.registration.id)],
        ["generation", p(generation)],
        ["prior-control", p(priorControl)],
        ["prior-transition", p(priorTransition)],
        ["verb", p(verb)],
        ["source-revision", p(e.revision)],
        ["authority", p(e.authority)],
        ["at", p(e.at)],
        ["definition-at", p(e.definitionAt)],
        ["hyperschema-pin", p(e.hyperPin)],
        ["schema-pin", p(e.schemaPin)],
        ...(e.capture === undefined ? [] : [["capture", ref(e.capture)] as const]),
      ],
      seeds.receiver,
      receivedAt,
    );
  const outcomeAt = (q: Delta, body: CborValue, status: string, at: number) =>
    description(
      "outcome/1",
      [
        ["receiver", ent(keys.receiver!)],
        ["configuration", ref(configB.id)],
        ["request", ref(q.id)],
        ["status", p(status)],
        ["result", blob(encode(body))],
      ],
      seeds.receiver,
      at,
    );
  const transitionX = (
    kind: string,
    registration: Delta,
    transition: Delta,
    control: string,
    generation: number,
    basis: CborValue,
    results: CborValue[],
  ) =>
    map([
      ["kind", tstr(kind)],
      ["registration", tstr(registration.id)],
      ["transition", tstr(transition.id)],
      ["control", tstr(control)],
      ["generation", float(generation)],
      ["basis", basis],
      ["results", array(results)],
    ]);
  const readBodyX = (
    registration: Delta,
    control: string,
    generation: number,
    basis: CborValue,
    results: CborValue[],
  ) =>
    map([
      ["kind", tstr("read")],
      ["registration", tstr(registration.id)],
      ["control", tstr(control)],
      ["generation", float(generation)],
      ["basis", basis],
      ["results", array(results)],
    ]);
  const restoreBodyX = (control: string, generation: number, entries: EntryX[]) =>
    map([
      ["kind", tstr("restore")],
      ["control", tstr(control)],
      ["generation", float(generation)],
      ["selections", array(sortedEntries(entries).map(selectionX))],
    ]);
  // Root results and bases come from the batch oracles of the fixtures that share the program.
  const fixtureOf = (id: string) => positives.find((f) => f.id === id)!;
  const bodiesOf = (id: string) => ({
    gather: decode(hex(fixtureOf(id).expected.gatherBodyHex)),
    resolve: decode(hex(fixtureOf(id).expected.resolveBodyHex)),
  });
  const rootResultFrom = (gather: CborValue, resolve: CborValue, rootId: string) =>
    map([
      ["root", tstr(rootId)],
      ["envelope", field(gather, "envelope")],
      ["transport", field(gather, "transport")],
      ["hview", field(gather, "hview")],
      ["value", field(resolve, "value")],
      ["view", field(resolve, "view")],
    ]);
  const rootResultOf = (id: string, rootId = root) => {
    const b = bodiesOf(id);
    return rootResultFrom(b.gather, b.resolve, rootId);
  };
  const basisFrom = (gather: CborValue, at: number, patch: [string, CborValue][] = []) =>
    patch.reduce(
      (b, [k, v]) => update(b, k, v),
      update(update(field(gather, "basis"), "at", float(at)), "servingAt", float(1000)),
    );
  const basisOf = (id: string, at: number, patch: [string, CborValue][] = []) =>
    basisFrom(bodiesOf(id).gather, at, patch);
  const sourceOf = (src: ReturnType<typeof source>, auth = authority) => ({
    binding: binding.id,
    revision: src.revision,
    authority: auth.id,
  });
  const pins = { hyperPin: termHash(term), schemaPin: schemaHash(reading) };
  const fern: EntryFields = {
    registration: descriptor,
    revision: s.revision,
    authority: authority.id,
    at: 1000,
    definitionAt: 1000,
    ...pins,
    capture: s.capture.id,
  };
  const fernEntry: EntryX = { ...fern, status: "active", transition: t1.id };
  const requestX = (
    verb: string,
    control: string,
    registration: Delta,
    fields: (readonly [string, Target | readonly Target[]])[],
  ) =>
    requestB(verb, [
      ["expected-control", p(control)],
      ["registration", ref(registration.id)],
      ...fields,
    ]);
  const replaceX = (
    control: string,
    src: ReturnType<typeof source>,
    expectedSource: string,
    registration = descriptor,
  ) =>
    requestX("replace-source", control, registration, [
      ["expected-source", p(expectedSource)],
      ["capture", ref(src.capture.id)],
      ["snapshot", ref(src.snapshot.id)],
      ["serving-at", p(1000)],
    ]);
  const readX = (
    control: string,
    src: ReturnType<typeof source>,
    registration = descriptor,
    expectedSource = src.revision,
  ) =>
    requestX("read", control, registration, [
      ["expected-source", p(expectedSource)],
      ["snapshot", ref(src.snapshot.id)],
      ["serving-at", p(1000)],
    ]);
  const installX = (control: string, registration: Delta, src = s, at = 1000) =>
    requestX("install", control, registration, [
      ["capture", ref(src.capture.id)],
      ["snapshot", ref(src.snapshot.id)],
      ["at", p(at)],
      ["serving-at", p(1000)],
    ]);
  const retireX = (control: string, registration: Delta) =>
    requestX("retire", control, registration, []);
  const completed = (body: CborValue, after: Uint8Array) => ({
    status: "completed" as const,
    body,
    after,
  });

  // C2-1: the negation chain. Replace the source twice and read after each replacement.
  const sNeg = source([a, t, x, n1]),
    sRes = source([a, t, x, n1, n2]);
  const fernNeg: EntryFields = { ...fern, revision: sNeg.revision, capture: sNeg.capture.id };
  const tN = stateX(2, r1, t1.id, "replace-source", fernNeg);
  const cN = imageX(
    2,
    [{ ...fernNeg, status: "active", transition: tN.id }],
    [descriptor, ...defs, sNeg.capture, authority, tN],
  );
  const rN = revisionOf(cN, 2);
  step(
    "replace_negated",
    replaceX(r1, sNeg, s.revision),
    [replaceX(r1, sNeg, s.revision), sNeg.capture, sNeg.snapshot, authority],
    [c1, 1],
    completed(
      transitionX("replace-source", descriptor, tN, rN, 2, basisOf("negated", 1000), [
        rootResultOf("negated"),
      ]),
      cN,
    ),
    { source: sourceOf(sNeg) },
  );
  step(
    "read_negated",
    readX(rN, sNeg),
    [readX(rN, sNeg), sNeg.snapshot],
    [cN, 2],
    completed(
      readBodyX(descriptor, rN, 2, basisOf("negated", 1000), [rootResultOf("negated")]),
      cN,
    ),
    { source: sourceOf(sNeg) },
  );
  const fernRes: EntryFields = { ...fern, revision: sRes.revision, capture: sRes.capture.id };
  const tR = stateX(3, rN, tN.id, "replace-source", fernRes);
  const cR = imageX(
    3,
    [{ ...fernRes, status: "active", transition: tR.id }],
    [descriptor, ...defs, sRes.capture, authority, tR],
  );
  const rR = revisionOf(cR, 3);
  step(
    "replace_restored",
    replaceX(rN, sRes, sNeg.revision),
    [replaceX(rN, sRes, sNeg.revision), sRes.capture, sRes.snapshot, authority],
    [cN, 2],
    completed(
      transitionX("replace-source", descriptor, tR, rR, 3, basisOf("restored", 1000), [
        rootResultOf("restored"),
      ]),
      cR,
    ),
    { source: sourceOf(sRes) },
  );
  step(
    "read_restored",
    readX(rR, sRes),
    [readX(rR, sRes), sRes.snapshot],
    [cR, 3],
    completed(
      readBodyX(descriptor, rR, 3, basisOf("restored", 1000), [rootResultOf("restored")]),
      cR,
    ),
    { source: sourceOf(sRes) },
  );

  // C2-2: the same rows under a new authority. The stale read refuses; the replacement moves the
  // source and control revisions although every result byte stays the same.
  step(
    "read_stale_authority",
    readQ(r1),
    [readQ(r1), s.snapshot],
    [c1, 1],
    refusal("source-changed"),
    { source: sourceOf(changedSource, changedAuthority) },
  );
  const fernAuth: EntryFields = {
    ...fern,
    revision: changedSource.revision,
    authority: changedAuthority.id,
    capture: changedSource.capture.id,
  };
  const tA = stateX(2, r1, t1.id, "replace-source", fernAuth);
  const cA = imageX(
    2,
    [{ ...fernAuth, status: "active", transition: tA.id }],
    [descriptor, ...defs, changedSource.capture, changedAuthority, tA],
  );
  const rA = revisionOf(cA, 2);
  step(
    "replace_authority",
    replaceX(r1, changedSource, s.revision),
    [
      replaceX(r1, changedSource, s.revision),
      changedSource.capture,
      changedSource.snapshot,
      changedAuthority,
    ],
    [c1, 1],
    completed(
      transitionX(
        "replace-source",
        descriptor,
        tA,
        rA,
        2,
        basisOf("same_rows_changed_authority", 1000),
        [rootResultOf("same_rows_changed_authority")],
      ),
      cA,
    ),
    { source: sourceOf(changedSource, changedAuthority) },
  );
  step(
    "read_authority",
    readX(rA, changedSource),
    [readX(rA, changedSource), changedSource.snapshot],
    [cA, 2],
    completed(
      readBodyX(descriptor, rA, 2, basisOf("same_rows_changed_authority", 1000), [
        rootResultOf("same_rows_changed_authority"),
      ]),
      cA,
    ),
    { source: sourceOf(changedSource, changedAuthority) },
  );

  // C2-3: a maintained read after the stored authority expires (validUntil 2000).
  const readLate = requestX("read", r1, descriptor, [
    ["expected-source", p(s.revision)],
    ["snapshot", ref(s.snapshot.id)],
    ["serving-at", p(2500)],
  ]);
  steps.push({
    id: "read_authority_expired",
    request: serializeCommandDelta(readLate),
    delivery: [readLate, s.snapshot].map(serializeCommandDelta),
    initialControl: { hex: bytesToHex(c1), revision: r1 },
    receivedAt: 2500,
    expected: {
      status: "refused",
      code: "invalid-source",
      preflight: { status: "input-valid" },
      outcome: serializeCommandDelta(
        outcomeAt(readLate, map([["code", tstr("invalid-source")]]), "refused", 2500),
      ),
      bodyHex: bytesToHex(encode(map([["code", tstr("invalid-source")]]))),
      controlHex: bytesToHex(c1),
    },
  });

  // C2-4: an equal-count replacement (A → B, height 87) and a physical removal (A gone). Both
  // bodies come from the same batch oracle construction as the positives above.
  const b = fact("height", p(87), 11);
  const batch = (rows: Delta[], selected: Delta[], rootId = root) => {
    const src = source([...rows]);
    const q = request(
      src,
      config,
      1000,
      1000,
      hyper,
      schema,
      termHash(term),
      schemaHash(reading),
      [],
      rootId,
    );
    const view: HView = {
      id: rootId,
      props: new Map(
        selected.map((d) => [
          d === a || d === b ? "height" : d === t ? "tag" : "payload",
          [{ delta: d, negated: false }],
        ]),
      ),
    };
    const gathered = gatherBody(src, q, view, 1000, 1000);
    const value = encode(
      map(
        selected.map((d) => [
          d === a || d === b ? "height" : d === t ? "tag" : "payload",
          d === a
            ? float(42)
            : d === b
              ? float(87)
              : d === t
                ? array([tstr("shade")])
                : map([
                    ["mime", tstr("application/octet-stream")],
                    ["value", bstr(hex("00ff01"))],
                  ]),
        ]),
      ),
    );
    const resolved = map([
      ["value", bstr(value)],
      ["view", tstr(contentAddress(value))],
    ]);
    return { src, gather: gathered, rootResult: rootResultFrom(gathered, resolved, rootId) };
  };
  const equal = batch([b, t, x], [b, t, x]),
    removed = batch([t, x], [t, x]);
  const fernB: EntryFields = {
    ...fern,
    revision: equal.src.revision,
    capture: equal.src.capture.id,
  };
  const tB = stateX(2, r1, t1.id, "replace-source", fernB);
  const cB = imageX(
    2,
    [{ ...fernB, status: "active", transition: tB.id }],
    [descriptor, ...defs, equal.src.capture, authority, tB],
  );
  const rB = revisionOf(cB, 2);
  step(
    "replace_equal_count",
    replaceX(r1, equal.src, s.revision),
    [replaceX(r1, equal.src, s.revision), equal.src.capture, equal.src.snapshot, authority],
    [c1, 1],
    completed(
      transitionX("replace-source", descriptor, tB, rB, 2, basisFrom(equal.gather, 1000), [
        equal.rootResult,
      ]),
      cB,
    ),
    { source: sourceOf(equal.src) },
  );
  step(
    "read_equal_count",
    readX(rB, equal.src),
    [readX(rB, equal.src), equal.src.snapshot],
    [cB, 2],
    completed(readBodyX(descriptor, rB, 2, basisFrom(equal.gather, 1000), [equal.rootResult]), cB),
    { source: sourceOf(equal.src) },
  );
  step(
    "read_before_removal",
    readQ(r1),
    [readQ(r1), s.snapshot],
    [c1, 1],
    refusal("source-changed"),
    { source: sourceOf(removed.src) },
  );
  const fernRm: EntryFields = {
    ...fern,
    revision: removed.src.revision,
    capture: removed.src.capture.id,
  };
  const tRm = stateX(2, r1, t1.id, "replace-source", fernRm);
  const cRm = imageX(
    2,
    [{ ...fernRm, status: "active", transition: tRm.id }],
    [descriptor, ...defs, removed.src.capture, authority, tRm],
  );
  const rRm = revisionOf(cRm, 2);
  step(
    "replace_removed",
    replaceX(r1, removed.src, s.revision),
    [replaceX(r1, removed.src, s.revision), removed.src.capture, removed.src.snapshot, authority],
    [c1, 1],
    completed(
      transitionX("replace-source", descriptor, tRm, rRm, 2, basisFrom(removed.gather, 1000), [
        removed.rootResult,
      ]),
      cRm,
    ),
    { source: sourceOf(removed.src) },
  );

  // C2-5: two descriptors on one source. Replacing the fern source leaves the moss selection as
  // it was; the generation is global, the selections are independent.
  const descriptorMoss = description(
    "registration/1",
    [
      ["source-binding", ref(binding.id)],
      ["hyperschema", ref(hyper.id)],
      ["hyperschema-pin", p(termHash(term))],
      ["schema", ref(schema.id)],
      ["schema-pin", p(schemaHash(reading))],
      ["roots", ent("item:moss")],
      ["bindings", blob(C_EMPTY)],
      ["definition-at", p(1000)],
      ["interpretation", p("core/1")],
      ["result-kind", p("hview-and-view/1")],
      ["time-policy", p("live-time/1")],
      ["alias", p("Plant")],
    ],
    seeds.definition,
    0,
  );
  const moss: EntryFields = { ...fern, registration: descriptorMoss };
  const tM = stateX(2, r1, "", "install", moss);
  const mossEntry: EntryX = { ...moss, status: "active", transition: tM.id };
  const cTwo = imageX(
    2,
    [fernEntry, mossEntry],
    [descriptor, descriptorMoss, ...defs, s.capture, authority, t1, tM],
  );
  const rTwo = revisionOf(cTwo, 2);
  step(
    "install_second_root",
    installX(r1, descriptorMoss),
    [installX(r1, descriptorMoss), descriptorMoss, s.capture, s.snapshot, authority, ...defs],
    [c1, 1],
    completed(
      transitionX("install", descriptorMoss, tM, rTwo, 2, basisOf("empty", 1000), [
        rootResultOf("empty", "item:moss"),
      ]),
      cTwo,
    ),
  );
  const tF = stateX(3, rTwo, t1.id, "replace-source", fernNeg);
  const cThree = imageX(
    3,
    [{ ...fernNeg, status: "active", transition: tF.id }, mossEntry],
    [descriptor, descriptorMoss, ...defs, s.capture, sNeg.capture, authority, tM, tF],
  );
  const rThree = revisionOf(cThree, 3);
  step(
    "replace_fern_only",
    replaceX(rTwo, sNeg, s.revision),
    [replaceX(rTwo, sNeg, s.revision), sNeg.capture, sNeg.snapshot, authority],
    [cTwo, 2],
    completed(
      transitionX("replace-source", descriptor, tF, rThree, 3, basisOf("negated", 1000), [
        rootResultOf("negated"),
      ]),
      cThree,
    ),
    { source: sourceOf(sNeg) },
  );
  step(
    "read_moss_unchanged",
    readX(rThree, s, descriptorMoss),
    [readX(rThree, s, descriptorMoss), s.snapshot],
    [cThree, 3],
    completed(
      readBodyX(descriptorMoss, rThree, 3, basisOf("empty", 1000), [
        rootResultOf("empty", "item:moss"),
      ]),
      cThree,
    ),
  );
  step(
    "read_fern_replaced",
    readX(rThree, sNeg),
    [readX(rThree, sNeg), sNeg.snapshot],
    [cThree, 3],
    completed(
      readBodyX(descriptor, rThree, 3, basisOf("negated", 1000), [rootResultOf("negated")]),
      cThree,
    ),
    { source: sourceOf(sNeg) },
  );
  step(
    "restore_two_roots",
    restoreQ(rThree),
    [restoreQ(rThree)],
    [cThree, 3],
    completed(
      restoreBodyX(rThree, 3, [{ ...fernNeg, status: "active", transition: tF.id }, mossEntry]),
      cThree,
    ),
  );

  // C2-6: a descriptor that expires at 1200 retires at 1500 with no source grant at all.
  const descriptorExpiring = signClaims(
    {
      ...description(
        "registration/1",
        [
          ["source-binding", ref(binding.id)],
          ["hyperschema", ref(hyper.id)],
          ["hyperschema-pin", p(termHash(term))],
          ["schema", ref(schema.id)],
          ["schema-pin", p(schemaHash(reading))],
          ["roots", ent(root)],
          ["bindings", blob(C_EMPTY)],
          ["definition-at", p(1000)],
          ["interpretation", p("core/1")],
          ["result-kind", p("hview-and-view/1")],
          ["time-policy", p("live-time/1")],
          ["alias", p("PlantExpiring")],
        ],
        seeds.definition,
        0,
      ).claims,
      validUntil: 1200,
    },
    seeds.definition,
  );
  const expiring: EntryFields = { ...fern, registration: descriptorExpiring };
  const tE = stateX(1, "", "", "install", expiring);
  const cE = imageX(
    1,
    [{ ...expiring, status: "active", transition: tE.id }],
    [descriptorExpiring, ...defs, s.capture, authority, tE],
  );
  const rE = revisionOf(cE, 1);
  step(
    "install_expiring",
    installX("", descriptorExpiring),
    [
      installX("", descriptorExpiring),
      descriptorExpiring,
      s.capture,
      s.snapshot,
      authority,
      ...defs,
    ],
    [c0, 0],
    completed(
      transitionX("install", descriptorExpiring, tE, rE, 1, basisOf("plant", 1000), [
        rootResultOf("plant"),
      ]),
      cE,
    ),
  );
  const tER = stateX(2, rE, tE.id, "retire", { ...expiring, capture: undefined }, 1500);
  const cER = imageX(
    2,
    [{ ...expiring, capture: undefined, status: "retired", transition: tER.id }],
    [tER],
  );
  const rER = revisionOf(cER, 2);
  steps.push({
    id: "retire_expired_without_grant",
    request: serializeCommandDelta(retireX(rE, descriptorExpiring)),
    delivery: [serializeCommandDelta(retireX(rE, descriptorExpiring))],
    initialControl: { hex: bytesToHex(cE), revision: rE },
    receivedAt: 1500,
    noGrant: true,
    expected: {
      status: "completed",
      preflight: { status: "input-valid" },
      outcome: serializeCommandDelta(
        outcomeAt(
          retireX(rE, descriptorExpiring),
          map([
            ["kind", tstr("retire")],
            ["registration", tstr(descriptorExpiring.id)],
            ["transition", tstr(tER.id)],
            ["control", tstr(rER)],
            ["generation", float(2)],
          ]),
          "completed",
          1500,
        ),
      ),
      bodyHex: bytesToHex(
        encode(
          map([
            ["kind", tstr("retire")],
            ["registration", tstr(descriptorExpiring.id)],
            ["transition", tstr(tER.id)],
            ["control", tstr(rER)],
            ["generation", float(2)],
          ]),
        ),
      ),
      controlHex: bytesToHex(cER),
    },
  });

  // C2-7: after the fern descriptor retires, a new descriptor selects the later-signed
  // definitions at definition-at 1500. The retired entry keeps only its terminal transition.
  const descriptorLater = description(
    "registration/1",
    [
      ["source-binding", ref(binding.id)],
      ["hyperschema", ref(laterHyper.id)],
      ["hyperschema-pin", p(termHash(term))],
      ["schema", ref(laterSchema.id)],
      ["schema-pin", p(schemaHash(reading))],
      ["roots", ent(root)],
      ["bindings", blob(C_EMPTY)],
      ["definition-at", p(1500)],
      ["interpretation", p("core/1")],
      ["result-kind", p("hview-and-view/1")],
      ["time-policy", p("live-time/1")],
      ["alias", p("Plant")],
    ],
    seeds.definition,
    0,
  );
  const later: EntryFields = { ...fern, registration: descriptorLater, definitionAt: 1500 };
  const tL = stateX(5, r4, "", "install", later);
  const retiredFern: EntryX = {
    ...fern,
    at: 1500,
    capture: undefined,
    status: "retired",
    transition: t4.id,
  };
  const cL = imageX(
    5,
    [retiredFern, { ...later, status: "active", transition: tL.id }],
    [t4, descriptorLater, ...laterDefs, s.capture, authority, tL],
  );
  const rL = revisionOf(cL, 5);
  const laterBasis = basisOf("plant", 1000, [
    ["definitionAt", float(1500)],
    ["hyperschema", tstr(laterHyper.id)],
    ["schema", tstr(laterSchema.id)],
    ["definitions", array(laterDefs.map((d) => bstr(appearance(d))))],
    ["definitionDigest", tstr(digest(laterDefs.map((d) => d.id)))],
  ]);
  step(
    "install_later_definitions",
    installX(r4, descriptorLater),
    [
      installX(r4, descriptorLater),
      descriptorLater,
      s.capture,
      s.snapshot,
      authority,
      ...laterDefs,
    ],
    [c4, 4],
    completed(
      transitionX("install", descriptorLater, tL, rL, 5, laterBasis, [rootResultOf("plant")]),
      cL,
    ),
  );
  step(
    "read_later_definitions",
    readX(rL, s, descriptorLater),
    [readX(rL, s, descriptorLater), s.snapshot],
    [cL, 5],
    completed(readBodyX(descriptorLater, rL, 5, laterBasis, [rootResultOf("plant")]), cL),
  );
  step(
    "restore_retired_and_later",
    restoreQ(rL),
    [restoreQ(rL)],
    [cL, 5],
    completed(
      restoreBodyX(rL, 5, [retiredFern, { ...later, status: "active", transition: tL.id }]),
      cL,
    ),
  );
  // ---- Review round 1: shared counterexamples for the seven findings on 17032db.
  const registrationFields = (
    roots: Target[],
    aliases: Target[],
    patch: (readonly [string, Target | readonly Target[]])[] = [],
  ): (readonly [string, Target | readonly Target[]])[] => [
    ["source-binding", ref(binding.id)],
    ["hyperschema", ref(hyper.id)],
    ["hyperschema-pin", p(termHash(term))],
    ["schema", ref(schema.id)],
    ["schema-pin", p(schemaHash(reading))],
    ["roots", roots],
    ["bindings", blob(C_EMPTY)],
    ["definition-at", p(1000)],
    ["interpretation", p("core/1")],
    ["result-kind", p("hview-and-view/1")],
    ["time-policy", p("live-time/1")],
    ["alias", aliases],
    ...patch,
  ];
  // A descriptor whose roots or aliases carry the wrong target kind is not a registration (MR-13).
  // Signed as raw claims so the description writer's own grammar does not refuse it first.
  const rawDescriptor = (fields: (readonly [string, Target | readonly Target[]])[]) =>
    signClaims(
      {
        author: keys.definition!,
        timestamp: 0,
        validFrom: 0,
        pointers: [
          { role: prefix + "kind", target: p("registration/1") },
          ...fields.flatMap(([k, v]) =>
            (Array.isArray(v) ? v : [v]).map((target) => ({
              role: prefix + k,
              target: target as Target,
            })),
          ),
        ],
      },
      seeds.definition,
    );
  const textRoot = rawDescriptor(registrationFields([p(root)], [p("Plant")]));
  const entityAlias = rawDescriptor(registrationFields([ent(root)], [ent("Plant")]));
  for (const [id, d] of [
    ["install_text_root", textRoot],
    ["install_entity_alias", entityAlias],
  ] as const) {
    step(
      id,
      installX("", d),
      [installX("", d), d, s.capture, s.snapshot, authority, ...defs],
      [c0, 0],
      refusal("invalid-arguments"),
      invalidInput("invalid-arguments"),
    );
  }
  // Sixty-five roots exceed the absolute roots limit (MR-04) at stage 4, before any root runs.
  const manyRoots = description(
    "registration/1",
    registrationFields(
      Array.from({ length: 65 }, (_, i) => ent("root:" + String(i).padStart(2, "0"))),
      [p("Plant")],
    ),
    seeds.definition,
    0,
  );
  step(
    "install_65_roots",
    installX("", manyRoots),
    [installX("", manyRoots), manyRoots, s.capture, s.snapshot, authority, ...defs],
    [c0, 0],
    refusal("resource-limit"),
    overLimit,
  );
  // Root results sort by UTF-8 bytes: U+E000 (EE 80 80) precedes U+10000 (F0 90 80 80) although
  // UTF-16 code units order them the other way.
  const privateRoots = ["", "\u{10000}"];
  const privateDescriptor = description(
    "registration/1",
    registrationFields(privateRoots.map(ent), [p("Plant")]),
    seeds.definition,
    0,
  );
  const privateBatches = privateRoots.map((r) => batch([a, t, x], [], r));
  const privateEntry: EntryFields = { ...fern, registration: privateDescriptor };
  const tP = stateX(1, "", "", "install", privateEntry);
  const cP = imageX(
    1,
    [{ ...privateEntry, status: "active", transition: tP.id }],
    [privateDescriptor, ...defs, s.capture, authority, tP],
  );
  const rP = revisionOf(cP, 1);
  step(
    "install_private_use_roots",
    installX("", privateDescriptor),
    [installX("", privateDescriptor), privateDescriptor, s.capture, s.snapshot, authority, ...defs],
    [c0, 0],
    completed(
      transitionX(
        "install",
        privateDescriptor,
        tP,
        rP,
        1,
        basisFrom(privateBatches[0]!.gather, 1000),
        privateBatches.map((x) => x.rootResult),
      ),
      cP,
    ),
  );
  // A boot may lower the roots limit (MR-04); two roots refuse under a limit of one.
  const endpointFor = (callers: string[], admins: string[], lim: typeof limits) =>
    description(
      "endpoint/1",
      [
        ["receiver", ent(keys.receiver!)],
        ["caller", callers.map(p)],
        ["administrator", admins.map(p)],
        [
          "installed",
          operationsB
            .map((o) => o.id)
            .sort()
            .map(ref),
        ],
        ["source-binding", [ref(binding.id)]],
        ["limits", blob(encode(map(Object.entries(lim).map(([k, v]) => [k, float(v)]))))],
      ],
      seeds.receiver,
      0,
    );
  const configLow = endpointFor([keys.caller!], [keys.caller!], { ...limits, roots: 1 });
  const twoRoots = description(
    "registration/1",
    registrationFields([ent(root), ent("item:moss")], [p("Plant")]),
    seeds.definition,
    0,
  );
  const requestFor = (
    cfg: Delta,
    verb: string,
    fields: (readonly [string, Target | readonly Target[]])[],
  ) =>
    description("request/1", [
      ["receiver", ent(keys.receiver!)],
      ["configuration", ref(cfg.id)],
      ["operation", ref(opB(verb).id)],
      ...fields,
    ]);
  const installFor = (cfg: Delta, control: string, registration: Delta) =>
    requestFor(cfg, "install", [
      ["expected-control", p(control)],
      ["registration", ref(registration.id)],
      ["capture", ref(s.capture.id)],
      ["snapshot", ref(s.snapshot.id)],
      ["at", p(1000)],
      ["serving-at", p(1000)],
    ]);
  const cLow0 = imageX(0, [], [], configLow);
  step(
    "install_two_roots_lowered_limit",
    installFor(configLow, "", twoRoots),
    [installFor(configLow, "", twoRoots), twoRoots, s.capture, s.snapshot, authority, ...defs],
    [cLow0, 0],
    refusal("resource-limit"),
    {
      ...overLimit,
      boot: configLow,
      bootOverride: {
        configuration: serializeCommandDelta(configLow),
        declarations: operationsB.map(serializeCommandDelta),
        bindings: [serializeCommandDelta(binding)],
      },
    },
  );
  // A caller who is not an administrator cannot run any control verb (MR-08, MR-21 stage 3).
  const configAdmin = endpointFor([keys.caller!, keys.receiver!], [keys.receiver!], limits);
  const cAdmin0 = imageX(0, [], [], configAdmin);
  const adminRequests: [string, Delta, Delta[]][] = [
    [
      "install",
      installFor(configAdmin, "", descriptor),
      [descriptor, s.capture, s.snapshot, authority, ...defs],
    ],
    [
      "replace-source",
      requestFor(configAdmin, "replace-source", [
        ["expected-control", p("")],
        ["registration", ref(descriptor.id)],
        ["expected-source", p(s.revision)],
        ["capture", ref(s.capture.id)],
        ["snapshot", ref(s.snapshot.id)],
        ["serving-at", p(1000)],
      ]),
      [s.capture, s.snapshot, authority],
    ],
    [
      "advance-time",
      requestFor(configAdmin, "advance-time", [
        ["expected-control", p("")],
        ["registration", ref(descriptor.id)],
        ["expected-source", p(s.revision)],
        ["snapshot", ref(s.snapshot.id)],
        ["at", p(1500)],
        ["serving-at", p(1000)],
      ]),
      [s.snapshot],
    ],
    [
      "retire",
      requestFor(configAdmin, "retire", [
        ["expected-control", p("")],
        ["registration", ref(descriptor.id)],
      ]),
      [],
    ],
    ["restore", requestFor(configAdmin, "restore", [["expected-control", p("")]]), []],
  ];
  for (const [verb, q, support] of adminRequests)
    step(
      "caller_without_administrator_" + verb.replace("-", "_"),
      q,
      [q, ...support],
      [cAdmin0, 0],
      refusal("unauthorized"),
      {
        ...invalidInput("unauthorized"),
        boot: configAdmin,
        bootOverride: {
          configuration: serializeCommandDelta(configAdmin),
          declarations: operationsB.map(serializeCommandDelta),
          bindings: [serializeCommandDelta(binding)],
        },
      },
    );
  // Stage-6 order: a missing grant and an expired authority both beat a wrong expected-source.
  step(
    "read_wrong_source_without_grant",
    readQ(r1, authorityRoot),
    [readQ(r1, authorityRoot), s.snapshot],
    [c1, 1],
    refusal("unauthorized"),
    { noGrant: true },
  );
  const readLateWrong = requestX("read", r1, descriptor, [
    ["expected-source", p(authorityRoot)],
    ["snapshot", ref(s.snapshot.id)],
    ["serving-at", p(2500)],
  ]);
  steps.push({
    id: "read_wrong_source_expired_authority",
    request: serializeCommandDelta(readLateWrong),
    delivery: [readLateWrong, s.snapshot].map(serializeCommandDelta),
    initialControl: { hex: bytesToHex(c1), revision: r1 },
    receivedAt: 2500,
    expected: {
      status: "refused",
      code: "invalid-source",
      preflight: { status: "input-valid" },
      outcome: serializeCommandDelta(
        outcomeAt(readLateWrong, map([["code", tstr("invalid-source")]]), "refused", 2500),
      ),
      bodyHex: bytesToHex(encode(map([["code", tstr("invalid-source")]]))),
      controlHex: bytesToHex(c1),
    },
  });
  // A signed image whose entry and latest transition name a revision the stored capture does
  // not commit to is structurally inconsistent support (MR-17): restore refuses invalid-control.
  const fakeRevision = authorityRoot;
  const fernFake: EntryFields = { ...fern, revision: fakeRevision };
  const tFake = stateX(1, "", "", "install", fernFake);
  const cFake = imageX(
    1,
    [{ ...fernFake, status: "active", transition: tFake.id }],
    [descriptor, ...defs, s.capture, authority, tFake],
  );
  step(
    "restore_inconsistent_capture",
    restoreQ(revisionOf(cFake, 1)),
    [restoreQ(revisionOf(cFake, 1))],
    [cFake, 1],
    refusal("invalid-control"),
  );
  // ---- Review round 2: shared counterexamples for the findings on 1c81d7f.
  // A signed image whose descriptor and entry agree on a hyperschema pin the retained
  // definition does not carry (MR-17: pins hold against the acts at definition-at): restore
  // refuses invalid-control.
  const badPinDescriptor = rawDescriptor(
    registrationFields([ent(root)], [p("Plant")]).map(
      ([k, v]): readonly [string, Target | readonly Target[]] =>
        k === "hyperschema-pin" ? [k, p(authorityRoot)] : [k, v],
    ),
  );
  const fernBadPin: EntryFields = {
    ...fern,
    registration: badPinDescriptor,
    hyperPin: authorityRoot,
  };
  const tBadPin = stateX(1, "", "", "install", fernBadPin);
  const cBadPin = imageX(
    1,
    [{ ...fernBadPin, status: "active", transition: tBadPin.id }],
    [badPinDescriptor, ...defs, s.capture, authority, tBadPin],
  );
  step(
    "restore_bad_hyperschema_pin",
    restoreQ(revisionOf(cBadPin, 1)),
    [restoreQ(revisionOf(cBadPin, 1))],
    [cBadPin, 1],
    refusal("invalid-control"),
  );
  // A stored capture whose basis carries only the three commitment fields is not a complete
  // MR-10 basis (MR-17): restore refuses invalid-control even though revision, binding and
  // authority agree with the entry.
  const truncatedCapture = description(
    "capture/1",
    [
      ["source-binding", ref(binding.id)],
      ["authority", ref(authority.id)],
      [
        "basis",
        blob(
          encode(
            map([
              ["format", tstr("rhizomatic.source-basis/1")],
              ["binding", tstr(binding.id)],
              ["authority", tstr(authority.id)],
              ["revision", tstr(s.revision)],
            ]),
          ),
        ),
      ],
    ],
    seeds.capturer,
    1000,
  );
  const fernTruncated: EntryFields = { ...fern, capture: truncatedCapture.id };
  const tTruncated = stateX(1, "", "", "install", fernTruncated);
  const cTruncated = imageX(
    1,
    [{ ...fernTruncated, status: "active", transition: tTruncated.id }],
    [descriptor, ...defs, truncatedCapture, authority, tTruncated],
  );
  step(
    "restore_truncated_capture_basis",
    restoreQ(revisionOf(cTruncated, 1)),
    [restoreQ(revisionOf(cTruncated, 1))],
    [cTruncated, 1],
    refusal("invalid-control"),
  );
  // ---- Review round 3: shared counterexamples for the findings on 25a1c22. Each step stores
  // a capture whose basis keeps the fixture's revision but breaks one MR-10 invariant the
  // stage-5 reader can check without the operand bytes: restore refuses invalid-control.
  const basisBytesOf = (capture: Delta) => {
    const t = capture.claims.pointers.find((x) => x.role === prefix + "basis")?.target;
    if (t?.kind !== "bytes") throw Error();
    return t.value;
  };
  const captureWith = (basis: CborValue) =>
    description(
      "capture/1",
      [
        ["source-binding", ref(binding.id)],
        ["authority", ref(authority.id)],
        ["basis", blob(encode(basis))],
      ],
      seeds.capturer,
      1000,
    );
  const patchOperand = (basis: CborValue, key: string, data: CborValue): CborValue => {
    const operands = field(basis, "operands");
    if (operands.t !== "array" || operands.v[0]?.t !== "map") throw Error();
    return update(
      basis,
      "operands",
      array([update(operands.v[0], key, data), ...operands.v.slice(1)]),
    );
  };
  const restoreWithCapture = (id: string, capture: Delta) => {
    const entry: EntryFields = { ...fern, capture: capture.id };
    const t = stateX(1, "", "", "install", entry);
    const c = imageX(
      1,
      [{ ...entry, status: "active", transition: t.id }],
      [descriptor, ...defs, capture, authority, t],
    );
    step(
      id,
      restoreQ(revisionOf(c, 1)),
      [restoreQ(revisionOf(c, 1))],
      [c, 1],
      refusal("invalid-control"),
    );
  };
  const storedBasis = decode(basisBytesOf(s.capture));
  // The basis names an observation the capture's signed claims do not (timestamp and validFrom
  // stay at 1000); the revision is unchanged because the observation is outside its hash.
  restoreWithCapture(
    "restore_capture_observation_mismatch",
    captureWith(update(storedBasis, "servingAt", float(9999))),
  );
  // The operand names a contributing peer the components table does not carry.
  restoreWithCapture(
    "restore_capture_foreign_peer",
    captureWith(patchOperand(storedBasis, "peers", array([tstr(keys.caller!)]))),
  );
  // The operand names an appearance key the appearance digest does not hash.
  restoreWithCapture(
    "restore_capture_wrong_appearance",
    captureWith(patchOperand(storedBasis, "appearance", tstr(authorityRoot))),
  );

  // ---- Slice C3a: validity boundaries, shared-basis limits, strict-control hostile images and
  // the unrelated-binding variant. Bodies still come from the batch oracle encoders; a local
  // oracle builds gather and resolve bodies for a source and a selected row set at `at`.
  const propOf = new Map<string, { prop: string; value: CborValue }>([
    [a.id, { prop: "height", value: float(42) }],
    [t.id, { prop: "tag", value: array([tstr("shade")]) }],
    [
      x.id,
      {
        prop: "payload",
        value: map([
          ["mime", tstr("application/octet-stream")],
          ["value", bstr(hex("00ff01"))],
        ]),
      },
    ],
  ]);
  const row = (
    rootId: string,
    prop: string,
    value: Target,
    cbor: CborValue,
    timestamp: number,
    validFrom = 0,
    validUntil?: number,
  ) => {
    const d = signClaims(
      {
        author: keys.peer!,
        timestamp,
        validFrom,
        ...(validUntil === undefined ? {} : { validUntil }),
        pointers: [
          { role: "subject", target: { kind: "entity", entity: { id: rootId, context: prop } } },
          { role: "value", target: value },
        ],
      },
      seeds.peer,
    );
    propOf.set(d.id, { prop, value: cbor });
    return d;
  };
  const oracleOf = (
    src: ReturnType<typeof source>,
    selected: Delta[],
    at: number,
    rootId = root,
  ) => {
    const q = request(
      src,
      config,
      at,
      1000,
      hyper,
      schema,
      termHash(term),
      schemaHash(reading),
      [],
      rootId,
    );
    const view: HView = {
      id: rootId,
      props: new Map(selected.map((d) => [propOf.get(d.id)!.prop, [{ delta: d, negated: false }]])),
    };
    const gather = gatherBody(src, q, view, at);
    if (gather.t !== "map") throw Error();
    const value = encode(
      map(selected.map((d) => [propOf.get(d.id)!.prop, propOf.get(d.id)!.value])),
    );
    const resolve = map([
      ["kind", tstr("resolve")],
      ...gather.v.filter(([k]) => ["root", "basis", "transport", "hview"].includes(k)),
      ["value", bstr(value)],
      ["view", tstr(contentAddress(value))],
    ]);
    return { gather, resolve, result: rootResultFrom(gather, resolve, rootId) };
  };
  const bootFor = (cfg: Delta) => ({
    boot: cfg,
    bootOverride: {
      configuration: serializeCommandDelta(cfg),
      declarations: operationsB.map(serializeCommandDelta),
      bindings: [serializeCommandDelta(binding)],
    },
  });
  const installIn = (
    cfg: Delta,
    control: string,
    registration: Delta,
    src: ReturnType<typeof source>,
    at = 1000,
  ) =>
    requestFor(cfg, "install", [
      ["expected-control", p(control)],
      ["registration", ref(registration.id)],
      ["capture", ref(src.capture.id)],
      ["snapshot", ref(src.snapshot.id)],
      ["at", p(at)],
      ["serving-at", p(1000)],
    ]);
  const readIn = (
    cfg: Delta,
    control: string,
    registration: Delta,
    src: ReturnType<typeof source>,
  ) =>
    requestFor(cfg, "read", [
      ["expected-control", p(control)],
      ["registration", ref(registration.id)],
      ["expected-source", p(src.revision)],
      ["snapshot", ref(src.snapshot.id)],
      ["serving-at", p(1000)],
    ]);
  const replaceIn = (
    cfg: Delta,
    control: string,
    registration: Delta,
    src: ReturnType<typeof source>,
  ) =>
    requestFor(cfg, "replace-source", [
      ["expected-control", p(control)],
      ["registration", ref(registration.id)],
      ["expected-source", p(src.revision)],
      ["capture", ref(src.capture.id)],
      ["snapshot", ref(src.snapshot.id)],
      ["serving-at", p(1000)],
    ]);
  const advanceIn = (
    cfg: Delta,
    control: string,
    registration: Delta,
    src: ReturnType<typeof source>,
    at: number,
  ) =>
    requestFor(cfg, "advance-time", [
      ["expected-control", p(control)],
      ["registration", ref(registration.id)],
      ["expected-source", p(src.revision)],
      ["snapshot", ref(src.snapshot.id)],
      ["at", p(at)],
      ["serving-at", p(1000)],
    ]);

  // C3a-1: validity boundaries (ctl_validity_advance). The height fact is valid on [100, 200);
  // install at 99, then advance through 100, 199, 200 and the future 2100; a decrease is
  // time-regression with no write; an expired descriptor refuses invalid-definition at a later
  // serving time with the selection unchanged.
  const aBounded = row(root, "height", p(42), float(42), 10, 100, 200);
  const sV = source([aBounded, t, x]);
  const fernV: EntryFields = { ...fern, revision: sV.revision, capture: sV.capture.id, at: 99 };
  const tV1 = stateX(1, "", "", "install", fernV);
  const cV1 = imageX(
    1,
    [{ ...fernV, status: "active", transition: tV1.id }],
    [descriptor, ...defs, sV.capture, authority, tV1],
  );
  const oV99 = oracleOf(sV, [t, x], 99);
  step(
    "validity_install_at_99",
    installX("", descriptor, sV, 99),
    [installX("", descriptor, sV, 99), descriptor, sV.capture, sV.snapshot, authority, ...defs],
    [c0, 0],
    completed(
      transitionX("install", descriptor, tV1, revisionOf(cV1, 1), 1, basisFrom(oV99.gather, 99), [
        oV99.result,
      ]),
      cV1,
    ),
    { source: sourceOf(sV) },
  );
  let validity = { c: cV1, t: tV1, entry: fernV, generation: 1 };
  for (const [at, selected] of [
    [100, [aBounded, t, x]],
    [199, [aBounded, t, x]],
    [200, [t, x]],
    [2100, [t, x]],
  ] as const) {
    const prev = validity,
      generation = prev.generation + 1,
      entry: EntryFields = { ...prev.entry, at },
      tN = stateX(
        generation,
        revisionOf(prev.c, prev.generation),
        prev.t.id,
        "advance-time",
        entry,
      ),
      cN = imageX(
        generation,
        [{ ...entry, status: "active", transition: tN.id }],
        [descriptor, ...defs, sV.capture, authority, tN],
      ),
      o = oracleOf(sV, [...selected], at),
      q = advanceIn(configB, revisionOf(prev.c, prev.generation), descriptor, sV, at);
    step(
      "validity_advance_" + at,
      q,
      [q, sV.snapshot],
      [prev.c, prev.generation],
      completed(
        transitionX(
          "advance-time",
          descriptor,
          tN,
          revisionOf(cN, generation),
          generation,
          basisFrom(o.gather, at),
          [o.result],
        ),
        cN,
      ),
      { source: sourceOf(sV) },
    );
    validity = { c: cN, t: tN, entry, generation };
  }
  {
    const q = advanceIn(configB, revisionOf(validity.c, validity.generation), descriptor, sV, 150);
    step(
      "validity_regression_150",
      q,
      [q, sV.snapshot],
      [validity.c, validity.generation],
      refusal("time-regression"),
      {
        source: sourceOf(sV),
      },
    );
  }
  {
    const readLate = requestX("read", rE, descriptorExpiring, [
      ["expected-source", p(s.revision)],
      ["snapshot", ref(s.snapshot.id)],
      ["serving-at", p(1500)],
    ]);
    step(
      "read_expired_descriptor",
      readLate,
      [readLate, s.snapshot],
      [cE, 1],
      refusal("invalid-definition"),
      {
        receivedAt: 1500,
      },
    );
    const advanceLate = requestX("advance-time", rE, descriptorExpiring, [
      ["expected-source", p(s.revision)],
      ["snapshot", ref(s.snapshot.id)],
      ["at", p(1500)],
      ["serving-at", p(1500)],
    ]);
    step(
      "advance_expired_descriptor",
      advanceLate,
      [advanceLate, s.snapshot],
      [cE, 1],
      refusal("invalid-definition"),
      {
        receivedAt: 1500,
      },
    );
  }

  // C3a-2: shared-basis limits (ctl_shared_basis_limits). One fact per root; the per-envelope
  // entries and nodes counters are lowered to 1 so each root envelope fits while the totals do
  // not. The aggregate body limit then sits below the 64-root body and above every other
  // artifact; the image limit sits below a fat-alias descriptor's image and above its body.
  const roots64 = Array.from({ length: 64 }, (_, i) => `item:r${String(i).padStart(2, "0")}`);
  const bigPayload = (i: number) =>
    Uint8Array.from({ length: 2048 }, (_, j) => (i * 31 + j) & 0xff);
  const rows64 = roots64.map((r, i) =>
    row(
      r,
      "payload",
      { kind: "bytes", mime: "application/octet-stream", value: bigPayload(i) },
      map([
        ["mime", tstr("application/octet-stream")],
        ["value", bstr(bigPayload(i))],
      ]),
      10 + i,
    ),
  );
  const s64 = source(rows64);
  const d64 = description(
    "registration/1",
    registrationFields(roots64.map(ent), [p("Plant64")]),
    seeds.definition,
    0,
  );
  const mossOne = row("item:moss", "height", p(7), float(7), 11);
  const s2 = source([a, mossOne]);
  const d2 = description(
    "registration/1",
    registrationFields([ent(root), ent("item:moss")], [p("PlantTwo")]),
    seeds.definition,
    0,
  );
  const configCounters = endpointFor([keys.caller!], [keys.caller!], {
    ...limits,
    entries: 1,
    nodes: 1,
  });
  const multi = (
    cfg: Delta,
    registration: Delta,
    src: ReturnType<typeof source>,
    rootsSel: (readonly [string, Delta[]])[],
  ) => {
    const oracles = rootsSel.map(([r, sel]) => oracleOf(src, sel, 1000, r));
    const entry: EntryFields = {
      registration,
      revision: src.revision,
      authority: authority.id,
      at: 1000,
      definitionAt: 1000,
      ...pins,
      capture: src.capture.id,
    };
    const tr = stateX(1, "", "", "install", entry);
    const c = imageX(
      1,
      [{ ...entry, status: "active", transition: tr.id }],
      [registration, ...defs, src.capture, authority, tr],
      cfg,
    );
    return {
      entry,
      t: tr,
      c,
      r: revisionOf(c, 1),
      basis: basisFrom(oracles[0]!.gather, 1000),
      results: oracles.map((o) => o.result),
    };
  };
  const multiSteps = (
    tag: string,
    cfg: Delta,
    registration: Delta,
    src: ReturnType<typeof source>,
    rootsSel: (readonly [string, Delta[]])[],
  ) => {
    const m = multi(cfg, registration, src, rootsSel);
    const install = installIn(cfg, "", registration, src),
      read = readIn(cfg, m.r, registration, src);
    step(
      "limits_install_" + tag,
      install,
      [install, registration, src.capture, src.snapshot, authority, ...defs],
      [imageX(0, [], [], cfg), 0],
      completed(transitionX("install", registration, m.t, m.r, 1, m.basis, m.results), m.c),
      { source: sourceOf(src), ...bootFor(cfg) },
    );
    step(
      "limits_read_" + tag,
      read,
      [read, src.snapshot],
      [m.c, 1],
      completed(readBodyX(registration, m.r, 1, m.basis, m.results), m.c),
      { source: sourceOf(src), ...bootFor(cfg) },
    );
    return m;
  };
  multiSteps("two_roots", configCounters, d2, s2, [
    [root, [a]],
    ["item:moss", [mossOne]],
  ]);
  const m64 = multiSteps(
    "64_roots",
    configCounters,
    d64,
    s64,
    roots64.map((r, i) => [r, [rows64[i]!]] as const),
  );
  const bodyBytes64 = encode(
    transitionX("install", d64, m64.t, m64.r, 1, m64.basis, m64.results),
  ).length;
  const largestOther64 = Math.max(
    s64.payload.length,
    appearance(s64.capture).length,
    appearance(d64).length,
    m64.c.length,
    ...m64.results.map((res) => {
      const env = field(res, "envelope");
      return env.t === "bstr" ? env.v.length : 0;
    }),
  );
  if (bodyBytes64 - 1 <= largestOther64) throw Error("aggregate body limit is not separable");
  const configBody = endpointFor([keys.caller!], [keys.caller!], {
    ...limits,
    entries: 1,
    nodes: 1,
    artifactBytes: bodyBytes64 - 1,
  });
  const m64B = multi(
    configBody,
    d64,
    s64,
    roots64.map((r, i) => [r, [rows64[i]!]] as const),
  );
  {
    const install = installIn(configBody, "", d64, s64);
    step(
      "limits_install_64_roots_over_body_bytes",
      install,
      [install, d64, s64.capture, s64.snapshot, authority, ...defs],
      [imageX(0, [], [], configBody), 0],
      refusal("resource-limit"),
      { source: sourceOf(s64), ...bootFor(configBody) },
    );
    const replace = replaceIn(configBody, m64B.r, d64, s64);
    step(
      "limits_replace_64_roots_over_body_bytes",
      replace,
      [replace, s64.capture, s64.snapshot, authority],
      [m64B.c, 1],
      refusal("resource-limit"),
      { source: sourceOf(s64), ...bootFor(configBody) },
    );
    const advance = advanceIn(configBody, m64B.r, d64, s64, 1001);
    step(
      "limits_advance_64_roots_over_body_bytes",
      advance,
      [advance, s64.snapshot],
      [m64B.c, 1],
      refusal("resource-limit"),
      { source: sourceOf(s64), ...bootFor(configBody) },
    );
  }
  const fatAliases = Array.from({ length: 200 }, (_, i) =>
    p("alias-" + String(i).padStart(3, "0") + "-" + "x".repeat(1000)),
  );
  const dFat = description(
    "registration/1",
    registrationFields([ent(root)], fatAliases),
    seeds.definition,
    0,
  );
  const fat: EntryFields = { ...fern, registration: dFat };
  const tFat = stateX(1, "", "", "install", fat);
  const imageBytesFat = imageX(
    1,
    [{ ...fat, status: "active", transition: tFat.id }],
    [dFat, ...defs, s.capture, authority, tFat],
  ).length;
  const largestOtherFat = Math.max(
    appearance(dFat).length,
    s.payload.length,
    encode(
      transitionX("install", dFat, tFat, "", 1, basisOf("plant", 1000), [rootResultOf("plant")]),
    ).length,
  );
  if (imageBytesFat - 1 <= largestOtherFat) throw Error("image limit is not separable");
  const configImage = endpointFor([keys.caller!], [keys.caller!], {
    ...limits,
    artifactBytes: imageBytesFat - 1,
  });
  {
    const install = installIn(configImage, "", dFat, s);
    step(
      "limits_install_fat_descriptor_over_image_bytes",
      install,
      [install, dFat, s.capture, s.snapshot, authority, ...defs],
      [imageX(0, [], [], configImage), 0],
      refusal("resource-limit"),
      bootFor(configImage),
    );
  }

  // C3a-3: strict control (ctl_control_strict). Signed images that are structurally wrong in
  // one way each refuse invalid-control at stage 5; the unknown snapshot key waits for stage 6.
  const cUnreachable = imageX(1, [fernEntry], [descriptor, ...defs, s.capture, authority, t1, n1]);
  step(
    "restore_unreachable_support",
    restoreQ(revisionOf(cUnreachable, 1)),
    [restoreQ(revisionOf(cUnreachable, 1))],
    [cUnreachable, 1],
    refusal("invalid-control"),
  );
  const cRetiredExtra = imageX(4, [retiredFern], [t4, descriptor]);
  step(
    "restore_retired_with_old_support",
    restoreQ(revisionOf(cRetiredExtra, 4)),
    [restoreQ(revisionOf(cRetiredExtra, 4))],
    [cRetiredExtra, 4],
    refusal("invalid-control"),
  );
  const cRetiredScalars = imageX(4, [{ ...retiredFern, hyperPin: authorityRoot }], [t4]);
  step(
    "restore_retired_changed_scalars",
    restoreQ(revisionOf(cRetiredScalars, 4)),
    [restoreQ(revisionOf(cRetiredScalars, 4))],
    [cRetiredScalars, 4],
    refusal("invalid-control"),
  );
  // A hand-signed authority whose validUntil does not follow its validFrom (both 0): the L0
  // signer refuses to produce it, so the claims are encoded and signed with the primitives.
  const badAuthorityClaims = { ...authority.claims, validUntil: 0 };
  const badAuthorityBytes = encode(claimsToCbor(badAuthorityClaims));
  const badAuthorityId = contentAddress(badAuthorityBytes);
  const badAuthority: Delta = {
    id: badAuthorityId,
    claims: badAuthorityClaims,
    sig: bytesToHex(ed25519.sign(hexToBytes(badAuthorityId), hexToBytes(seeds.capturer!))),
  };
  const badAuthorityAppearance = encode(
    map([
      ["id", tstr(badAuthorityId)],
      ["claims", bstr(badAuthorityBytes)],
      ["sig", bstr(hex(badAuthority.sig!))],
    ]),
  );
  const sBad = source([a, t, x], 1000, badAuthority);
  const fernBad: EntryFields = {
    ...fern,
    revision: sBad.revision,
    authority: badAuthority.id,
    capture: sBad.capture.id,
  };
  const tBad = stateX(1, "", "", "install", fernBad);
  const imageRaw = (generation: number, entries: EntryX[], support: Uint8Array[]) =>
    encode(
      map([
        ["format", tstr("rhizomatic.materialization-control/1")],
        ["receiver", tstr(keys.receiver!)],
        ["configuration", tstr(configB.id)],
        ["generation", float(generation)],
        ["entries", array(sortedEntries(entries).map(entryX))],
        [
          "deltas",
          array(
            [...new Map(support.map((b) => [contentAddress(b), b])).entries()]
              .sort(([ka], [kb]) => (ka < kb ? -1 : ka > kb ? 1 : 0))
              .map(([, b]) => bstr(b)),
          ),
        ],
      ]),
    );
  const cBadAuthority = imageRaw(
    1,
    [{ ...fernBad, status: "active", transition: tBad.id }],
    [...[descriptor, ...defs, sBad.capture, tBad].map(appearance), badAuthorityAppearance],
  );
  step(
    "restore_malformed_authority_interval",
    restoreQ(revisionOf(cBadAuthority, 1)),
    [restoreQ(revisionOf(cBadAuthority, 1))],
    [cBadAuthority, 1],
    refusal("invalid-control"),
  );
  const payloadExtra = (() => {
    const v = decode(s.payload);
    if (v.t !== "map") throw Error();
    return encode(map([...v.v, ["zz-unknown", tstr("x")]]));
  })();
  const snapshotExtra = description(
    "snapshot/1",
    [["data", blob(payloadExtra)]],
    seeds.capturer,
    1000,
  );
  const readExtra = (control: string) =>
    requestX("read", control, descriptor, [
      ["expected-source", p(s.revision)],
      ["snapshot", ref(snapshotExtra.id)],
      ["serving-at", p(1000)],
    ]);
  step(
    "read_snapshot_unknown_key_wrong_control",
    readExtra(authorityRoot),
    [readExtra(authorityRoot), snapshotExtra],
    [c1, 1],
    refusal("precondition-failed"),
  );
  step(
    "read_snapshot_unknown_key",
    readExtra(r1),
    [readExtra(r1), snapshotExtra],
    [c1, 1],
    refusal("invalid-source"),
  );

  // C3a-4: an expired boot binding the descriptor does not use never blocks retire or restore
  // (cmd_error_priority::retire-restore-unrelated-binding).
  const unrelatedExpiredBinding = signClaims(
    {
      ...description(
        "source-binding/1",
        [
          ["receiver", ent(keys.receiver!)],
          [
            "spec",
            blob(
              encode(
                map([
                  ["sourceId", tstr("secondary")],
                  ["capturer", tstr(keys.capturer!)],
                  ["authorityRoot", tstr(authorityRoot)],
                  ["selection", selection],
                ]),
              ),
            ),
          ],
        ],
        seeds.receiver,
        0,
      ).claims,
      validUntil: 500,
    },
    seeds.receiver,
  );
  // The configuration selects both bindings; the descriptor uses only the first.
  const configTwoBindings = description(
    "endpoint/1",
    [
      ["receiver", ent(keys.receiver!)],
      ["caller", p(keys.caller!)],
      ["administrator", p(keys.caller!)],
      [
        "installed",
        operationsB
          .map((o) => o.id)
          .sort()
          .map(ref),
      ],
      ["source-binding", [ref(binding.id), ref(unrelatedExpiredBinding.id)]],
      ["limits", blob(encode(map(Object.entries(limits).map(([k, v]) => [k, float(v)]))))],
    ],
    seeds.receiver,
    0,
  );
  const bootWithUnrelated = {
    boot: configTwoBindings,
    noGrant: true,
    bootOverride: {
      configuration: serializeCommandDelta(configTwoBindings),
      declarations: operationsB.map(serializeCommandDelta),
      bindings: [binding, unrelatedExpiredBinding].map(serializeCommandDelta),
    },
  };
  const tU1 = stateX(1, "", "", "install", fern);
  const cU1 = imageX(
    1,
    [{ ...fern, status: "active", transition: tU1.id }],
    [descriptor, ...defs, s.capture, authority, tU1],
    configTwoBindings,
  );
  const rU1 = revisionOf(cU1, 1);
  const retiredU: EntryFields = { ...fern, capture: undefined };
  const tU2 = stateX(2, rU1, tU1.id, "retire", retiredU);
  const cU2 = imageX(
    2,
    [{ ...retiredU, status: "retired", transition: tU2.id }],
    [tU2],
    configTwoBindings,
  );
  const rU2 = revisionOf(cU2, 2);
  const retireU = requestFor(configTwoBindings, "retire", [
    ["expected-control", p(rU1)],
    ["registration", ref(descriptor.id)],
  ]);
  step(
    "retire_unrelated_expired_binding",
    retireU,
    [retireU],
    [cU1, 1],
    completed(
      map([
        ["kind", tstr("retire")],
        ["registration", tstr(descriptor.id)],
        ["transition", tstr(tU2.id)],
        ["control", tstr(rU2)],
        ["generation", float(2)],
      ]),
      cU2,
    ),
    bootWithUnrelated,
  );
  const restoreU = requestFor(configTwoBindings, "restore", [["expected-control", p(rU2)]]);
  step(
    "restore_unrelated_expired_binding",
    restoreU,
    [restoreU],
    [cU2, 2],
    completed(restoreBodyX(rU2, 2, [{ ...retiredU, status: "retired", transition: tU2.id }]), cU2),
    bootWithUnrelated,
  );
  void byId;
  writeFileSync(
    new URL("../../../vectors/materialization/lifecycle.json", import.meta.url),
    JSON.stringify(
      {
        format: "rhizomatic-materialization-lifecycle-vectors/1",
        oracle:
          "SPEC-16 MR-13..19 maintained schedule assembled by hand: release-B boot, a registration descriptor, receiver-signed state/1 acts, MR-14 control images and MR-19 bodies built from the plant batch oracle with existing L0/syntax encoders only. No control codec, planner, endpoint or store imports.",
        seeds,
        keys,
        boot: {
          configuration: serializeCommandDelta(configB),
          declarations: operationsB.map(serializeCommandDelta),
          bindings: [serializeCommandDelta(binding)],
        },
        source: { binding: binding.id, revision: s.revision, authority: authority.id },
        descriptor: serializeCommandDelta(descriptor),
        rows: [a, t, x].map(serializeCommandDelta),
        steps,
      },
      null,
      2,
    ) + "\n",
  );
}

// Optional measurement artifacts, never committed semantic expectations or alternate command execution.
// All HViews/Views are manually constructed using the same lower crypto/syntax primitives above.
if (process.env.M2_MEASUREMENT_DIR) {
  const directory = process.env.M2_MEASUREMENT_DIR;
  mkdirSync(directory, { recursive: true });
  const save = (fixture: CommandFixture, metadata: Record<string, unknown>) =>
    writeFileSync(
      `${directory}/${fixture.id}.json`,
      JSON.stringify({
        ...metadata,
        fixture: { ...fixture, boot: fixture.boot ?? bootJson(config), seeds },
      }) + "\n",
    );
  for (const count of [0, 128, 1024, 4096, 4097]) {
    const rows = Array.from({ length: count }, (_, n) => fact("height", p(n), n + 1)),
      src = source(rows),
      q = request(src);
    if (count > limits.appearances) {
      save(
        {
          id: `source_${count}`,
          receivedAt: 1000,
          rows: rows.map(serializeCommandDelta),
          source: {
            binding: binding.id,
            revision: src.revision,
            authority: authority.id,
            servingAt: 1000,
            requiredSupport: defs.map((d) => d.id),
          },
          request: serializeCommandDelta(q),
          delivery: sourceDelivery(q, src),
          capture: serializeCommandDelta(src.capture),
          snapshot: serializeCommandDelta(src.snapshot),
          resolve: serializeCommandDelta(q),
          resolveDelivery: [],
          expected: {
            gather: serializeCommandDelta(
              outcome(q, map([["code", tstr("resource-limit")]]), "refused"),
            ),
            gatherBodyHex: "",
            resolve: serializeCommandDelta(q),
            resolveBodyHex: "",
            valueHex: "",
          },
        },
        {
          selectedAppearances: count,
          expectedStatus: "refused",
          reason: "complete snapshot appearance count at stage6; no filtering/truncation",
        },
      );
    } else {
      positive(
        `source_${count}`,
        src,
        q,
        {
          id: root,
          props: count
            ? new Map([
                [
                  "height",
                  rows
                    .slice()
                    .sort((a, b) => (a.id < b.id ? -1 : 1))
                    .map((delta) => ({ delta, negated: false })),
                ],
              ])
            : new Map(),
        },
        standardProgram,
        { rows, value: count ? map([["height", float(count - 1)]]) : map([]) },
      );
      save(positives[positives.length - 1]!, {
        selectedAppearances: count,
        expectedStatus: "completed",
      });
    }
  }
  const leafTerm: Term = {
      kind: "group",
      key: { kind: "byTargetContext" },
      of: { kind: "select", pred: { kind: "false" }, of: { kind: "input" } },
    },
    leafDef = definition("hyper", termCanonicalHex(leafTerm), "EmptyLeafBench"),
    leafReading: Schema = {
      name: "EmptyLeafBench",
      alg: 1,
      props: new Map(),
      default: { kind: "pick", order: { kind: "lexById" } },
    },
    leafSchema = definition("reading", schemaCanonicalHex(leafReading), "EmptyLeafBench");
  const plantTerm: Term = {
      kind: "expand",
      role: { kind: "exact", value: "value" },
      schema: { kind: "name", name: "EmptyLeafBench" },
      reading: { kind: "name", name: "EmptyLeafBench" },
      of: term,
    },
    plantDef = definition("hyper", termCanonicalHex(plantTerm), "PlantBench"),
    plantReading: Schema = {
      name: "PlantBench",
      alg: 1,
      props: new Map(),
      default: { kind: "pick", order: { kind: "lexById" } },
    },
    plantSchema = definition("reading", schemaCanonicalHex(plantReading), "PlantBench");
  const bedTerm: Term = {
      kind: "expand",
      role: { kind: "exact", value: "value" },
      schema: { kind: "name", name: "PlantBench" },
      reading: { kind: "name", name: "PlantBench" },
      of: term,
    },
    bedDef = definition("hyper", termCanonicalHex(bedTerm), "BedBench"),
    bedReading: Schema = {
      name: "BedBench",
      alg: 1,
      props: new Map(),
      default: { kind: "pick", order: { kind: "lexById" } },
    },
    bedSchema = definition("reading", schemaCanonicalHex(bedReading), "BedBench");
  const facts: Delta[] = [],
    children: HView[] = [],
    childValues: CborValue[] = [];
  for (let n = 0; n < 32; n++) {
    const id = `plant:${n}`,
      leaf = `leaf:${n}`,
      props = new Map<
        string,
        {
          delta: Delta;
          negated: boolean;
          expanded?: Map<number, HView>;
          readings?: Map<number, Schema>;
        }[]
      >();
    for (const [name, target] of [
      ["height", p(n)],
      ["tag", p(`tag:${n}`)],
      [
        "payload",
        { kind: "bytes", mime: "application/octet-stream", value: hex("00ff01") } as Target,
      ],
      ["leaf", ent(leaf)],
    ] as const) {
      const delta = signClaims(
        {
          author: keys.peer!,
          timestamp: 10,
          validFrom: 0,
          pointers: [
            { role: "subject", target: { kind: "entity", entity: { id, context: name } } },
            { role: "value", target },
          ],
        },
        seeds.peer,
      );
      facts.push(delta);
      props.set(name, [
        name === "leaf"
          ? {
              delta,
              negated: false,
              expanded: new Map([[1, { id: leaf, props: new Map() }]]),
              readings: new Map([[1, leafReading]]),
            }
          : { delta, negated: false },
      ]);
    }
    children.push({ id, props });
    childValues.push(
      map([
        ["height", float(n)],
        ["tag", tstr(`tag:${n}`)],
        [
          "payload",
          map([
            ["mime", tstr("application/octet-stream")],
            ["value", bstr(hex("00ff01"))],
          ]),
        ],
        ["leaf", map([])],
      ]),
    );
  }
  const link = signClaims(
      {
        author: keys.peer!,
        timestamp: 10,
        validFrom: 0,
        pointers: [
          {
            role: "subject",
            target: { kind: "entity", entity: { id: "bed:bench", context: "plants" } },
          },
          ...children.map((child) => ({ role: "value", target: ent(child.id) })),
        ],
      },
      seeds.peer,
    ),
    rows = [link, ...facts],
    src = source(rows),
    ds = [bedDef, bedSchema, plantDef, plantSchema, leafDef, leafSchema].sort((a, b) =>
      a.id < b.id ? -1 : 1,
    ),
    q = request(
      src,
      config,
      1000,
      1000,
      bedDef,
      bedSchema,
      termHash(bedTerm),
      schemaHash(bedReading),
      ds.filter((d) => d.id !== bedDef.id && d.id !== bedSchema.id),
      "bed:bench",
    );
  positive(
    "bed_32x4_two_levels",
    src,
    q,
    {
      id: "bed:bench",
      props: new Map([
        [
          "plants",
          [
            {
              delta: link,
              negated: false,
              expanded: new Map(children.map((h, n) => [n + 1, h])),
              readings: new Map(children.map((_, n) => [n + 1, plantReading])),
            },
          ],
        ],
      ]),
    },
    {
      hyper: bedDef,
      schema: bedSchema,
      hyperPin: termHash(bedTerm),
      schemaPin: schemaHash(bedReading),
      definitions: ds,
      bindings: C_EMPTY,
    },
    { rows, value: map([["plants", map([["value", array(childValues)]])]]) },
  );
  save(positives[positives.length - 1]!, {
    selectedAppearances: 129,
    signedFacts: 128,
    bedLinkAppearances: 1,
    plants: 32,
    bucketsPerPlant: 4,
    expansionLevels: 2,
    expectedStatus: "completed",
  });
}
