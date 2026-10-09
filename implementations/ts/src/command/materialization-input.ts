// SPEC-16 MR-21 ordered pure input phases; native source checks are explicit orchestration gaps.
import { encode } from "../delta/cbor.js";
import { captureDeltaDebugDelivery, DeltaDebugCaptureError } from "../delta/json-profile.js";
import { contentAddress } from "../delta/hash.js";
import type { Delta } from "../delta/types.js";
import {
  parseCommandDelta,
  verifyCommandAppearance,
  commandText,
  commandRef,
  commandEntity,
  commandNumber,
  commandBytes,
  type CommandFields,
} from "../command-data/codec.js";
import {
  readMaterializationDescription,
  readMaterializationLimits,
  materializationOperationVerb,
  MATERIALIZATION_PREFIX,
  MATERIALIZATION_RELEASE_VERBS,
  type MaterializationLimits,
  type MaterializationVerb,
} from "../command-data/materialization-codec.js";
import {
  decodeMaterializationBindingSpec,
  decodeMaterializationAuthoritySpec,
  decodeMaterializationSnapshotEvidence,
  MaterializationSourceError,
} from "../federation/materialization-source.js";
import { readMaterializationDefinitions } from "../schema-load/command-definitions.js";
import { validateMaterializationProgram, CommandProgramError } from "../schema/command-program.js";
import { decodeBindings } from "../command-data/codec.js";
import { materializationBasisProgram } from "./materialization-basis.js";
import {
  mFail,
  mCanonical,
  mText,
  mFields,
  MaterializationInputError,
} from "./materialization-values.js";
export interface MaterializationInputBoot {
  readonly configuration: Delta;
  readonly declarations: readonly Delta[];
  readonly bindings: readonly Delta[];
}
export interface MaterializationInputCatalog {
  readonly configuration: Delta;
  readonly receiver: string;
  readonly fields: CommandFields;
  readonly limits: MaterializationLimits;
  readonly operations: ReadonlyMap<string, { delta: Delta; verb: MaterializationVerb }>;
  readonly bindings: ReadonlyMap<string, Delta>;
  /** Release A installs gather/resolve only; release B installs all eight verbs (MR-08). */
  readonly release: "A" | "B";
}
export const materializationValidAt = (d: Delta, at: number): boolean =>
  d.claims.validFrom <= at && (d.claims.validUntil === undefined || at < d.claims.validUntil);
export function materializationInputCatalog(
  boot: MaterializationInputBoot,
): MaterializationInputCatalog {
  const configuration = structuredClone(boot.configuration);
  verifyCommandAppearance(configuration);
  const f = readMaterializationDescription(configuration);
  if (commandText(f, "kind") !== "endpoint/1") throw Error("invalid materialization boot");
  const receiver = commandEntity(f, "receiver");
  if (configuration.claims.author !== receiver) throw Error("invalid boot authority");
  const operations = new Map<string, { delta: Delta; verb: MaterializationVerb }>();
  for (const original of boot.declarations) {
    const d = structuredClone(original);
    verifyCommandAppearance(d);
    const fields = readMaterializationDescription(d);
    if (d.claims.author !== receiver || commandText(fields, "kind") !== "operation/1")
      throw Error("invalid operation authority");
    const verb = materializationOperationVerb(commandEntity(fields, "name"));
    operations.set(d.id, { delta: d, verb });
  }
  const installed = (f.installed ?? []).map((t) => commandRef({ x: [t] }, "x"));
  const verbs = [...new Set([...operations.values()].map((o) => o.verb))].sort();
  const release = (["A", "B"] as const).find(
    (r) =>
      verbs.length === MATERIALIZATION_RELEASE_VERBS[r].length &&
      [...MATERIALIZATION_RELEASE_VERBS[r]].sort().every((v, i) => v === verbs[i]),
  );
  if (
    release === undefined ||
    operations.size !== verbs.length ||
    boot.declarations.length !== verbs.length ||
    installed.length !== verbs.length ||
    installed.some((i) => !operations.has(i))
  )
    throw Error("invalid operation catalog");
  const bindings = new Map<string, Delta>(),
    sourceIds = new Set<string>();
  for (const original of boot.bindings) {
    const d = structuredClone(original);
    verifyCommandAppearance(d);
    const fields = readMaterializationDescription(d);
    if (
      commandText(fields, "kind") !== "source-binding/1" ||
      d.claims.author !== receiver ||
      commandEntity(fields, "receiver") !== receiver
    )
      throw Error("invalid binding authority");
    const spec = decodeMaterializationBindingSpec(commandBytes(fields, "spec"));
    if (sourceIds.has(spec.sourceId) || bindings.has(d.id)) throw Error("duplicate binding");
    sourceIds.add(spec.sourceId);
    bindings.set(d.id, d);
  }
  const selected = (f["source-binding"] ?? []).map((t) => commandRef({ x: [t] }, "x"));
  if (selected.length !== bindings.size || selected.some((i) => !bindings.has(i)))
    throw Error("invalid selected bindings");
  return {
    configuration,
    receiver,
    fields: f,
    limits: readMaterializationLimits(commandBytes(f, "limits")),
    operations,
    bindings,
    release,
  };
}
export interface MaterializationPreparedInput {
  readonly entry: Delta;
  readonly fields: CommandFields;
  readonly verb: MaterializationVerb;
  readonly supplied: ReadonlyMap<string, Delta>;
  readonly requiredSupport: readonly string[];
  readonly capture?: Delta;
  readonly snapshotBytes?: Uint8Array;
  readonly evidenceBody?: ReturnType<typeof mCanonical>;
}
/** Stage-1 count scan never decodes a target or nested byte payload. */
export function checkMaterializationDeliveryCounts(
  appearances: readonly unknown[],
  limits: MaterializationLimits,
): void {
  let issued: MaterializationInputError | undefined;
  const fail: (code: string) => never = (code) => {
    issued = new MaterializationInputError(code);
    throw issued;
  };
  const bound = (n: number, max: number): void => {
    if (n > max) fail("resource-limit");
  };
  try {
    const length = appearances.length;
    if (!Number.isSafeInteger(length) || length < 0) fail("invalid-appearance");
    bound(length, limits.deliveryAppearances);
    const counts: number[] = [];
    for (let i = 0; i < length; i++) {
      const value = appearances[i];
      if (typeof value !== "object" || value === null || !("claims" in value))
        fail("invalid-appearance");
      const claims = value.claims;
      if (
        typeof claims !== "object" ||
        claims === null ||
        !("pointers" in claims) ||
        !Array.isArray(claims.pointers)
      )
        fail("invalid-appearance");
      const count = claims.pointers.length;
      if (!Number.isSafeInteger(count) || count < 0) fail("invalid-appearance");
      counts.push(count);
    }
    for (const count of counts) bound(count, limits.pointers);
  } catch (error) {
    if (issued !== undefined && error === issued) throw issued;
    mFail("invalid-appearance");
  }
}
export function prepareMaterializationInput(
  c: MaterializationInputCatalog,
  entryId: string,
  appearances: readonly unknown[],
  receivedAt: number,
): MaterializationPreparedInput {
  checkMaterializationDeliveryCounts(appearances, c.limits);
  let deltas: Delta[];
  try {
    const captured = captureDeltaDebugDelivery(appearances, c.limits);
    deltas = captured.map(parseCommandDelta);
  } catch (error) {
    return mFail(error instanceof DeltaDebugCaptureError ? error.code : "invalid-appearance");
  }
  try {
    deltas.forEach(verifyCommandAppearance);
  } catch {
    return mFail("invalid-appearance");
  }
  const supplied = new Map<string, Delta>();
  for (const d of deltas) {
    const old = supplied.get(d.id);
    if (!old || d.sig! < old.sig!) supplied.set(d.id, d);
  }
  const entry = supplied.get(entryId);
  if (!entry) return mFail("entry-missing");
  let common;
  try {
    common = readMaterializationDescription(entry);
    if (commandText(common, "kind") !== "request/1") throw Error();
  } catch {
    return mFail("invalid-request");
  }
  if (!materializationValidAt(entry, receivedAt)) mFail("request-outside-validity");
  const operation = c.operations.get(commandRef(common, "operation"));
  if (
    commandEntity(common, "receiver") !== c.receiver ||
    commandRef(common, "configuration") !== c.configuration.id ||
    !materializationValidAt(c.configuration, receivedAt) ||
    (operation && !materializationValidAt(operation.delta, receivedAt))
  )
    mFail("configuration-mismatch");
  if (
    !(c.fields.caller ?? []).some((t) => t.kind === "primitive" && t.value === entry.claims.author)
  )
    mFail("unauthorized");
  if (!operation) return mFail("unsupported-operation");
  let fields: CommandFields;
  try {
    fields = readMaterializationDescription(entry, operation.verb);
    if (fields["serving-at"] && commandNumber(fields, "serving-at") !== receivedAt) throw Error();
  } catch {
    return mFail("invalid-arguments");
  }
  const verb = operation.verb;
  let requiredSupport =
    verb === "gather"
      ? [
          commandRef(fields, "hyperschema"),
          commandRef(fields, "schema"),
          ...(fields.definition ?? []).map((t) => commandRef({ x: [t] }, "x")),
        ].sort()
      : [];
  // Direct delivered supports per verb (MR-12); stored support is never redelivered.
  const direct =
    verb === "gather"
      ? [commandRef(fields, "capture"), commandRef(fields, "snapshot"), ...requiredSupport]
      : verb === "resolve"
        ? [commandRef(fields, "evidence")]
        : verb === "install"
          ? [
              commandRef(fields, "registration"),
              commandRef(fields, "capture"),
              commandRef(fields, "snapshot"),
            ]
          : verb === "replace-source"
            ? [commandRef(fields, "capture"), commandRef(fields, "snapshot")]
            : verb === "advance-time" || verb === "read"
              ? [commandRef(fields, "snapshot")]
              : [];
  if (direct.some((i) => !supplied.has(i))) mFail("missing-support");
  const reachable = new Set([entryId, ...direct]);
  if (verb === "install") {
    // The named descriptor must be a registration act; its closure is delivered in full.
    let descriptor;
    try {
      descriptor = readMaterializationDescription(
        supplied.get(commandRef(fields, "registration"))!,
      );
      if (commandText(descriptor, "kind") !== "registration/1") throw Error();
    } catch {
      return mFail("invalid-arguments");
    }
    requiredSupport = [
      commandRef(descriptor, "hyperschema"),
      commandRef(descriptor, "schema"),
      ...(descriptor.definition ?? []).map((t) => commandRef({ x: [t] }, "x")),
    ].sort();
    if (requiredSupport.some((i) => !supplied.has(i))) mFail("missing-support");
    for (const i of requiredSupport) reachable.add(i);
  }
  const capture =
    verb === "gather" || verb === "install" || verb === "replace-source"
      ? supplied.get(commandRef(fields, "capture"))
      : undefined;
  if (capture) {
    const ps = capture.claims.pointers.filter(
      (p) => p.role === MATERIALIZATION_PREFIX + "authority",
    );
    if (
      ps.length === 1 &&
      ps[0]!.target.kind === "delta" &&
      ps[0]!.target.deltaRef.context === undefined
    ) {
      const id = ps[0]!.target.deltaRef.delta;
      if (!supplied.has(id)) mFail("missing-support");
      reachable.add(id);
    }
  }
  if ([...supplied.keys()].some((i) => !reachable.has(i))) mFail("unexpected-support");
  if (verb === "retire" || verb === "restore")
    return { entry, fields, verb, supplied, requiredSupport };
  if (verb === "resolve") {
    let evidenceFields;
    try {
      evidenceFields = readMaterializationDescription(
        supplied.get(commandRef(fields, "evidence"))!,
      );
      if (commandText(evidenceFields, "kind") !== "evidence/1") throw Error();
    } catch {
      return mFail("invalid-evidence");
    }
    const body = mCanonical(commandBytes(evidenceFields, "result"), c.limits.artifactBytes);
    return { entry, fields, verb: operation.verb, supplied, requiredSupport, evidenceBody: body };
  }
  let snapshotBytes: Uint8Array;
  try {
    const s = readMaterializationDescription(supplied.get(commandRef(fields, "snapshot"))!);
    if (commandText(s, "kind") !== "snapshot/1") throw Error();
    snapshotBytes = commandBytes(s, "data");
  } catch {
    return mFail("invalid-source");
  }
  const raw = mCanonical(snapshotBytes, c.limits.artifactBytes, "invalid-source");
  if (
    raw.t !== "map" ||
    !raw.v.some(
      ([k, v]) => k === "format" && v.t === "tstr" && v.v === "rhizomatic.source-snapshot/1",
    )
  )
    mFail("invalid-source");
  return {
    entry,
    fields,
    verb,
    supplied,
    requiredSupport,
    ...(capture ? { capture } : {}),
    snapshotBytes,
  };
}
/** Syntactic binding identity for grant lookup BEFORE source evidence validation. */
export function materializationRequiredBinding(p: MaterializationPreparedInput): string {
  const targets = p.capture!.claims.pointers.filter(
    (p) => p.role === MATERIALIZATION_PREFIX + "source-binding",
  );
  if (
    targets.length !== 1 ||
    targets[0]!.target.kind !== "delta" ||
    targets[0]!.target.deltaRef.context !== undefined ||
    !/^1e20[0-9a-f]{64}$/.test(targets[0]!.target.deltaRef.delta)
  )
    mFail("invalid-source");
  return targets[0]!.target.deltaRef.delta;
}
export function validateMaterializationSourceInput(
  c: MaterializationInputCatalog,
  p: MaterializationPreparedInput,
  receivedAt: number,
) {
  const bindingId = materializationRequiredBinding(p),
    binding = c.bindings.get(bindingId);
  if (!binding) return mFail("unauthorized");
  if (!materializationValidAt(binding, receivedAt)) mFail("configuration-mismatch");
  try {
    const b = readMaterializationDescription(binding),
      spec = decodeMaterializationBindingSpec(commandBytes(b, "spec"), c.limits.artifactBytes);
    const capture = p.capture!,
      cf = readMaterializationDescription(capture),
      authority = p.supplied.get(commandRef(cf, "authority"));
    if (!authority) throw Error();
    const af = readMaterializationDescription(authority);
    if (commandText(af, "kind") !== "authority/1") throw Error();
    const authoritySpec = decodeMaterializationAuthoritySpec(
        commandBytes(af, "spec"),
        c.limits.artifactBytes,
      ),
      decoded = decodeMaterializationSnapshotEvidence(p.snapshotBytes!, c.limits),
      snapshot = decoded.snapshot;
    if (
      capture.claims.author !== spec.capturer ||
      authority.claims.author !== spec.capturer ||
      commandRef(af, "source-binding") !== bindingId ||
      snapshot.binding !== bindingId ||
      snapshot.authority !== authority.id ||
      authoritySpec.root !== spec.authorityRoot ||
      snapshot.selection !== contentAddress(encode(spec.selection)) ||
      capture.claims.timestamp !== snapshot.servingAt ||
      capture.claims.validFrom !== snapshot.servingAt ||
      !materializationValidAt(capture, snapshot.servingAt) ||
      !materializationValidAt(authority, receivedAt) ||
      snapshot.historicalCutoff !==
        (p.fields["historical-cutoff"] ? commandNumber(p.fields, "historical-cutoff") : undefined)
    )
      throw Error();
    decoded.validateCaptureBasis(commandBytes(cf, "basis"));
    return snapshot;
  } catch (e) {
    if (e instanceof MaterializationSourceError && e.code === "resource-limit") mFail(e.code);
    if (e instanceof MaterializationInputError) throw e;
    return mFail("invalid-source");
  }
}
export function validateMaterializationInputProgram(
  c: MaterializationInputCatalog,
  p: MaterializationPreparedInput,
) {
  if (p.verb === "resolve") {
    const body = mFields(p.evidenceBody!, [
      "kind",
      "root",
      "basis",
      "envelope",
      "transport",
      "hview",
    ]);
    if (mText(body.get("kind")) !== "gather") mFail();
    return materializationBasisProgram(body.get("basis")!, c.limits);
  }
  const deltas = p.requiredSupport.map((i) => p.supplied.get(i)!);
  let definitions;
  try {
    definitions = readMaterializationDefinitions(
      deltas,
      commandNumber(p.fields, "definition-at"),
      c.limits,
    );
  } catch (e) {
    return mFail(
      e instanceof Error && e.message === "resource-limit"
        ? "resource-limit"
        : "invalid-definition",
    );
  }
  if (
    definitions.find((d) => d.id === commandRef(p.fields, "hyperschema"))?.kind !== "hyper" ||
    definitions.find((d) => d.id === commandRef(p.fields, "schema"))?.kind !== "reading"
  )
    mFail("invalid-definition");
  const bindings = new Map(Object.entries(decodeBindings(commandBytes(p.fields, "bindings"))));
  try {
    return {
      selected: validateMaterializationProgram(
        definitions,
        commandRef(p.fields, "hyperschema"),
        commandRef(p.fields, "schema"),
        commandText(p.fields, "hyperschema-pin"),
        commandText(p.fields, "schema-pin"),
        bindings,
      ),
      bindings,
      deltas,
    };
  } catch (e) {
    if (e instanceof CommandProgramError) return mFail(e.code);
    throw e;
  }
}
