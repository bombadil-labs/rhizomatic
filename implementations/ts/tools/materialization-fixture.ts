// Test host only. Each stage starts fresh and carries only serialized signed descriptions/results.
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import {
  MaterializationEndpoint,
  materializationDescriptionClaims,
  readMaterializationDescription,
  readMaterializationResult,
  preflightMaterializationInput,
  parseCommandDelta,
  serializeCommandDelta,
  signClaims,
  authorForSeed,
  DeltaSet,
  type Delta,
  type MaterializationSourceCapability,
} from "../src/index.js";
import { commandBytes, commandEntity } from "../src/command-data/codec.js";
import { bytesToHex } from "../src/delta/hash.js";
import { encode } from "../src/delta/cbor.js";
import type { CommandFields } from "../src/command-data/codec.js";
const input = JSON.parse(readFileSync(0, "utf8"));
const f = input.fixture;
const boot = {
  configuration: parseCommandDelta(f.boot.configuration),
  declarations: f.boot.declarations.map(parseCommandDelta),
  bindings: f.boot.bindings.map(parseCommandDelta),
};
const receivedAt = f.receivedAt ?? 1000;
const signer = {
  author: authorForSeed(f.seeds.receiver),
  sign: (claims: Delta["claims"]) => signClaims(claims, f.seeds.receiver),
};
const ref = (delta: string) => ({ kind: "delta" as const, deltaRef: { delta } });
const describe = (kind: "request/1" | "evidence/1", fields: CommandFields) =>
  signClaims(
    materializationDescriptionClaims(authorForSeed(f.seeds.caller), receivedAt, kind, fields),
    f.seeds.caller,
  );
const output = (value: unknown) => process.stdout.write(JSON.stringify(value));
const op = (verb: string) =>
  boot.declarations.find(
    (d: Delta) =>
      commandEntity(readMaterializationDescription(d), "name") ===
      "rhizomatic.materialization." + verb,
  )!.id;
const context = (q: Delta) => ({
  receiver: signer.author,
  configuration: boot.configuration.id,
  request: q.id,
  requestDelta: q,
  receivedAt,
});
if (input.mode === "construct") {
  const q = parseCommandDelta(f.request),
    fields = readMaterializationDescription(q, "gather"),
    copied: Record<string, readonly Delta["claims"]["pointers"][number]["target"][]> = {
      ...fields,
    };
  delete copied.kind;
  const constructed = signClaims(
    materializationDescriptionClaims(
      authorForSeed(f.seeds.caller),
      q.claims.timestamp,
      "request/1",
      copied,
    ),
    f.seeds.caller,
  );
  output({
    request: serializeCommandDelta(constructed),
    delivery: f.delivery.map((d: { id: string }) =>
      d.id === q.id ? serializeCommandDelta(constructed) : d,
    ),
  });
} else if (input.mode === "gather") {
  const preparing = performance.now();
  const q = parseCommandDelta(input.upstream.request);
  // Opaque source artifact. The independent fixture source supplies its own basis;
  // only the endpoint decodes testimony, including an over-cap snapshot.
  const rows = DeltaSet.from(f.rows.map(parseCommandDelta)),
    initial = rows.digest();
  const calls: unknown[] = [];
  const grant: MaterializationSourceCapability = {
    async capture() {
      throw Error("gather never recaptures");
    },
    async reacquireSnapshot() {
      throw Error("batch never restores");
    },
    async checkCurrent(binding, revision, authority, at, cutoff, support) {
      calls.push({ binding, revision, authority, at, cutoff, support: [...support] });
      if (
        rows.digest() !== initial ||
        binding !== f.source.binding ||
        revision !== f.source.revision ||
        authority !== f.source.authority
      )
        return { status: "source-changed" };
      return { status: "current" };
    },
  };
  const e = MaterializationEndpoint.boot({
    ...boot,
    signer,
    sourceGrants: new Map([[f.source.binding, grant]]),
    diagnostic: (e) => {
      throw e;
    },
  });
  const preparedAt = performance.now();
  const outcome = serializeCommandDelta(await e.invoke(q.id, input.upstream.delivery, receivedAt));
  const finishedAt = performance.now();
  output({
    ...(input.measureEndpoint
      ? {
          measurements: {
            sourceAndBootPreparationMs: preparedAt - preparing,
            endpointMs: finishedAt - preparedAt,
          },
        }
      : {}),
    request: input.upstream.request,
    outcome,
    calls,
    preflight: preflightMaterializationInput(boot, q.id, input.upstream.delivery, receivedAt),
  });
} else if (input.mode === "wrap-evidence") {
  const gathered = parseCommandDelta(input.upstream.outcome),
    gq = parseCommandDelta(input.upstream.request);
  const read = readMaterializationResult(gathered, context(gq));
  if (read.status !== "completed") throw Error("fixture gather refused");
  const payload = commandBytes(readMaterializationDescription(gathered), "result");
  const evidence = describe("evidence/1", {
      result: [{ kind: "bytes", mime: "application/cbor", value: payload }],
    }),
    q = describe("request/1", {
      receiver: [{ kind: "entity", entity: { id: signer.author } }],
      configuration: [ref(boot.configuration.id)],
      operation: [ref(op("resolve"))],
      evidence: [ref(evidence.id)],
    });
  output({
    request: serializeCommandDelta(q),
    evidence: serializeCommandDelta(evidence),
    delivery: [q, evidence].map(serializeCommandDelta),
    gather: input.upstream,
  });
} else if (input.mode === "resolve") {
  const q = parseCommandDelta(input.upstream.request),
    e = MaterializationEndpoint.boot({
      ...boot,
      signer,
      sourceGrants: new Map(),
      diagnostic: (e) => {
        throw e;
      },
    });
  output({
    ...input.upstream,
    outcome: serializeCommandDelta(await e.invoke(q.id, input.upstream.delivery, receivedAt)),
    preflight: preflightMaterializationInput(boot, q.id, input.upstream.delivery, receivedAt),
  });
} else if (input.mode === "read-result") {
  const q = parseCommandDelta(input.upstream.request),
    read = readMaterializationResult(parseCommandDelta(input.upstream.outcome), {
      ...context(q),
      ...(input.upstream.evidence ? { evidence: parseCommandDelta(input.upstream.evidence) } : {}),
      capture: parseCommandDelta(f.capture),
      snapshot: parseCommandDelta(f.snapshot),
    });
  output({
    status: read.status,
    classification: read.classification,
    sourceCommitments: read.sourceCommitments,
    receiverTestimony: read.receiverTestimony,
    executionVerified: read.executionVerified,
    bodyHex: bytesToHex(encode(read.body)),
  });
} else throw Error("unknown fixture mode");
