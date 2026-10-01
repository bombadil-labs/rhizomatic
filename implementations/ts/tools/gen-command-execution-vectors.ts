import { writeFileSync, readFileSync } from "node:fs";
import { authorForSeed, signClaims, verifyDelta } from "../src/delta/sign.js";
import { claimsToJson } from "../src/delta/json-profile.js";
import {
  COMMAND_PREFIX,
  writeCommandDescription,
  serializeCommandDelta,
  encodeBindings,
} from "../src/command-data/codec.js";
import {
  publishHyperSchemaClaims,
  publishSchemaClaims,
  HYPER_SCHEMA_SCHEMA,
} from "../src/schema-load/schema-deltas.js";
import { parseSchema } from "../src/syntax/term-json.js";
import { termHash, schemaHash } from "../src/syntax/term-io.js";
import type { Target, Delta } from "../src/delta/types.js";
const receiverSeed = "01".repeat(32),
  callerSeed = "02".repeat(32),
  definitionSeed = "03".repeat(32);
const receiver = authorForSeed(receiverSeed),
  caller = authorForSeed(callerSeed),
  foreign = authorForSeed(definitionSeed);
const t = (value: string | number): readonly Target[] => [{ kind: "primitive", value }];
const e = (id: string): readonly Target[] => [{ kind: "entity", entity: { id } }];
const refs = (ids: string[]): readonly Target[] =>
  ids.map((delta) => ({ kind: "delta", deltaRef: { delta } }));
const declarations = (["retain", "evaluate"] as const).map((kind) =>
  writeCommandDescription(receiverSeed, 0, "operation/1", {
    name: e(COMMAND_PREFIX + kind),
    interpreter: t(COMMAND_PREFIX + kind + "/1"),
    "input-contract": t(COMMAND_PREFIX + kind + "/1"),
    "output-contract": t(COMMAND_PREFIX + "outcome/1"),
    effect: t(kind === "retain" ? "admission" : "none"),
    replay: t("re-evaluate/1"),
    dependencies: t("explicit-support/1"),
  }),
);
const configuration = writeCommandDescription(receiverSeed, 0, "endpoint/1", {
  receiver: e(receiver),
  caller: t(caller),
  installed: refs(declarations.map((d) => d.id)),
  quota: t(10),
  "max-deltas": t(20),
  "max-bytes": t(100000),
});
const fact = (value: string, at: number) =>
  signClaims(
    {
      timestamp: at,
      validFrom: at,
      author: foreign,
      pointers: [
        { role: "about", target: { kind: "entity", entity: { id: "subject", context: "name" } } },
        { role: "value", target: { kind: "primitive", value } },
      ],
    },
    definitionSeed,
  );
const first = fact("Ada", 1),
  second = fact("Grace", 2);
// Independent reviewer nonce r=1 oracle, not the normal deterministic writer's signature.
const alternate = {
  ...first,
  sig: "58666666666666666666666666666666666666666666666666666666666666669ec87b884b7593be1b27d9d51be875f60df2967df9ac58fb9d53b3af25647a03",
};
if (verifyDelta(alternate) !== "verified")
  throw Error("alternate signature oracle no longer binds the fixed first claims");
const request = (
  payload: Delta[],
  extra: Record<string, readonly Target[]> = {},
  seed = callerSeed,
) =>
  writeCommandDescription(seed, 1, "request/1", {
    receiver: e(receiver),
    configuration: refs([configuration.id]),
    operation: refs([declarations[0]!.id]),
    ...extra,
    payload: refs(payload.map((d) => d.id)),
  });
const baseRequest = request([first]);
const addressed = request([baseRequest]);
const otherConfig = writeCommandDescription(receiverSeed, 0, "endpoint/1", {
  receiver: e(receiver),
  caller: t(foreign),
  installed: refs(declarations.map((d) => d.id)),
  quota: t(1),
  "max-deltas": t(20),
  "max-bytes": t(100000),
});
const inert: Delta[] = [
  baseRequest,
  otherConfig,
  declarations[1]!,
  signClaims(
    {
      timestamp: 1,
      validFrom: 1,
      author: foreign,
      pointers: [{ role: "erases", target: { kind: "delta", deltaRef: { delta: first.id } } }],
    },
    definitionSeed,
  ),
  signClaims(
    {
      timestamp: 1,
      validFrom: 1,
      author: foreign,
      pointers: [
        { role: "rhizomatic.txn.member", target: { kind: "delta", deltaRef: { delta: first.id } } },
      ],
    },
    definitionSeed,
  ),
  signClaims(
    {
      timestamp: 1,
      validFrom: 1,
      author: foreign,
      pointers: [
        { role: "rhizomatic.derivation.binding", target: { kind: "primitive", value: "inert" } },
      ],
    },
    definitionSeed,
  ),
];
const construction = (d: Delta, payload: Delta[], seed = callerSeed) => ({
  request: { claims: claimsToJson(d.claims), seed },
  support: payload.map((delta) => ({
    claims: claimsToJson(delta.claims),
    seed:
      delta.claims.author === caller
        ? callerSeed
        : delta.claims.author === receiver
          ? receiverSeed
          : definitionSeed,
  })),
});
const limitedConfiguration = writeCommandDescription(receiverSeed, 0, "endpoint/1", {
  receiver: e(receiver),
  caller: t(caller),
  installed: refs(declarations.map((d) => d.id)),
  quota: t(10),
  "max-deltas": t(20),
  "max-bytes": t(1),
});
const limitedRequest = request([first], { configuration: refs([limitedConfiguration.id]) });
const gather = signClaims(
  publishHyperSchemaClaims(
    { ...HYPER_SCHEMA_SCHEMA, name: "fixture.Generic" },
    "fixture-gather",
    foreign,
    1,
  ),
  definitionSeed,
);
const readingBody = parseSchema({
  props: {},
  default: { pick: { order: { byTimestamp: "desc" } } },
});
const reading = signClaims(
  publishSchemaClaims(
    { ...readingBody, name: "fixture.Latest", alg: 1 },
    "fixture-reading",
    foreign,
    1,
  ),
  definitionSeed,
);
const height = signClaims(
  {
    timestamp: 1,
    validFrom: 1,
    author: foreign,
    pointers: [
      { role: "about", target: { kind: "entity", entity: { id: "subject", context: "height" } } },
      { role: "value", target: { kind: "primitive", value: 42 } },
    ],
  },
  definitionSeed,
);
const evaluation = writeCommandDescription(callerSeed, 1, "request/1", {
  receiver: e(receiver),
  configuration: refs([configuration.id]),
  operation: refs([declarations[1]!.id]),
  source: t("admitted"),
  root: e("subject"),
  at: t(10),
  interpretation: t("core/1"),
  hyperschema: refs([gather.id]),
  "hyperschema-pin": t(termHash(HYPER_SCHEMA_SCHEMA.body)),
  schema: refs([reading.id]),
  "schema-pin": t(schemaHash(readingBody)),
  bindings: [{ kind: "bytes", mime: "application/cbor", value: encodeBindings({}) }],
});
const context = {
  receiverSeed,
  callerSeed,
  definitionSeed,
  receivedAt: 10,
  boot: {
    configuration: serializeCommandDelta(configuration),
    declarations: declarations.map(serializeCommandDelta),
  },
  initialDeltas: [],
  construction: construction(baseRequest, [first]),
};
const fixtures = {
  signatureVariants: {
    original: serializeCommandDelta(first),
    alternate: serializeCommandDelta(alternate),
    selectedSignature: [first.sig!, alternate.sig].sort()[0],
    oracle:
      "Independent Ed25519 nonce r=1: R=B; a=clamp(SHA512(seed03)); k=LE(SHA512(R||A||rawMultihashID)) mod L; S=(1+k*a) mod L. Both supplied signatures verify. Select minimum signature bytes after verifying all appearances; never replace an already admitted row.",
  },
  uppercaseSignature: {
    ...(serializeCommandDelta(first) as object),
    sig: first.sig!.toUpperCase(),
  },
  gather: serializeCommandDelta(gather),
  reading: serializeCommandDelta(reading),
  height: serializeCommandDelta(height),
  evaluation: serializeCommandDelta(evaluation),
  heightRequest: serializeCommandDelta(request([height])),
  missingSignatureByteLimit: {
    configuration: serializeCommandDelta(limitedConfiguration),
    request: serializeCommandDelta(limitedRequest),
    payload: { id: first.id, claims: claimsToJson(first.claims) },
    expectedCode: "resource-limit",
  },
  first: serializeCommandDelta(first),
  second: serializeCommandDelta(second),
  request: serializeCommandDelta(baseRequest),
  secondRequest: serializeCommandDelta(request([second])),
  bothRequest: serializeCommandDelta(request([first, second])),
  addressedRequest: serializeCommandDelta(addressed),
  inertRequest: serializeCommandDelta(request(inert)),
  inert: inert.map(serializeCommandDelta),
  wrongCaller: serializeCommandDelta(request([first], {}, definitionSeed)),
  wrongReceiver: serializeCommandDelta(request([first], { receiver: e(foreign) })),
  wrongConfiguration: serializeCommandDelta(
    request([first], { configuration: refs([otherConfig.id]) }),
  ),
  oldHeadRequest: serializeCommandDelta(request([second], { "expected-head": t("") })),
  unresolved: serializeCommandDelta(
    signClaims(
      {
        timestamp: 1,
        validFrom: 1,
        author: foreign,
        pointers: [
          {
            role: "unresolved",
            target: { kind: "delta", deltaRef: { delta: "1e20" + "77".repeat(32) } },
          },
        ],
      },
      definitionSeed,
    ),
  ),
};
const m2 = JSON.parse(
  readFileSync(new URL("../../../contracts/command/ACCEPTANCE.json", import.meta.url), "utf8"),
) as { scenarios: { id: string; milestone: string; expected: string }[] };
const cases = m2.scenarios
  .filter((c) => c.milestone === "M2" || c.milestone === "M3")
  .map((c) => ({
    id: c.id,
    scenario: c.id,
    milestone: c.milestone,
    context,
    oracle: c.expected,
    driver: c.id,
  }));
writeFileSync(
  new URL("../../../vectors/command/execution.json", import.meta.url),
  JSON.stringify({ format: "rhizomatic-command-execution-vectors/1", fixtures, cases }, null, 2) +
    "\n",
);
