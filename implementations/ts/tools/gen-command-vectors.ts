import { writeFileSync } from "node:fs";
import { encode, map, tstr, bstr, float, array, bool, type CborValue } from "../src/delta/cbor.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import { claimsToJson } from "../src/delta/json-profile.js";
import { canonicalHex } from "../src/delta/delta.js";
import { bytesToHex } from "../src/delta/hash.js";
import type { Target, Delta } from "../src/delta/types.js";
const seed = "01".repeat(32),
  receiver = authorForSeed(seed),
  id = "1e20" + "11".repeat(32),
  id2 = "1e20" + "22".repeat(32);
const text = (value: string): Target => ({ kind: "primitive", value }),
  ref = (delta: string): Target => ({ kind: "delta", deltaRef: { delta } }),
  entity = (id: string): Target => ({ kind: "entity", entity: { id } }),
  num = (value: number): Target => ({ kind: "primitive", value }),
  bytes = (value: Uint8Array): Target => ({ kind: "bytes", mime: "application/cbor", value });
function act(fields: readonly (readonly [string, Target])[]): Delta {
  return signClaims(
    {
      timestamp: 10,
      validFrom: 10,
      author: receiver,
      pointers: fields.map(([r, target]) => ({ role: "rhizomatic.command." + r, target })),
    },
    seed,
  );
}
const debug = (d: Delta) => ({ id: d.id, claims: claimsToJson(d.claims), sig: d.sig });
const cases: unknown[] = [];
const view = (name: string, value: CborValue, expected: unknown, scenario = "view_all_sorts") => {
  const hex = bytesToHex(encode(value));
  cases.push({
    id: name,
    scenario,
    kind: "view",
    input: hex,
    expected: { valid: true, canonicalHex: hex, view: expected },
    oracle: "Authored View tree independently determines CBOR sorts and reconstructed value.",
  });
};
view(
  "view-nested",
  map([
    ["array", array([tstr("hello"), float(-0), bool(false), map([]), array([])])],
    [
      "bytes",
      map([
        ["mime", tstr("application/octet-stream")],
        ["value", bstr(new Uint8Array([0, 255]))],
      ]),
    ],
  ]),
  { array: ["hello", 0, false, {}, []], bytes: { mime: "application/octet-stream", value: "AP8" } },
);
view(
  "ordinary-bytes-looking-object",
  map([
    ["mime", tstr("text/plain")],
    ["value", tstr("plain text")],
  ]),
  { mime: "text/plain", value: "plain text" },
  "view_object_bytes_distinction",
);
view(
  "reserved-keys",
  map([
    ["__proto__", tstr("safe")],
    ["constructor", bool(true)],
  ]),
  { ["__proto__"]: "safe", constructor: true },
);
for (const [name, hex] of [
  ["null", "f6"],
  ["integer", "01"],
  ["bare-bytes", "4100"],
  ["duplicate-key", "a26161f46161f5"],
  ["noncanonical-float", "fb3ff0000000000000"],
  ["nan", "f97e00"],
  ["bad-bytes-leaf", "a16576616c75654100"],
  ["extra-bytes-leaf", "a3617800646d696d6561786576616c75654100"],
])
  cases.push({
    id: "view-invalid-" + name,
    scenario: "view_malformed",
    kind: "view",
    input: hex,
    expected: { valid: false },
    oracle: "Not canonical View: " + name,
  });
const bindings = map([
  ["enabled", bool(true)],
  ["limit", float(2)],
  ["name", tstr("x")],
]);
cases.push({
  id: "bindings-valid",
  scenario: "bindings_strict",
  kind: "bindings",
  input: bytesToHex(encode(bindings)),
  expected: {
    valid: true,
    canonicalHex: bytesToHex(encode(bindings)),
    bindings: { enabled: true, limit: 2, name: "x" },
  },
  oracle: "Primitive bindings exclude root overrides.",
});
for (const [name, item] of [
  ["root", map([["root", tstr("x")]])],
  ["nested", map([["x", array([])]])],
] as const)
  cases.push({
    id: "bindings-invalid-" + name,
    scenario: "bindings_strict",
    kind: "bindings",
    input: bytesToHex(encode(item)),
    expected: { valid: false },
    oracle: "Bindings exclude root overrides and nonprimitive values.",
  });
const descriptions: [string, readonly (readonly [string, Target])[], string?][] = [
  [
    "configuration",
    [
      ["kind", text("endpoint/1")],
      ["receiver", entity(receiver)],
      ["caller", text(receiver)],
      ["installed", ref(id)],
      ["installed", ref(id2)],
      ["quota", num(9)],
      ["max-deltas", num(20)],
      ["max-bytes", num(100000)],
    ],
  ],
  [
    "operation",
    [
      ["kind", text("operation/1")],
      ["name", entity("rhizomatic.command.retain")],
      ["interpreter", text("rhizomatic.command.retain/1")],
      ["input-contract", text("rhizomatic.command.retain/1")],
      ["output-contract", text("rhizomatic.command.outcome/1")],
      ["effect", text("admission")],
      ["replay", text("re-evaluate/1")],
      ["dependencies", text("explicit-support/1")],
    ],
  ],
  [
    "request",
    [
      ["kind", text("request/1")],
      ["receiver", entity(receiver)],
      ["configuration", ref(id)],
      ["operation", ref(id2)],
      ["expected-head", text("")],
      ["payload", ref(id)],
    ],
    "retain",
  ],
  [
    "outcome",
    [
      ["kind", text("outcome/1")],
      ["receiver", entity(receiver)],
      ["configuration", ref(id)],
      ["request", ref(id2)],
      ["status", text("refused")],
      ["result", bytes(encode(map([["code", tstr("unauthorized")]])))],
    ],
  ],
];
descriptions.push(
  [
    "operation",
    descriptions[1]![1].map(
      ([k, t]) =>
        [
          k,
          k === "name"
            ? entity("rhizomatic.command.evaluate")
            : k === "interpreter" || k === "input-contract"
              ? text("rhizomatic.command.evaluate/1")
              : k === "effect"
                ? text("none")
                : t,
        ] as const,
    ),
  ],
  [
    "request",
    [
      ["kind", text("request/1")],
      ["receiver", entity(receiver)],
      ["configuration", ref(id)],
      ["operation", ref(id2)],
      ["source", text("catalog")],
      ["root", entity("root")],
      ["at", num(10)],
      ["interpretation", text("core/1")],
      ["hyperschema", ref(id)],
      ["hyperschema-pin", text(id)],
      ["schema", ref(id2)],
      ["schema-pin", text(id2)],
      ["bindings", bytes(encode(map([])))],
    ],
    "evaluate",
  ],
);
const outcomeFields = descriptions[3]![1];
for (const [status, body] of [
  ["indeterminate", map([["code", tstr("commit-unconfirmed")]])],
  [
    "completed",
    map([
      ["kind", tstr("retain")],
      ["beforeHead", tstr("")],
      ["head", tstr(id)],
      ["beforeDigest", tstr(id)],
      ["digest", tstr(id2)],
      ["admitted", array([tstr(id)])],
      ["duplicate", array([tstr(id2)])],
    ]),
  ],
  ...["catalog", "admitted"].map(
    (source) =>
      [
        "completed",
        map([
          ["kind", tstr("evaluate")],
          ["source", tstr(source)],
          ["digest", tstr(id)],
          ["definitionDigest", tstr(id2)],
          ["at", float(10)],
          ["interpretation", tstr("core/1")],
          ["hyperschemaPin", tstr(id)],
          ["schemaPin", tstr(id2)],
          ["value", bstr(encode(map([["hello", tstr("world")]])))],
          ...(source === "admitted" ? [["head", tstr(id)] as const] : []),
        ]),
      ] as const,
  ),
] as readonly (readonly [string, CborValue])[])
  descriptions.push([
    "outcome",
    outcomeFields.map(
      ([k, t]) =>
        [k, k === "status" ? text(status) : k === "result" ? bytes(encode(body)) : t] as const,
    ),
  ]);
let descriptionNumber = 0;
for (const [kind, fields, operationKind] of descriptions) {
  const delta = act(fields);
  cases.push({
    id: kind + "-valid-" + descriptionNumber++,
    scenario: "description_roundtrip",
    kind,
    input: debug(delta),
    ...(operationKind ? { operationKind } : {}),
    expected: { valid: true, canonicalHex: canonicalHex(delta.claims) },
    oracle:
      "Directly authored normative table-order claims signed by the existing Delta primitive, not command writer output.",
  });
  if (kind === "request") {
    const invalidFields: [string, readonly (readonly [string, Target])[]][] = [
      ["duplicate-payload", [...fields, ["payload", ref(id)]]],
      [
        "context",
        fields.map(
          ([k, t]) =>
            [
              k,
              k === "receiver"
                ? { kind: "entity", entity: { id: receiver, context: "hidden" } }
                : t,
            ] as const,
        ),
      ],
      ["unknown", [...fields, ["extra", text("x")]]],
    ];
    for (const [name, invalid] of invalidFields)
      cases.push({
        id: "request-invalid-" + operationKind + "-" + name,
        scenario: "strict_argument_shapes",
        kind,
        input: debug(act(invalid)),
        operationKind,
        expected: { valid: false },
        oracle: "Unknown roles, contexts and duplicate arguments are malformed.",
      });
    cases.push({
      id: "writer-table-order-" + operationKind,
      scenario: "canonical_writer_order",
      kind,
      input: debug(delta),
      operationKind,
      expected: { valid: true, canonicalHex: canonicalHex(delta.claims) },
      oracle: "Authored normative common fields precede payload.",
    });
  }
}
for (const body of [
  map([["code", tstr("native arbitrary error")]]),
  map([
    ["code", tstr("unauthorized")],
    ["head", tstr("")],
  ]),
]) {
  const fields = descriptions[3]![1].map(
    ([k, t]) => [k, k === "result" ? bytes(encode(body)) : t] as const,
  );
  cases.push({
    id: "outcome-invalid-" + cases.length,
    scenario: "outcome_body_strict",
    kind: "outcome",
    input: debug(act(fields)),
    expected: { valid: false },
    oracle: "Refusals contain exactly one stable code.",
  });
}
for (const [kind, fields, operationKind] of descriptions) {
  const optional = new Set(["expected-head", "expected-digest", "definition"]);
  for (const key of new Set(fields.map(([k]) => k))) {
    if (!optional.has(key))
      cases.push({
        id: `${kind}-${operationKind ?? "shape"}-missing-${key}-${cases.length}`,
        scenario: kind === "outcome" ? "outcome_body_strict" : "strict_argument_shapes",
        kind,
        input: debug(act(fields.filter(([k]) => k !== key))),
        ...(operationKind ? { operationKind } : {}),
        expected: { valid: false },
        oracle: "Every required role must be present.",
      });
    const selected = fields.find(([k]) => k === key)!;
    cases.push({
      id: `${kind}-duplicate-${key}-${cases.length}`,
      scenario: kind === "outcome" ? "outcome_body_strict" : "strict_argument_shapes",
      kind,
      input: debug(act([...fields, selected])),
      ...(operationKind ? { operationKind } : {}),
      expected: { valid: false },
      oracle: "Singleton roles occur exactly once; set roles cannot repeat a target.",
    });
  }
}
writeFileSync(
  new URL("../../../vectors/command/descriptions.json", import.meta.url),
  JSON.stringify({ format: "rhizomatic-command-vectors/1", seed, cases }, null, 2) + "\n",
);
