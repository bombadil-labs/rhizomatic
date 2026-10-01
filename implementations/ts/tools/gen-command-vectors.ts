import { writeFileSync, readFileSync } from "node:fs";
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
  ["empty-mime", "a2646d696d65606576616c756540"],
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
const catalogFields = descriptions.find(
  ([kind, , op]) => kind === "request" && op === "evaluate",
)![1];
cases.push({
  id: "catalog-expected-head-invalid",
  scenario: "strict_argument_shapes",
  kind: "request",
  operationKind: "evaluate",
  input: debug(act([...catalogFields, ["expected-head", text("")]])),
  expected: { valid: false },
  oracle: "Catalog has no journal head, so expected-head is invalid-arguments even when empty.",
});
for (const [name, changes] of [
  ["validFrom", { validFrom: 9 }],
  ["validUntil", { validUntil: 11 }],
] as const) {
  const outcome = act(descriptions[3]![1]);
  cases.push({
    id: "outcome-claims-" + name,
    scenario: "outcome_body_strict",
    kind: "outcome",
    input: debug(signClaims({ ...outcome.claims, ...changes }, seed)),
    expected: { valid: false },
    oracle: "Outcome testimony must have equal timestamp/validFrom and absent validUntil.",
  });
}
const retainFields = descriptions.find(([kind, , op]) => kind === "request" && op === "retain")![1];
const canonicalMulti = [...retainFields, ["payload", ref(id2)] as const];
const authoredMulti = act(canonicalMulti);
for (const [name, fields] of [
  [
    "repeated-target-reverse",
    [...retainFields.filter(([k]) => k !== "payload"), ["payload", ref(id2)], ["payload", ref(id)]],
  ],
  ["pointer-permutation", [...canonicalMulti].reverse()],
] as readonly (readonly [string, readonly (readonly [string, Target])[]])[])
  cases.push({
    id: "writer-" + name,
    scenario: "canonical_writer_order",
    kind: "request",
    operationKind: "retain",
    input: debug(act(fields)),
    expected: {
      valid: true,
      canonicalHex: canonicalHex(act(fields).claims),
      writerCanonicalHex: canonicalHex(authoredMulti.claims),
    },
    oracle:
      "Reader accepts any pointer order; canonical writer emits table order and sorts distinct payload IDs.",
  });
const reorderedTarget = { deltaRef: { delta: id }, kind: "delta" as const };
cases.push({
  id: "native-target-property-order-duplicate",
  scenario: "strict_argument_shapes",
  kind: "request",
  operationKind: "retain",
  input: debug(act([...retainFields, ["payload", reorderedTarget]])),
  expected: { valid: false },
  oracle: "Duplicate semantic ID is invalid regardless of native target-object key order.",
});
cases.push({
  id: "bindings-duplicate-CBOR-key",
  scenario: "bindings_strict",
  kind: "bindings",
  input: "a26161f46161f5",
  expected: { valid: false },
  oracle: "Duplicate map keys are rejected before canonical reencoding.",
});
cases.push({
  id: "outcome-duplicate-CBOR-key",
  scenario: "outcome_body_strict",
  kind: "outcome",
  input: debug(
    act(
      descriptions[3]![1].map(
        ([k, t]) =>
          [
            k,
            k === "result"
              ? bytes(
                  Uint8Array.from(
                    Buffer.from(
                      "a264636f64656c756e617574686f72697a656464636f64656c756e617574686f72697a6564",
                      "hex",
                    ),
                  ),
                )
              : t,
          ] as const,
      ),
    ),
  ),
  expected: { valid: false },
  oracle: "Duplicate outcome keys are malformed and must refuse without a panic.",
});
writeFileSync(
  new URL("../../../vectors/command/descriptions.json", import.meta.url),
  JSON.stringify({ format: "rhizomatic-command-vectors/1", seed, cases }, null, 2) + "\n",
);

const coverageUrl = new URL("../../../contracts/command/coverage.json", import.meta.url);
const coverage = JSON.parse(readFileSync(coverageUrl, "utf8")) as {
  scenarios: { id: string; milestone: string; tests: string[]; state: string }[];
};
for (const scenario of coverage.scenarios)
  if (scenario.milestone === "M1") {
    scenario.tests = (cases as { id: string; scenario: string }[])
      .filter((c) => c.scenario === scenario.id)
      .map((c) => "command-description-vectors:" + c.id);
    scenario.state = "implemented_unverified";
  }
writeFileSync(coverageUrl, JSON.stringify(coverage, null, 2) + "\n");

const retainOperation = act(descriptions[1]![1]);
const evaluateOperation = act(descriptions[4]![1]);
const operationIds = [retainOperation.id, evaluateOperation.id].sort();
const bootConfiguration = act(
  descriptions[0]![1]
    .filter(([k]) => k !== "installed")
    .flatMap(([k, t]) =>
      k === "quota"
        ? ([
            ["installed", ref(operationIds[0]!)],
            ["installed", ref(operationIds[1]!)],
            [k, t],
          ] as (readonly [string, Target])[])
        : [[k, t]],
    ),
);
const payload = signClaims(
  {
    timestamp: 1,
    validFrom: 1,
    author: receiver,
    pointers: [{ role: "fact", target: text("inert") }],
  },
  seed,
);
const transportRequest = act(
  retainFields.map(
    ([k, t]) =>
      [
        k,
        k === "configuration"
          ? ref(bootConfiguration.id)
          : k === "operation"
            ? ref(retainOperation.id)
            : k === "payload"
              ? ref(payload.id)
              : t,
      ] as const,
  ),
);
const transportOutcome = act(
  descriptions[3]![1].map(
    ([k, t]) =>
      [
        k,
        k === "configuration"
          ? ref(bootConfiguration.id)
          : k === "request"
            ? ref(transportRequest.id)
            : t,
      ] as const,
  ),
);
writeFileSync(
  new URL("../../../vectors/command/transport.json", import.meta.url),
  JSON.stringify(
    {
      format: "rhizomatic-command-transport-vectors/1",
      context: {
        boot: {
          configuration: debug(bootConfiguration),
          declarations: [debug(retainOperation), debug(evaluateOperation)],
        },
        construction: {
          request: { claims: claimsToJson(transportRequest.claims), seed },
          support: [{ claims: claimsToJson(payload.claims), seed }],
        },
      },
      expectedArtifact: {
        format: "rhizomatic-command-artifact/1",
        entryId: transportRequest.id,
        deltas: [debug(transportRequest), debug(payload)],
      },
      outcome: debug(transportOutcome),
      expectedResult: {
        status: "refused",
        bodyHex: bytesToHex(encode(map([["code", tstr("unauthorized")]]))),
      },
    },
    null,
    2,
  ) + "\n",
);
