// Test host only. Each stage starts fresh and carries only serialized signed descriptions/results.
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  type MaterializationControlStore,
  type MaterializationVerb,
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
// ---- M3 durable host: one JSON document per (receiver, configuration), replaced whole by rename.
// The store never decodes an image; it keeps the revision the endpoint named beside the bytes.
type FaultKind =
  | "crash-before-cas"
  | "crash-after-cas"
  | "unconfirmed-absent"
  | "unconfirmed-present"
  | "rejected"
  | "post-cas-result"
  | "sign-failure";
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
class FileControlStore implements MaterializationControlStore {
  constructor(
    readonly dir: string,
    readonly fault?: FaultKind,
  ) {}
  private path(receiver: string, configuration: string) {
    return join(
      this.dir,
      encodeURIComponent(receiver),
      encodeURIComponent(configuration) + ".json",
    );
  }
  load(receiver: string, configuration: string) {
    const p = this.path(receiver, configuration);
    if (!existsSync(p)) return undefined;
    const doc = JSON.parse(readFileSync(p, "utf8")) as { revision: string; imageHex: string };
    return { revision: doc.revision, bytes: hex(doc.imageHex) };
  }
  save(receiver: string, configuration: string, revision: string, bytes: Uint8Array) {
    const p = this.path(receiver, configuration);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p + ".tmp", JSON.stringify({ revision, imageHex: bytesToHex(bytes) }));
    renameSync(p + ".tmp", p);
  }
  async initialize(receiver: string, configuration: string, emptyBytes: Uint8Array) {
    const existing = this.load(receiver, configuration);
    if (existing) return { status: "existing" as const, ...existing };
    this.save(receiver, configuration, "", emptyBytes);
    return { status: "initialized" as const, bytes: emptyBytes };
  }
  async read(receiver: string, configuration: string) {
    const existing = this.load(receiver, configuration);
    return existing
      ? { status: "image" as const, ...existing }
      : { status: "unavailable" as const, fault: "absent" };
  }
  async compareAndSet(
    receiver: string,
    configuration: string,
    expectedRevision: string,
    bytes: Uint8Array,
    revision: string,
  ) {
    if (this.load(receiver, configuration)?.revision !== expectedRevision)
      return { status: "conflict" as const };
    if (this.fault === "rejected")
      return { status: "rejected" as const, reason: "fixture-rejected" };
    if (this.fault === "unconfirmed-absent")
      return { status: "committed-unconfirmed" as const, fault: "fixture-unconfirmed" };
    if (this.fault === "crash-before-cas") process.exit(3);
    this.save(receiver, configuration, revision, bytes);
    if (this.fault === "crash-after-cas") process.exit(3);
    if (this.fault === "unconfirmed-present")
      return { status: "committed-unconfirmed" as const, fault: "fixture-unconfirmed" };
    return { status: "durable" as const, revision };
  }
}
const isOutcomeClaims = (claims: Delta["claims"]) =>
  claims.pointers.some(
    (p) =>
      p.role === "rhizomatic.materialization.kind" &&
      p.target.kind === "primitive" &&
      p.target.value === "outcome/1",
  );
const lifecycleHost = (dir: string, fault?: FaultKind) => {
  const calls: unknown[] = [];
  const diagnostics: string[] = [];
  const grant: MaterializationSourceCapability = {
    async capture() {
      throw Error("the fixture source never recaptures");
    },
    async reacquireSnapshot() {
      throw Error("the fixture source never restores a snapshot");
    },
    async checkCurrent(binding, revision, authority, at, cutoff, support) {
      calls.push({ binding, revision, authority, at, cutoff, support: [...support] });
      return binding === f.source.binding &&
        revision === f.source.revision &&
        authority === f.source.authority
        ? { status: "current" }
        : { status: "source-changed" };
    },
  };
  const store = new FileControlStore(dir, fault);
  const endpoint = MaterializationEndpoint.boot({
    ...boot,
    signer: {
      author: signer.author,
      sign: (claims) => {
        if (fault === "sign-failure" && isOutcomeClaims(claims))
          throw Error("fixture-signer-fault");
        return signer.sign(claims);
      },
    },
    sourceGrants: new Map([[f.source.binding, grant]]),
    controlStore: store,
    hooks:
      fault === "post-cas-result"
        ? {
            postCasResultMaterialization: () => {
              throw Error("fixture-result-fault");
            },
          }
        : {},
    diagnostic: (e) => {
      diagnostics.push(String(e instanceof Error ? e.message : e));
    },
  });
  return { endpoint, store, calls, diagnostics };
};
const storeState = (store: FileControlStore) => {
  const existing = store.load(signer.author, boot.configuration.id);
  return existing
    ? { revision: existing.revision, bytesHex: bytesToHex(existing.bytes) }
    : { revision: null, bytesHex: null };
};
const step = input.step as
  | {
      verb: MaterializationVerb;
      request: unknown;
      delivery: unknown[];
      initialControl?: { hex: string; revision: string };
    }
  | undefined;
if (input.mode === "construct" && step) {
  // Re-sign the step's request from its decoded fields: only serialized descriptions cross.
  const q = parseCommandDelta(step.request),
    fields = readMaterializationDescription(q, step.verb),
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
    delivery: step.delivery.map((d) =>
      (d as { id: string }).id === q.id ? serializeCommandDelta(constructed) : d,
    ),
  });
} else if (input.mode === "control-execute" || input.mode === "control-read") {
  // A fresh process over the durable directory; the seed writes the step's initial image once.
  const host = lifecycleHost(input.store.dir, input.fault?.kind);
  if (input.seed && step?.initialControl)
    host.store.save(
      signer.author,
      boot.configuration.id,
      step.initialControl.revision,
      hex(step.initialControl.hex),
    );
  const request = input.upstream?.request ?? step!.request,
    delivery = input.upstream?.delivery ?? step!.delivery,
    q = parseCommandDelta(request);
  const outcome = await host.endpoint.invoke(q.id, delivery, receivedAt);
  output({
    request,
    delivery,
    outcome: serializeCommandDelta(outcome),
    preflight: preflightMaterializationInput(boot, q.id, delivery, receivedAt),
    calls: host.calls,
    diagnostics: host.diagnostics,
    store: storeState(host.store),
  });
} else if (input.mode === "control-export") {
  output(storeState(new FileControlStore(input.store.dir)));
} else if (input.mode === "control-restore") {
  // Only the exported bytes and revision enter the fresh directory; then the restore verb runs.
  const host = lifecycleHost(input.store.dir);
  host.store.save(
    signer.author,
    boot.configuration.id,
    input.upstream.revision,
    hex(input.upstream.bytesHex),
  );
  const q = parseCommandDelta(step!.request);
  const outcome = await host.endpoint.invoke(q.id, step!.delivery, receivedAt);
  output({
    request: step!.request,
    outcome: serializeCommandDelta(outcome),
    preflight: preflightMaterializationInput(boot, q.id, step!.delivery, receivedAt),
    store: storeState(host.store),
  });
} else if (input.mode === "control-result") {
  const q = parseCommandDelta(input.upstream.request),
    read = readMaterializationResult(parseCommandDelta(input.upstream.outcome), {
      ...context(q),
      control: hex(input.control.bytesHex),
      ...(input.capture && input.snapshot
        ? { capture: parseCommandDelta(input.capture), snapshot: parseCommandDelta(input.snapshot) }
        : {}),
    });
  output({
    status: read.status,
    classification: read.classification,
    sourceCommitments: read.sourceCommitments,
    receiverTestimony: read.receiverTestimony,
    executionVerified: read.executionVerified,
    bodyHex: bytesToHex(encode(read.body)),
  });
} else if (input.mode === "construct") {
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
