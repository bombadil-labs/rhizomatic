// Independent SPEC-15 scenario oracles: no endpoint, evaluator, or result-reader invocation.
import { readFileSync, writeFileSync } from "node:fs";
import { signClaims, authorForSeed } from "../src/delta/sign.js";
import { claimsToJson } from "../src/delta/json-profile.js";
import { encode, map, float, tstr, bstr, array, type CborValue } from "../src/delta/cbor.js";
import { contentAddress, bytesToHex } from "../src/delta/hash.js";
import type { Delta, Target } from "../src/delta/types.js";
import { DeltaSet } from "../src/delta/set.js";
import { packSet } from "../src/storage/pack.js";
import {
  parseCommandDelta,
  serializeCommandDelta,
  encodeBindings,
  COMMAND_PREFIX,
} from "../src/command-data/codec.js";
import {
  publishHyperSchemaClaims,
  publishSchemaClaims,
  HYPER_SCHEMA_SCHEMA,
} from "../src/schema-load/schema-deltas.js";
import { termHash, schemaHash } from "../src/syntax/term-io.js";
import { viewToCbor } from "../src/resolve-kernel/resolution.js";
import type { Schema, Term, View } from "../src/syntax/model.js";
const executionPath = new URL("../../../vectors/command/execution.json", import.meta.url);
const execution = JSON.parse(readFileSync(executionPath, "utf8"));
const base = execution.cases.find((c: { milestone: string }) => c.milestone === "M2").context;
const seed = base.receiverSeed as string,
  callerSeed = base.callerSeed as string,
  definitionSeed = base.definitionSeed as string;
const foreign = authorForSeed(definitionSeed),
  caller = authorForSeed(callerSeed);
const native = (key: string) => parseCommandDelta(execution.fixtures[key]);
const height = native("height"),
  gather = native("gather"),
  reading = native("reading");
const latest: Schema = {
  props: new Map(),
  default: { kind: "pick", order: { kind: "byTimestamp", dir: "desc" } },
};
const p = (value: string | number | boolean): Target => ({ kind: "primitive", value });
const entity = (id: string): Target => ({ kind: "entity", entity: { id } });
const ref = (id: string): Target => ({ kind: "delta", deltaRef: { delta: id } });
function signedDescription(
  kind: string,
  fields: readonly (readonly [string, Target | readonly Target[]])[],
  signer: string,
  at: number,
): Delta {
  const pointers = [
    { role: COMMAND_PREFIX + "kind", target: p(kind) },
    ...fields.flatMap(([role, target]) =>
      (Array.isArray(target) ? target : [target]).map((target) => ({
        role: COMMAND_PREFIX + role,
        target: target as Target,
      })),
    ),
  ];
  return signClaims(
    { timestamp: at, validFrom: at, author: authorForSeed(signer), pointers },
    signer,
  );
}
function boot(receiverSeed = seed) {
  const receiver = authorForSeed(receiverSeed);
  const declarations = (["retain", "evaluate"] as const).map((kind) =>
    signedDescription(
      "operation/1",
      [
        ["name", entity(COMMAND_PREFIX + kind)],
        ["interpreter", p(COMMAND_PREFIX + kind + "/1")],
        ["input-contract", p(COMMAND_PREFIX + kind + "/1")],
        ["output-contract", p(COMMAND_PREFIX + "outcome/1")],
        ["effect", p(kind === "retain" ? "admission" : "none")],
        ["replay", p("re-evaluate/1")],
        ["dependencies", p("explicit-support/1")],
      ],
      receiverSeed,
      0,
    ),
  );
  const configuration = signedDescription(
    "endpoint/1",
    [
      ["receiver", entity(receiver)],
      ["caller", p(caller)],
      [
        "installed",
        declarations
          .map((d) => d.id)
          .sort()
          .map(ref),
      ],
      ["quota", p(10)],
      ["max-deltas", p(20)],
      ["max-bytes", p(100000)],
    ],
    receiverSeed,
    0,
  );
  return { receiverSeed, receiver, configuration, declarations };
}
type Boot = ReturnType<typeof boot>;
const installed = boot();
function retainRequest(payload: Delta[], b = installed): Delta {
  return signedDescription(
    "request/1",
    [
      ["receiver", entity(b.receiver)],
      ["configuration", ref(b.configuration.id)],
      ["operation", ref(b.declarations[0]!.id)],
      [
        "payload",
        payload
          .map((d) => d.id)
          .sort()
          .map(ref),
      ],
    ],
    callerSeed,
    1,
  );
}
function evaluationRequest(
  g: Delta,
  r: Delta,
  body: Term,
  schema: Schema,
  options: {
    source?: string;
    root?: string;
    interpretation?: string;
    definitions?: Delta[];
    head?: string;
    pin?: string;
  } = {},
  b = installed,
): Delta {
  return signedDescription(
    "request/1",
    [
      ["receiver", entity(b.receiver)],
      ["configuration", ref(b.configuration.id)],
      ["operation", ref(b.declarations[1]!.id)],
      ...(options.head === undefined ? [] : [["expected-head", p(options.head)] as const]),
      ["source", p(options.source ?? "admitted")],
      ["root", entity(options.root ?? "subject")],
      ["at", p(10)],
      ["interpretation", p(options.interpretation ?? "core/1")],
      ["hyperschema", ref(g.id)],
      ["hyperschema-pin", p(options.pin ?? termHash(body))],
      ["schema", ref(r.id)],
      ["schema-pin", p(schemaHash(schema))],
      [
        "definition",
        (options.definitions ?? [])
          .map((d) => d.id)
          .sort()
          .map(ref),
      ],
      ["bindings", { kind: "bytes", mime: "application/cbor", value: encodeBindings({}) }],
    ],
    callerSeed,
    1,
  );
}
function hyper(body: Term, name: string): Delta {
  return signClaims(
    publishHyperSchemaClaims({ name, alg: 1, body }, "fixture-gather", foreign, 1),
    definitionSeed,
  );
}
function resolution(schema: Schema, name: string): Delta {
  return signClaims(
    publishSchemaClaims({ ...schema, name, alg: 1 }, "fixture-reading", foreign, 1),
    definitionSeed,
  );
}
function frameHead(rows: Delta[], peer: string, prior: string, at: number, sender: string): string {
  // SPEC6 frame table; independent of the journal encoder, admission planner, or endpoint.
  return contentAddress(
    encode(
      map([
        ["version", float(1)],
        ["peer", tstr(peer)],
        ["prior", tstr(prior)],
        ["at", float(at)],
        ["sender", tstr(sender)],
        ["pack", bstr(packSet(DeltaSet.from(rows)))],
      ]),
    ),
  );
}
function observation(rows: Delta[], b = installed, at = 3, sender = "local") {
  const ids = rows.map((d) => d.id).sort();
  return {
    head: rows.length ? frameHead(rows, b.receiver, "", at, sender) : "",
    ids,
    arrivals: ids.map((id, i) => ({ id, at, sequence: i + 1, transfer: 1, sender })),
    quotaUsed: ids.length,
  };
}
function outcome(request: Delta, body: CborValue, status = "completed", b = installed): Delta {
  return signedDescription(
    "outcome/1",
    [
      ["receiver", entity(b.receiver)],
      ["configuration", ref(b.configuration.id)],
      ["request", ref(request.id)],
      ["status", p(status)],
      ["result", { kind: "bytes", mime: "application/cbor", value: encode(body) }],
    ],
    b.receiverSeed,
    10,
  );
}
function construction(root: Delta, support: Delta[]) {
  return {
    request: { claims: claimsToJson(root.claims), seed: callerSeed },
    support: support.map((delta) => ({ claims: claimsToJson(delta.claims), seed: definitionSeed })),
  };
}
function context(root: Delta, support: Delta[], initial: Delta[], b = installed) {
  return {
    receiverSeed: b.receiverSeed,
    callerSeed,
    definitionSeed,
    receivedAt: 10,
    boot: {
      configuration: serializeCommandDelta(b.configuration),
      declarations: b.declarations.map(serializeCommandDelta),
    },
    initialDeltas: initial.map(serializeCommandDelta),
    ...(initial.length ? { initialArrivedAt: 3 } : {}),
    construction: construction(root, support),
  };
}
function artifact(root: Delta, support: Delta[]) {
  return {
    format: "rhizomatic-command-artifact/1",
    entryId: root.id,
    deltas: [root, ...support].map(serializeCommandDelta),
  };
}
function result(body: CborValue, status = "completed", value?: View) {
  return {
    status,
    bodyHex: bytesToHex(encode(body)),
    ...(value === undefined ? {} : { valueHex: bytesToHex(encode(viewToCbor(value))) }),
  };
}
function evaluateStep(
  id: string,
  root: Delta,
  support: Delta[],
  initial: Delta[],
  value: View,
  oracle: string,
  options: {
    b?: Boot;
    body?: Term;
    schema?: Schema;
    source?: string;
    interpretation?: string;
    rows?: Delta[];
    observed?: ReturnType<typeof observation>;
  } = {},
) {
  const b = options.b ?? installed,
    observed = options.observed ?? observation(options.rows ?? initial, b),
    fields = new Map(
      root.claims.pointers.map((p) => [p.role.slice(COMMAND_PREFIX.length), p.target]),
    );
  const definitions = support.map((d) => d.id).sort(),
    source = options.source ?? "admitted";
  const body = map([
    ["kind", tstr("evaluate")],
    ["source", tstr(source)],
    [
      "digest",
      tstr(
        DeltaSet.from(
          source === "catalog" ? [b.configuration, ...b.declarations] : (options.rows ?? initial),
        ).digest(),
      ),
    ],
    ["definitionDigest", tstr(contentAddress(encode(array(definitions.map(tstr)))))],
    ["at", float(10)],
    ["interpretation", tstr(options.interpretation ?? "core/1")],
    ["hyperschemaPin", tstr((fields.get("hyperschema-pin") as { value: string }).value)],
    ["schemaPin", tstr((fields.get("schema-pin") as { value: string }).value)],
    ["value", bstr(encode(viewToCbor(value)))],
    ...(source === "admitted" ? [["head", tstr(observed.head)] as const] : []),
  ]);
  return {
    id,
    context: context(root, support, initial, b),
    expected: {
      oracle,
      artifact: artifact(root, support),
      outcome: serializeCommandDelta(outcome(root, body, "completed", b)),
      result: result(body, "completed", value),
      observed,
    },
  };
}
const retain = retainRequest([height]),
  written = observation([height], installed, 10, "unattributed");
const retainBody = map([
  ["kind", tstr("retain")],
  ["beforeHead", tstr("")],
  ["head", tstr(written.head)],
  ["beforeDigest", tstr(DeltaSet.from([]).digest())],
  ["digest", tstr(DeltaSet.from([height]).digest())],
  ["admitted", array([tstr(height.id)])],
  ["duplicate", array([])],
]);
const retainStep = {
  id: "retain",
  context: context(retain, [height], []),
  expected: {
    oracle:
      "The single foreign height42 payload is atomically retained at10, with unattributed arrival1/transfer1. No request or outcome is admitted. Empty before head/digest and one normative ordinary frame fix afterhead.",
    artifact: artifact(retain, [height]),
    outcome: serializeCommandDelta(outcome(retain, retainBody)),
    result: result(retainBody),
    observed: written,
  },
};
const query = evaluationRequest(gather, reading, HYPER_SCHEMA_SCHEMA.body, latest, {
  head: written.head,
});
const queryStep = evaluateStep(
  "query",
  query,
  [gather, reading],
  [],
  { height: 42 },
  "The bound observed retain head selects the same verified membership. Generic gather files the foreign fact under height and latest resolves42; supplied definitions remain ephemeral.",
  { rows: [height], observed: written },
);
(
  queryStep.context.construction.request.claims as { pointers: { role: string; target: unknown }[] }
).pointers.find((p) => p.role === COMMAND_PREFIX + "expected-head")!.target =
  "previous-observed-head";
Object.assign(queryStep.context.construction, {
  bind: [
    { role: COMMAND_PREFIX + "expected-head", observation: { step: "retain", field: "head" } },
  ],
});
const cases: {
  id: string;
  scenario: string;
  tower?: boolean;
  peerComparison?: string;
  steps: unknown[];
}[] = [
  {
    id: "tower_write_then_query",
    scenario: "write_then_query",
    tower: true,
    steps: [retainStep, queryStep],
  },
];
// Catalog discovery is an ordinary byRole gather over its three signed installed descriptions.
const catalogBody: Term = { ...HYPER_SCHEMA_SCHEMA.body, key: { kind: "byRole" } } as Term;
const catalogGather = hyper(catalogBody, "fixture.Catalog"),
  catalogSteps = [];
for (const [id, root, description] of [
  ["configuration", installed.receiver, installed.configuration],
  ["retain", COMMAND_PREFIX + "retain", installed.declarations[0]!],
  ["evaluate", COMMAND_PREFIX + "evaluate", installed.declarations[1]!],
] as const) {
  const properties: Record<string, View> = {};
  let filing = "";
  for (const pointer of description.claims.pointers) {
    const target = pointer.target;
    if (target.kind === "entity" && target.entity.id === root) {
      filing = pointer.role;
      continue;
    }
    const v: View =
      target.kind === "primitive"
        ? target.value
        : target.kind === "delta"
          ? target.deltaRef.delta
          : target.kind === "entity"
            ? target.entity.id
            : { mime: target.mime, value: target.value };
    const prior = properties[pointer.role];
    properties[pointer.role] =
      prior === undefined ? v : Array.isArray(prior) ? [...prior, v] : [prior, v];
  }
  const value = { [filing]: properties };
  const q = evaluationRequest(catalogGather, reading, catalogBody, latest, {
    source: "catalog",
    root,
  });
  catalogSteps.push(
    evaluateStep(
      id,
      q,
      [catalogGather, reading],
      [],
      value,
      "Only exact installed descriptions form catalog membership. Filing by the signed receiver/name pointer yields every other command field verbatim; no peer-store read supplies discovery.",
      { source: "catalog" },
    ),
  );
}
cases.push({
  id: "tower_catalog_discovery",
  scenario: "catalog_discovery",
  tower: true,
  steps: catalogSteps,
});
// Two physical expansion levels: named child gather/pinned child reading, pinned grand gather/named grand reading.
const grand = hyper(HYPER_SCHEMA_SCHEMA.body, "fixture.Grand");
const grandSchema: Schema = {
    props: new Map(),
    default: { kind: "pick", order: { kind: "byTimestamp", dir: "asc" } },
  },
  grandReading = resolution(grandSchema, "fixture.GrandReading");
const childSchema: Schema = {
    props: new Map(),
    default: { kind: "pick", order: { kind: "lexById" } },
  },
  childReading = resolution(childSchema, "fixture.ChildReading");
const childBody: Term = {
    kind: "expand",
    role: { kind: "exact", value: "link" },
    schema: { kind: "pinned", hash: termHash(HYPER_SCHEMA_SCHEMA.body) },
    reading: { kind: "name", name: "fixture.GrandReading" },
    of: HYPER_SCHEMA_SCHEMA.body,
  },
  child = hyper(childBody, "fixture.Child");
const parentBody: Term = {
    kind: "expand",
    role: { kind: "exact", value: "link" },
    schema: { kind: "name", name: "fixture.Child" },
    reading: { kind: "pinned", hash: schemaHash(childSchema) },
    of: HYPER_SCHEMA_SCHEMA.body,
  },
  parent = hyper(parentBody, "fixture.Parent");
function fact(
  id: string,
  prop: string,
  role: string,
  target: Target,
  signer = definitionSeed,
  at = 1,
): Delta {
  return signClaims(
    {
      timestamp: at,
      validFrom: at,
      author: authorForSeed(signer),
      pointers: [
        { role: "about", target: { kind: "entity", entity: { id, context: prop } } },
        { role, target },
      ],
    },
    signer,
  );
}
const closureRows = [
  fact("subject", "child", "link", entity("child")),
  fact("child", "grandchild", "link", entity("grand")),
  fact("grand", "height", "value", p(42)),
];
const deps = [child, childReading, grand, grandReading],
  closure = evaluationRequest(parent, reading, parentBody, latest, { definitions: deps });
cases.push({
  id: "tower_definition_closure",
  scenario: "definition_closure",
  tower: true,
  steps: [
    evaluateStep(
      "command",
      closure,
      [parent, reading, ...deps],
      closureRows,
      { child: { grandchild: { height: 42 } } },
      "Exactly the six selected signed definitions form the reachable two-level closure. Entity links expand with each child's own reading; the terminal primitive42 produces child.grandchild.height.",
    ),
  ],
});
// Shared evidence distinguishes root-authored suppression of a middle-author delegation.
const root = foreign,
  middleSeed = "04".repeat(32),
  leafSeed = "05".repeat(32),
  middle = authorForSeed(middleSeed),
  leaf = authorForSeed(leafSeed);
function delegate(signer: string, key: string): Delta {
  return signClaims(
    {
      timestamp: 1,
      validFrom: 1,
      author: authorForSeed(signer),
      pointers: [
        {
          role: "principal",
          target: { kind: "entity", entity: { id: root, context: "rhizomatic.principal" } },
        },
        { role: "kind", target: p("delegation") },
        { role: "key", target: p(key) },
        { role: "scope", target: p("read") },
        { role: "delegable", target: p(true) },
      ],
    },
    signer,
  );
}
const edge = delegate(middleSeed, leaf),
  negation = signClaims(
    {
      timestamp: 2,
      validFrom: 2,
      author: root,
      pointers: [{ role: "negates", target: ref(edge.id) }],
    },
    definitionSeed,
  );
const principalRows = [
  height,
  delegate(definitionSeed, middle),
  edge,
  negation,
  fact("subject", "height", "value", p(55), leafSeed, 2),
];
const principalBody: Term = {
  kind: "group",
  key: { kind: "byTargetContext" },
  of: {
    kind: "select",
    pred: {
      kind: "and",
      left: { kind: "actsFor", root, policy: { kind: "exact", scope: "read" } },
      right: { kind: "hasPointer", ppred: { targetEntity: { kind: "root" } } },
    },
    of: { kind: "input" },
  },
};
const principal = hyper(principalBody, "fixture.Principal"),
  principalSteps = [];
for (const [i, interpretation, value] of [
  [0, "principal-sameAuthor/1", 55],
  [1, "principal-rootOrSameAuthor/1", 42],
] as const) {
  const q = evaluationRequest(principal, reading, principalBody, latest, { interpretation });
  principalSteps.push(
    evaluateStep(
      i === 0 ? "same-author" : "root-or-same-author",
      q,
      [principal, reading],
      i === 0 ? principalRows : [],
      { height: value },
      "Under sameAuthor the root cannot suppress the middle-author edge, so leaf55 is authorized and latest. Under rootOrSameAuthor that edge is suppressed, leaving root's height42. Both principal times equal explicit at10; original signed pin stays unchanged.",
      { rows: principalRows, interpretation },
    ),
  );
}
cases.push({
  id: "tower_principal_profiles",
  scenario: "principal_profiles",
  tower: true,
  steps: principalSteps,
});
const bytes = fact("subject", "height", "value", {
  kind: "bytes",
  mime: "image/png",
  value: Uint8Array.from([1, 2, 3]),
});
const bytesQuery = evaluationRequest(gather, reading, HYPER_SCHEMA_SCHEMA.body, latest);
cases.push({
  id: "tower_outcome_provenance",
  scenario: "outcome_provenance",
  tower: true,
  steps: [
    evaluateStep(
      "command",
      bytesQuery,
      [gather, reading],
      [bytes],
      { height: { mime: "image/png", value: Uint8Array.from([1, 2, 3]) } },
      "Foreign source bytes retain their exact MIME and three payload bytes inside the opaque canonical View. The outcome is receiver testimony about the request/config/source/program pins, never a replacement foreign fact.",
    ),
  ],
});
const wrongPin = evaluationRequest(gather, reading, HYPER_SCHEMA_SCHEMA.body, latest, {
    pin: "1e20" + "00".repeat(32),
  }),
  refusal = map([["code", tstr("pin-mismatch")]]);
cases.push({
  id: "tower_definition_pin_mismatch",
  scenario: "definition_pin_mismatch",
  tower: true,
  steps: [
    {
      id: "command",
      context: context(wrongPin, [gather, reading], []),
      expected: {
        oracle:
          "Both supplied descriptions are valid canonical signed definitions. The requested gather pin is all-zero content rather than the selected canonical gather hash, so runtime refuses pin-mismatch after capture and before evaluation. No rows/frames are written.",
        artifact: artifact(wrongPin, [gather, reading]),
        outcome: serializeCommandDelta(outcome(wrongPin, refusal, "refused")),
        result: result(refusal, "refused"),
        observed: observation([]),
      },
    },
  ],
});
for (const [name, receiverSeed] of [
  ["a", seed],
  ["b", "06".repeat(32)],
] as const) {
  const b = boot(receiverSeed),
    q = evaluationRequest(gather, reading, HYPER_SCHEMA_SCHEMA.body, latest, {}, b);
  cases.push({
    id: `peer_${name}`,
    scenario: "different_peer_signers",
    peerComparison: "same-value-different-receiver",
    steps: [
      evaluateStep(
        "command",
        q,
        [gather, reading],
        [height],
        { height: 42 },
        "The same foreign source fact and exact definitions resolve42 under two separately installed receiver/config/request identities. Each signed outcome is checked against its own authority and physical head; value bytes agree across peers.",
        { b },
      ),
    ],
  });
}
execution.cases = [
  ...execution.cases.filter(
    (c: { tower?: boolean; peerComparison?: string }) => !c.tower && !c.peerComparison,
  ),
  ...cases,
];
writeFileSync(executionPath, JSON.stringify(execution, null, 2) + "\n");
const towersPath = new URL("../../../contracts/command/TOWERS.json", import.meta.url),
  towers = JSON.parse(readFileSync(towersPath, "utf8"));
towers.required_peer_comparisons = ["same-value-different-receiver"];
writeFileSync(towersPath, JSON.stringify(towers, null, 2) + "\n");
