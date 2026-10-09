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
import { canonicalBytes } from "../src/delta/delta.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
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
