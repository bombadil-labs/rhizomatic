// Test host only. Each stage starts fresh and carries only serialized signed descriptions/results.
import { performance } from "node:perf_hooks";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  Reactor,
  decodeMaterializationControl,
  decodeMaterializationAppearance,
} from "../src/index.js";
import { commandBytes, commandEntity, commandRef } from "../src/command-data/codec.js";
import { bytesToHex } from "../src/delta/hash.js";
import { encode } from "../src/delta/cbor.js";
import type { CommandFields } from "../src/command-data/codec.js";
const input = JSON.parse(readFileSync(0, "utf8"));
const f = input.fixture;
const parseBoot = (b: typeof f.boot) => ({
  configuration: parseCommandDelta(b.configuration),
  declarations: b.declarations.map(parseCommandDelta),
  bindings: b.bindings.map(parseCommandDelta),
});
// ---- Host configuration selection (MR-14): one durable file names the configuration a restart
// boots. A stage over a directory boots the selected configuration; an explicit administrative
// attempt boots the configuration it names and never serves.
const selectionPath = (dir: string) => join(dir, "selected.json");
const readSelection = (dir: string) =>
  existsSync(selectionPath(dir))
    ? (JSON.parse(readFileSync(selectionPath(dir), "utf8")) as {
        configuration: string;
        boot: typeof f.boot;
      })
    : undefined;
const durable = typeof input.store?.dir === "string" ? readSelection(input.store.dir) : undefined;
const selection = input.explicit === true ? undefined : durable;
const boot = parseBoot(selection?.boot ?? f.boot);
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
// The verb a signed request invokes, resolved from its operation and the booted declarations.
// A step's label is only a wrapper; a wrapper that disagrees with the request is refused.
const verbOf = (q: Delta, label?: string) => {
  const operation = commandRef(readMaterializationDescription(q), "operation");
  const declaration = boot.declarations.find((d: Delta) => d.id === operation);
  const name = declaration
    ? commandEntity(readMaterializationDescription(declaration), "name")
    : undefined;
  const verb = name?.startsWith("rhizomatic.materialization.")
    ? name.slice("rhizomatic.materialization.".length)
    : undefined;
  if (label !== undefined && label !== verb)
    throw Error("the step label disagrees with the signed request");
  return verb;
};
// An explicit administrative attempt never serves: the guard follows the signed request.
const explicitNeverServes = (q: Delta, label?: string) => {
  if (input.explicit === true && verbOf(q, label) === "read")
    throw Error("an explicit administrative attempt never serves");
};
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
  | "sign-failure"
  | "race"
  | "source-replaced-before-final-check"
  | "authority-revoked-before-final-check"
  | "source-replaced-after-final-check"
  | "support-refused-before-final-check"
  | "crash-before-activation"
  | "crash-after-activation";
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
// ---- The fixture's independent source provider keeps durable state of its own: one file names
// the source that is current for this directory's host. A race fault moves it after the final
// check and before CAS dispatch; every later process over the directory sees the moved source.
type SourceState = { binding: string; revision: string; authority: string };
const sourceStatePath = (dir: string) => join(dir, "source-state.json");
const currentSource = (dir: string): SourceState =>
  existsSync(sourceStatePath(dir))
    ? (JSON.parse(readFileSync(sourceStatePath(dir), "utf8")) as SourceState)
    : (f.source as SourceState);
const moveSource = (dir: string, to: SourceState) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(sourceStatePath(dir) + ".tmp", JSON.stringify(to));
  renameSync(sourceStatePath(dir) + ".tmp", sourceStatePath(dir));
};
// ---- Host erasure facts and purge debt (MR-15). The host's erasure law is told which acts are
// refused; it keeps that fact in one file, so a restart refuses the same support without being
// told again. Every superseded image is kept as a historical copy until settlement: once no
// active entry reaches a refused act, every historical copy that still carries one is purged.
type ErasureState = { refused: string[] };
const erasurePath = (dir: string) => join(dir, "erasure.json");
const historyDir = (dir: string) => join(dir, "history");
const loadErasure = (dir: string): ErasureState =>
  existsSync(erasurePath(dir))
    ? (JSON.parse(readFileSync(erasurePath(dir), "utf8")) as ErasureState)
    : { refused: [] };
const declareRefused = (dir: string, ids: readonly string[]) => {
  const state = loadErasure(dir);
  const refused = [...new Set([...state.refused, ...ids])].sort();
  if (refused.length !== state.refused.length) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(erasurePath(dir) + ".tmp", JSON.stringify({ refused }));
    renameSync(erasurePath(dir) + ".tmp", erasurePath(dir));
  }
  return refused;
};
const CONTROL_LIMITS = { artifactBytes: 16777216, registrations: 64, definitions: 256 };
// The support an image carries, as delta IDs: each stored appearance decodes to its delta.
const supportOf = (bytes: Uint8Array) =>
  [...decodeMaterializationControl(bytes, CONTROL_LIMITS).deltas.values()].map(
    (appearance) => decodeMaterializationAppearance(appearance).id,
  );
const historyFiles = (dir: string) =>
  existsSync(historyDir(dir))
    ? readdirSync(historyDir(dir))
        .filter((n) => n.endsWith(".json"))
        .map((n) => join(historyDir(dir), n))
    : [];
const keepHistory = (dir: string, configuration: string, revision: string, bytes: Uint8Array) => {
  mkdirSync(historyDir(dir), { recursive: true });
  const p = join(
    historyDir(dir),
    encodeURIComponent(configuration) + "-" + (revision || "empty") + ".json",
  );
  writeFileSync(p + ".tmp", JSON.stringify({ revision, imageHex: bytesToHex(bytes) }));
  renameSync(p + ".tmp", p);
};
/** Settlement: once no active entry reaches a refused act, purge the historical copies that carry one. */
const settle = (dir: string, current: Uint8Array | undefined, purge: boolean) => {
  const { refused } = loadErasure(dir);
  if (!refused.length) return { refused, owed: 0, settled: null as boolean | null, purged: 0 };
  const carries = (bytes: Uint8Array) => supportOf(bytes).some((id) => refused.includes(id));
  const debts = historyFiles(dir).filter((p) =>
    carries(hex((JSON.parse(readFileSync(p, "utf8")) as { imageHex: string }).imageHex)),
  );
  if (current && carries(current))
    return { refused, owed: debts.length, settled: false, purged: 0 };
  if (!purge) return { refused, owed: debts.length, settled: debts.length === 0, purged: 0 };
  for (const p of debts) rmSync(p);
  return { refused, owed: 0, settled: true, purged: debts.length };
};
class FileControlStore implements MaterializationControlStore {
  constructor(
    readonly dir: string,
    readonly fault?: FaultKind,
    /** The image another writer lands between this host's read and its CAS (`race`). */
    readonly raced?: { hex: string; revision: string },
  ) {}
  /** The source the independent provider reported current when CAS was dispatched. */
  sourceAtCas?: SourceState;
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
    // The superseded image stays as a historical copy until settlement purges it.
    const prior = this.load(receiver, configuration);
    if (prior) keepHistory(this.dir, configuration, prior.revision, prior.bytes);
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
    if (this.fault === "race" && this.raced)
      this.save(receiver, configuration, this.raced.revision, hex(this.raced.hex));
    if (this.load(receiver, configuration)?.revision !== expectedRevision)
      return { status: "conflict" as const };
    // The post-check race: the independent source moves after the final check succeeded and
    // before this dispatch. The checked snapshot and the proposed image are unchanged; the
    // host records which source is current at CAS.
    if (this.fault === "source-replaced-after-final-check" && f.movedSource)
      moveSource(this.dir, f.movedSource as SourceState);
    this.sourceAtCas = currentSource(this.dir);
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
const lifecycleHost = (
  dir: string,
  fault?: FaultKind,
  raced?: { hex: string; revision: string },
) => {
  const calls: unknown[] = [];
  const diagnostics: string[] = [];
  // The host's erasure law: the refused acts it is told are durable facts of this directory.
  const refused = declareRefused(dir, (f.refusedSupport ?? []) as string[]);
  // The fixture source is current exactly for the fixture's binding, revision and authority.
  // It is unavailable when the fixture says so, and a race fault moves or revokes it at the
  // named current check: the second check is the final one before CAS for a transition.
  let checks = 0;
  const grant: MaterializationSourceCapability = {
    async capture() {
      throw Error("the fixture source never recaptures");
    },
    async reacquireSnapshot() {
      throw Error("the fixture source never restores a snapshot");
    },
    async checkCurrent(binding, revision, authority, at, cutoff, support) {
      calls.push({ binding, revision, authority, at, cutoff, support: [...support] });
      checks += 1;
      if (f.sourceUnavailable) return { status: "source-unavailable" };
      // A refused act in the explicit required support is unauthorized, from the first check,
      // or from the final check when the fault names it.
      if (
        refused.length &&
        (fault !== "support-refused-before-final-check" || checks >= 2) &&
        support.some((id) => refused.includes(id))
      )
        return { status: "unauthorized" };
      if (fault === "source-replaced-before-final-check" && checks >= 2)
        return { status: "source-changed" };
      if (fault === "authority-revoked-before-final-check" && checks >= 2)
        return { status: "unauthorized" };
      const current = currentSource(dir);
      return binding === current.binding &&
        revision === current.revision &&
        authority === current.authority
        ? { status: "current" }
        : { status: "source-changed" };
    },
  };
  const store = new FileControlStore(dir, fault, raced);
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
    sourceGrants: f.noGrant ? new Map() : new Map([[f.source.binding, grant]]),
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
  const settleNow = (purge: boolean) =>
    settle(dir, store.load(signer.author, boot.configuration.id)?.bytes, purge);
  return { endpoint, store, calls, diagnostics, refused, settleNow };
};
const storeState = (store: FileControlStore) => {
  const existing = store.load(signer.author, boot.configuration.id);
  return existing
    ? { revision: existing.revision, bytesHex: bytesToHex(existing.bytes) }
    : { revision: null, bytesHex: null };
};
// Ordinary retained deltas are inert testimony: a step may name deltas the host retains in a
// reactor before booting; the control endpoint never sees that reactor.
const retainInert = (retained: unknown[] | undefined) => {
  const reactor = new Reactor();
  for (const d of retained ?? [])
    if (reactor.ingest(parseCommandDelta(d)).status !== "accepted")
      throw Error("retained delta rejected");
  return (retained ?? []).length;
};
const step = input.step as
  | {
      verb: MaterializationVerb;
      request: unknown;
      delivery: unknown[];
      initialControl?: { hex: string; revision: string };
      retained?: unknown[];
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
  const host = lifecycleHost(input.store.dir, input.fault?.kind, input.fault?.image);
  if (input.seed && step?.initialControl)
    host.store.save(
      signer.author,
      boot.configuration.id,
      step.initialControl.revision,
      hex(step.initialControl.hex),
    );
  // Seeded historical copies: the physical program-support copies an older host left behind.
  if (input.seed)
    for (const h of (input.seedHistory ?? []) as { revision: string; hex: string }[])
      keepHistory(input.store.dir, boot.configuration.id, h.revision, hex(h.hex));
  // Reopen settles first: a crash after a durable retire may have left purge debt behind.
  const atBoot = host.settleNow(true);
  const retained = retainInert(step?.retained);
  const request = input.upstream?.request ?? step!.request,
    delivery = input.upstream?.delivery ?? step!.delivery,
    q = parseCommandDelta(request);
  explicitNeverServes(q, step?.verb);
  const outcome = await host.endpoint.invoke(q.id, delivery, receivedAt);
  const afterAttempt = host.settleNow(true);
  output({
    request,
    delivery,
    outcome: serializeCommandDelta(outcome),
    preflight: preflightMaterializationInput(boot, q.id, delivery, receivedAt),
    calls: host.calls,
    diagnostics: host.diagnostics,
    retained,
    sourceAtCas: host.store.sourceAtCas ?? null,
    erasure: { refused: host.refused, atBoot, afterAttempt },
    selected: durable?.configuration ?? null,
    store: storeState(host.store),
  });
} else if (input.mode === "control-export") {
  // An export reads; it never settles.
  const store = new FileControlStore(input.store.dir);
  output({
    ...storeState(store),
    selected: durable?.configuration ?? null,
    erasure: settle(
      input.store.dir,
      store.load(signer.author, boot.configuration.id)?.bytes,
      false,
    ),
  });
} else if (input.mode === "control-restore") {
  // Only the exported bytes and revision enter the fresh directory; then the restore verb runs.
  const host = lifecycleHost(input.store.dir);
  host.store.save(
    signer.author,
    boot.configuration.id,
    input.upstream.revision,
    hex(input.upstream.bytesHex),
  );
  const retained = retainInert(step?.retained);
  const q = parseCommandDelta(step!.request);
  explicitNeverServes(q, step!.verb);
  const outcome = await host.endpoint.invoke(q.id, step!.delivery, receivedAt);
  output({
    request: step!.request,
    outcome: serializeCommandDelta(outcome),
    preflight: preflightMaterializationInput(boot, q.id, step!.delivery, receivedAt),
    retained,
    erasure: { refused: host.refused, afterAttempt: host.settleNow(true) },
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
} else if (input.mode === "control-select") {
  // Durable activation: one renamed file selects the fixture's configuration for every later
  // boot over this directory. A crash before the rename leaves the old selection; a crash after
  // it leaves the new one, although this process answers nothing.
  if (input.fault?.kind === "crash-before-activation") process.exit(3);
  const own = parseBoot(f.boot);
  mkdirSync(input.store.dir, { recursive: true });
  writeFileSync(
    selectionPath(input.store.dir) + ".tmp",
    JSON.stringify({ configuration: own.configuration.id, boot: f.boot }),
  );
  renameSync(selectionPath(input.store.dir) + ".tmp", selectionPath(input.store.dir));
  if (input.fault?.kind === "crash-after-activation") process.exit(3);
  output({ selected: own.configuration.id });
} else throw Error("unknown fixture mode");
