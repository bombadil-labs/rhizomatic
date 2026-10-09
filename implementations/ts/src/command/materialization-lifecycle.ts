// SPEC-16 MR-13..18: the six maintained verbs. Stage 5 reads and classifies the durable control
// image, stage 6 checks the explicit source, stage 7 the stored or supplied program, stage 8
// computes every root and the prospective transition and image, and stage 9 performs the CAS.
// Nothing here reaches a store except through the explicit boot capability.
import { array, bstr, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { canonicalBytes } from "../delta/delta.js";
import { DeltaSet } from "../delta/set.js";
import { bytesToHex, contentAddress } from "../delta/hash.js";
import type { Delta, Target } from "../delta/types.js";
import {
  commandBytes,
  commandNumber,
  commandRef,
  commandText,
  decodeBindings,
  verifyCommandAppearance,
  type CommandFields,
} from "../command-data/codec.js";
import {
  materializationDescriptionClaims,
  readMaterializationDescription,
  type MaterializationLimits,
  type MaterializationVerb,
} from "../command-data/materialization-codec.js";
import {
  decodeMaterializationAppearance,
  decodeMaterializationAuthoritySpec,
  decodeMaterializationBindingSpec,
  decodeMaterializationSnapshotEvidence,
  encodeMaterializationAppearance,
  MaterializationSourceError,
  type MaterializationSourceCapability,
  type MaterializationSourceSnapshot,
} from "../federation/materialization-source.js";
import {
  decodeMaterializationControl,
  emptyMaterializationControl,
  encodeMaterializationControl,
  materializationAppearanceKey,
  materializationControlImage,
  materializationControlRevision,
  planMaterializationControl,
  MaterializationControlError,
  type MaterializationControlEntry,
  type MaterializationControlImage,
  type MaterializationControlLimits,
  type MaterializationControlSelection,
  type MaterializationControlStore,
  type MaterializationControlTransition,
} from "../federation/materialization-control.js";
import { readMaterializationDefinitions } from "../schema-load/command-definitions.js";
import { validateMaterializationProgram, CommandProgramError } from "../schema/command-program.js";
import { EvaluationResourceLimit } from "../resolve/evaluation-budget.js";
import { evalMaterializationTerm } from "../resolve/eval.js";
import { encodeHViewEnvelope, hviewCanonicalHex } from "../resolve/evidence.js";
import { EvidenceCodecError } from "../syntax/evidence-codec.js";
import { bindReadingVariables } from "../syntax/bind-reading.js";
import { resolveView, viewCanonicalHex } from "../resolve-kernel/resolution.js";
import type { CommandSigner } from "./endpoint.js";
import { gatherMaterializationBasis } from "./materialization-basis.js";
import {
  materializationHasMissingReading,
  materializationHexBytes,
} from "./materialization-evidence.js";
import {
  materializationValidAt,
  type MaterializationInputCatalog,
  type MaterializationPreparedInput,
} from "./materialization-input.js";
import { mFail, mLimit, MaterializationInputError } from "./materialization-values.js";

export type MaterializationLifecycleVerb = Exclude<MaterializationVerb, "gather" | "resolve">;
export const isLifecycleVerb = (v: MaterializationVerb): v is MaterializationLifecycleVerb =>
  v !== "gather" && v !== "resolve";
const CONTROL_VERBS = new Set(["install", "replace-source", "advance-time", "retire"]);

/** Named post-CAS fault point (MR-16): a host may inject a known failure after confirmed CAS. */
export interface MaterializationLifecycleHooks {
  readonly postCasResultMaterialization?: (control: string) => void;
}
export interface MaterializationLifecycleHost {
  readonly catalog: MaterializationInputCatalog;
  readonly signer: CommandSigner;
  readonly sourceGrants: ReadonlyMap<string, MaterializationSourceCapability>;
  readonly controlStore: MaterializationControlStore;
  readonly hooks: MaterializationLifecycleHooks;
  readonly diagnostic: (fault: unknown) => void;
}
export type MaterializationLifecycleOutcome =
  | { readonly status: "completed"; readonly body: CborValue }
  | { readonly status: "refused"; readonly body: CborValue }
  | { readonly status: "indeterminate"; readonly body: CborValue };

/** Normalized registration descriptor fields (MR-13). */
interface Descriptor {
  readonly delta: Delta;
  readonly binding: string;
  readonly hyper: string;
  readonly hyperPin: string;
  readonly reading: string;
  readonly readingPin: string;
  readonly definitions: readonly string[];
  readonly roots: readonly string[];
  readonly bindings: Uint8Array;
  readonly definitionAt: number;
}
export function readRegistrationDescriptor(delta: Delta): Descriptor | undefined {
  let f: CommandFields;
  try {
    f = readMaterializationDescription(delta);
    if (commandText(f, "kind") !== "registration/1") return undefined;
  } catch {
    return undefined;
  }
  const one = (t: Target) => commandRef({ x: [t] }, "x");
  return {
    delta,
    binding: commandRef(f, "source-binding"),
    hyper: commandRef(f, "hyperschema"),
    hyperPin: commandText(f, "hyperschema-pin"),
    reading: commandRef(f, "schema"),
    readingPin: commandText(f, "schema-pin"),
    definitions: (f.definition ?? []).map(one),
    roots: (f.roots ?? []).map((t) => (t.kind === "entity" ? t.entity.id : mFail())),
    bindings: commandBytes(f, "bindings"),
    definitionAt: commandNumber(f, "definition-at"),
  };
}
/** Closure IDs a descriptor names: both top acts and every definition support (MR-11). */
export const descriptorClosure = (d: Descriptor): string[] =>
  [d.hyper, d.reading, ...d.definitions].sort();

/** One active entry's verified stored support after restore classification (MR-17). */
interface StoredEntry {
  readonly entry: MaterializationControlEntry;
  readonly transition: Delta;
  readonly descriptor?: Descriptor;
  readonly definitions: readonly Delta[];
  readonly capture?: Delta;
  readonly authority?: Delta;
  readonly support: Map<string, Uint8Array>;
}
interface ControlState {
  readonly bytes: Uint8Array;
  readonly revision: string;
  readonly image: MaterializationControlImage;
  readonly selection: MaterializationControlSelection;
  readonly stored: ReadonlyMap<string, StoredEntry>;
}
const controlLimits = (l: MaterializationLimits): MaterializationControlLimits => ({
  artifactBytes: l.artifactBytes,
  registrations: l.registrations,
  definitions: l.definitions,
});
const invalidControl = (): never => mFail("invalid-control");

/** Stage 5: read, decode and classify the complete image; every reachable support is exact. */
async function readControl(host: MaterializationLifecycleHost): Promise<ControlState> {
  const c = host.catalog;
  const read = await host.controlStore.read(c.receiver, c.configuration.id);
  if (read.status !== "image") return mFail("control-unavailable");
  let image: MaterializationControlImage;
  try {
    image = decodeMaterializationControl(read.bytes, controlLimits(c.limits));
  } catch (e) {
    if (e instanceof MaterializationControlError) mFail(e.code);
    throw e;
  }
  if (image.receiver !== c.receiver || image.configuration !== c.configuration.id) invalidControl();
  const revision = materializationControlRevision(read.bytes, image.generation);
  if (read.revision !== revision) invalidControl();
  // Decode every appearance once; signatures and canonical bytes are verified here.
  const acts = new Map<string, { delta: Delta; key: string; fields?: CommandFields }>();
  const byId = new Map<string, string>();
  for (const [key, bytes] of image.deltas) {
    let delta: Delta;
    try {
      delta = decodeMaterializationAppearance(bytes, c.limits);
    } catch (e) {
      if (e instanceof MaterializationSourceError && e.code === "resource-limit") mFail(e.code);
      return invalidControl();
    }
    if (byId.has(delta.id)) invalidControl();
    byId.set(delta.id, key);
    let fields: CommandFields | undefined;
    try {
      fields = readMaterializationDescription(delta);
    } catch {
      fields = undefined;
    }
    acts.set(key, fields ? { delta, key, fields } : { delta, key });
  }
  const act = (id: string) => {
    const key = byId.get(id);
    return key === undefined ? undefined : acts.get(key)!;
  };
  const stored = new Map<string, StoredEntry>();
  const reachable = new Set<string>();
  let latest = 0;
  const generations = new Set<number>();
  for (const entry of image.entries) {
    const t = act(entry.transition);
    if (!t?.fields || commandText(t.fields, "kind") !== "state/1") return invalidControl();
    const tf = t.fields;
    const generation = commandNumber(tf, "generation");
    if (
      t.delta.claims.author !== c.receiver ||
      commandRef(tf, "registration") !== entry.registration ||
      (commandText(tf, "verb") === "retire") !== (entry.status === "retired") ||
      commandText(tf, "source-revision") !== entry.sourceRevision ||
      commandText(tf, "authority") !== entry.authority ||
      commandNumber(tf, "at") !== entry.at ||
      commandNumber(tf, "definition-at") !== entry.definitionAt ||
      commandText(tf, "hyperschema-pin") !== entry.hyperschemaPin ||
      commandText(tf, "schema-pin") !== entry.schemaPin ||
      (tf.capture ? commandRef(tf, "capture") : undefined) !== entry.capture ||
      generation > image.generation ||
      generations.has(generation)
    )
      return invalidControl();
    generations.add(generation);
    latest = Math.max(latest, generation);
    const support = new Map<string, Uint8Array>([[t.key, image.deltas.get(t.key)!]]);
    reachable.add(t.key);
    if (entry.status === "retired") {
      stored.set(entry.registration, { entry, transition: t.delta, definitions: [], support });
      continue;
    }
    const d = act(entry.registration);
    const descriptor = d ? readRegistrationDescriptor(d.delta) : undefined;
    if (!descriptor) return invalidControl();
    if (
      descriptor.hyperPin !== entry.hyperschemaPin ||
      descriptor.readingPin !== entry.schemaPin ||
      descriptor.definitionAt !== entry.definitionAt
    )
      return invalidControl();
    support.set(d!.key, image.deltas.get(d!.key)!);
    reachable.add(d!.key);
    const definitions: Delta[] = [];
    for (const id of descriptorClosure(descriptor)) {
      const a = act(id);
      if (!a) return invalidControl();
      definitions.push(a.delta);
      support.set(a.key, image.deltas.get(a.key)!);
      reachable.add(a.key);
    }
    const cap = act(entry.capture!);
    if (!cap?.fields || commandText(cap.fields, "kind") !== "capture/1") return invalidControl();
    if (commandRef(cap.fields, "source-binding") !== descriptor.binding) return invalidControl();
    const auth = act(commandRef(cap.fields, "authority"));
    if (!auth?.fields || commandText(auth.fields, "kind") !== "authority/1")
      return invalidControl();
    if (auth.delta.id !== entry.authority) return invalidControl();
    support.set(cap.key, image.deltas.get(cap.key)!);
    support.set(auth.key, image.deltas.get(auth.key)!);
    reachable.add(cap.key);
    reachable.add(auth.key);
    stored.set(entry.registration, {
      entry,
      transition: t.delta,
      descriptor,
      definitions,
      capture: cap.delta,
      authority: auth.delta,
      support,
    });
  }
  if (image.entries.length > 0 && latest !== image.generation) invalidControl();
  if (reachable.size !== image.deltas.size) invalidControl();
  const selection: MaterializationControlSelection = {
    receiver: image.receiver,
    configuration: image.configuration,
    generation: image.generation,
    entries: new Map([...stored].map(([k, s]) => [k, { entry: s.entry, support: s.support }])),
  };
  return { bytes: read.bytes, revision, image, selection, stored };
}

interface SourceCheck {
  readonly binding: string;
  readonly grant: MaterializationSourceCapability;
  readonly snapshot: MaterializationSourceSnapshot;
  readonly capture: Delta;
  readonly authority: Delta;
}
/** Stage 6 for a maintained verb: grant, binding, supplied or committed snapshot, authority. */
function checkSource(
  host: MaterializationLifecycleHost,
  p: MaterializationPreparedInput,
  descriptor: Descriptor,
  stored: StoredEntry | undefined,
  receivedAt: number,
): SourceCheck {
  const c = host.catalog;
  const grant = host.sourceGrants.get(descriptor.binding);
  if (!grant) return mFail("unauthorized");
  const binding = c.bindings.get(descriptor.binding);
  if (!binding) return mFail("unauthorized");
  if (!materializationValidAt(binding, receivedAt)) mFail("configuration-mismatch");
  const fresh = p.verb === "install" || p.verb === "replace-source";
  try {
    const spec = decodeMaterializationBindingSpec(
      commandBytes(readMaterializationDescription(binding), "spec"),
      c.limits.artifactBytes,
    );
    const capture = fresh ? p.capture! : stored!.capture!;
    const cf = readMaterializationDescription(capture);
    const authority = fresh ? p.supplied.get(commandRef(cf, "authority")) : stored!.authority;
    if (!authority) throw Error();
    const af = readMaterializationDescription(authority);
    if (commandText(af, "kind") !== "authority/1") throw Error();
    const authoritySpec = decodeMaterializationAuthoritySpec(
      commandBytes(af, "spec"),
      c.limits.artifactBytes,
    );
    const decoded = decodeMaterializationSnapshotEvidence(p.snapshotBytes!, c.limits),
      snapshot = decoded.snapshot;
    if (
      capture.claims.author !== spec.capturer ||
      authority.claims.author !== spec.capturer ||
      commandRef(af, "source-binding") !== descriptor.binding ||
      commandRef(cf, "source-binding") !== descriptor.binding ||
      snapshot.binding !== descriptor.binding ||
      snapshot.authority !== authority.id ||
      authoritySpec.root !== spec.authorityRoot ||
      snapshot.selection !== contentAddress(encode(spec.selection)) ||
      capture.claims.timestamp !== snapshot.servingAt ||
      capture.claims.validFrom !== snapshot.servingAt ||
      !materializationValidAt(capture, snapshot.servingAt) ||
      !materializationValidAt(authority, receivedAt) ||
      snapshot.historicalCutoff !== undefined
    )
      throw Error();
    // The committed capture commits to the exact snapshot bytes (MR-10); a fresh carrier may
    // carry them, and a replacement capture must stay on the same binding.
    decoded.validateCaptureBasis(commandBytes(cf, "basis"));
    if (
      !fresh &&
      (snapshot.revision !== stored!.entry.sourceRevision ||
        snapshot.authority !== stored!.entry.authority)
    )
      throw Error();
    return { binding: descriptor.binding, grant, snapshot, capture, authority };
  } catch (e) {
    if (e instanceof MaterializationSourceError && e.code === "resource-limit") mFail(e.code);
    if (e instanceof MaterializationInputError) throw e;
    return mFail("invalid-source");
  }
}

interface Program {
  readonly deltas: readonly Delta[];
  readonly bindings: Map<string, string | number | boolean>;
  readonly selected: ReturnType<typeof validateMaterializationProgram>;
}
/** Stage 7: exact acts valid at the descriptor's definition-at; descriptor valid now. */
function checkProgram(
  c: MaterializationInputCatalog,
  descriptor: Descriptor,
  deltas: readonly Delta[],
  receivedAt: number,
): Program {
  if (!materializationValidAt(descriptor.delta, receivedAt)) mFail("invalid-definition");
  let definitions;
  try {
    definitions = readMaterializationDefinitions(deltas, descriptor.definitionAt, c.limits);
  } catch (e) {
    return mFail(
      e instanceof Error && e.message === "resource-limit"
        ? "resource-limit"
        : "invalid-definition",
    );
  }
  if (
    definitions.find((d) => d.id === descriptor.hyper)?.kind !== "hyper" ||
    definitions.find((d) => d.id === descriptor.reading)?.kind !== "reading"
  )
    mFail("invalid-definition");
  const bindings = new Map(Object.entries(decodeBindings(descriptor.bindings)));
  try {
    return {
      deltas,
      bindings,
      selected: validateMaterializationProgram(
        definitions,
        descriptor.hyper,
        descriptor.reading,
        descriptor.hyperPin,
        descriptor.readingPin,
        bindings,
      ),
    };
  } catch (e) {
    if (e instanceof CommandProgramError) return mFail(e.code);
    throw e;
  }
}

/** Stage 8: one root's complete envelope and View (MR-19 RootResult). */
function materializeRoot(
  c: MaterializationInputCatalog,
  program: Program,
  snapshot: MaterializationSourceSnapshot,
  at: number,
  root: string,
  diagnostic: (fault: unknown) => void,
): CborValue {
  let gathered;
  try {
    gathered = evalMaterializationTerm(
      program.selected.hyper.body,
      DeltaSet.from(snapshot.deltas),
      at,
      c.limits,
      root,
      program.selected.registry,
      program.bindings,
    );
  } catch (e) {
    if (e instanceof EvaluationResourceLimit) mFail("resource-limit");
    diagnostic(e);
    mFail("execution-failed");
  }
  if (gathered.sort !== "hview") mFail("execution-failed");
  let envelope: Uint8Array;
  try {
    envelope = encodeHViewEnvelope(gathered.hview, {
      artifactBytes: c.limits.artifactBytes,
      appearances: c.limits.appearances,
      entries: c.limits.entries,
      nodes: c.limits.nodes,
      depth: c.limits.depth,
      pointers: c.limits.pointers,
      buckets: c.limits.buckets,
      readings: c.limits.readings,
      syntaxDepth: c.limits.syntaxDepth,
      syntaxNodes: c.limits.syntaxNodes,
    });
  } catch (e) {
    if (e instanceof EvidenceCodecError) mFail(e.code);
    throw e;
  }
  if (materializationHasMissingReading(gathered.hview)) mFail("missing-reading");
  let value: Uint8Array;
  try {
    value = materializationHexBytes(
      viewCanonicalHex(
        resolveView(
          bindReadingVariables(program.selected.reading, program.bindings),
          gathered.hview,
        ),
      ),
    );
  } catch (e) {
    diagnostic(e);
    mFail("execution-failed");
  }
  mLimit(value.length, c.limits.artifactBytes);
  return map([
    ["root", tstr(root)],
    ["envelope", bstr(envelope)],
    ["transport", tstr(contentAddress(envelope))],
    ["hview", tstr(contentAddress(materializationHexBytes(hviewCanonicalHex(gathered.hview))))],
    ["value", bstr(value)],
    ["view", tstr(contentAddress(value))],
  ]);
}
function basisFields(descriptor: Descriptor, at: number, servingAt: number): CommandFields {
  const p = (value: string | number): Target => ({ kind: "primitive", value });
  const ref = (delta: string): Target => ({ kind: "delta", deltaRef: { delta } });
  return {
    at: [p(at)],
    "serving-at": [p(servingAt)],
    bindings: [{ kind: "bytes", mime: "application/cbor", value: descriptor.bindings }],
    "definition-at": [p(descriptor.definitionAt)],
    hyperschema: [ref(descriptor.hyper)],
    "hyperschema-pin": [p(descriptor.hyperPin)],
    schema: [ref(descriptor.reading)],
    "schema-pin": [p(descriptor.readingPin)],
  };
}
const refused = (code: string): MaterializationLifecycleOutcome => ({
  status: "refused",
  body: map([["code", tstr(code)]]),
});

/** Runs one maintained attempt after stages 1-4; every refusal is a known category. */
export async function runMaterializationLifecycle(
  host: MaterializationLifecycleHost,
  p: MaterializationPreparedInput,
  receivedAt: number,
): Promise<MaterializationLifecycleOutcome> {
  const c = host.catalog,
    verb = p.verb as MaterializationLifecycleVerb,
    f = p.fields;
  const control = await readControl(host);
  // Stage 5 preconditions and registration state.
  if (commandText(f, "expected-control") !== control.revision) mFail("precondition-failed");
  if (verb === "restore") {
    return {
      status: "completed",
      body: map([
        ["kind", tstr("restore")],
        ["control", tstr(control.revision)],
        ["generation", float(control.image.generation)],
        [
          "selections",
          array(
            control.image.entries.map((e) =>
              map([
                ["registration", tstr(e.registration)],
                ["status", tstr(e.status)],
                ["sourceRevision", tstr(e.sourceRevision)],
                ["authority", tstr(e.authority)],
                ["at", float(e.at)],
                ["definitionAt", float(e.definitionAt)],
                ["hyperschemaPin", tstr(e.hyperschemaPin)],
                ["schemaPin", tstr(e.schemaPin)],
                ["availability", tstr(e.status === "active" ? "unchecked" : "retired")],
              ]),
            ),
          ),
        ],
      ]),
    };
  }
  const registration = commandRef(f, "registration");
  const stored = control.stored.get(registration);
  if (verb === "install") {
    if (stored) mFail(stored.entry.status === "retired" ? "retired" : "already-installed");
    if (control.image.entries.length + 1 > c.limits.registrations) mFail("resource-limit");
  } else {
    if (!stored) mFail("registration-missing");
    if (stored.entry.status === "retired") mFail("retired");
    if (verb === "advance-time" && commandNumber(f, "at") < stored.entry.at)
      mFail("time-regression");
  }
  if (control.image.generation + 1 > Number.MAX_SAFE_INTEGER && CONTROL_VERBS.has(verb))
    mFail("resource-limit");
  const descriptor =
    verb === "install"
      ? (readRegistrationDescriptor(p.supplied.get(registration)!) ?? mFail("invalid-arguments"))
      : stored!.descriptor!;
  const generation = control.image.generation + 1;
  // Stage 6, 7 and 8 for the serving verbs; retire needs none of them (MR-16).
  let source: SourceCheck | undefined;
  let program: Program | undefined;
  let requiredSupport: string[] = [];
  let results: CborValue[] = [];
  let basis: CborValue | undefined;
  let at = stored?.entry.at ?? 0;
  if (verb !== "retire") {
    if (verb !== "install" && commandText(f, "expected-source") !== stored!.entry.sourceRevision)
      mFail("precondition-failed");
    source = checkSource(host, p, descriptor, stored, receivedAt);
    requiredSupport = [...descriptorClosure(descriptor), descriptor.delta.id].sort();
    const check = async () => {
      const result = await source!.grant.checkCurrent(
        source!.binding,
        source!.snapshot.revision,
        source!.snapshot.authority,
        receivedAt,
        undefined,
        Object.freeze([...requiredSupport]),
      );
      if (result.status !== "current") mFail(result.status);
    };
    await check();
    const deltas =
      verb === "install"
        ? descriptorClosure(descriptor).map((id) => p.supplied.get(id)!)
        : stored!.definitions;
    program = checkProgram(c, descriptor, deltas, receivedAt);
    if (verb === "install" || verb === "advance-time") at = commandNumber(f, "at");
    results = descriptor.roots.map((root) =>
      materializeRoot(c, program!, source!.snapshot, at, root, host.diagnostic),
    );
    try {
      basis = gatherMaterializationBasis(
        basisFields(descriptor, at, receivedAt),
        source.snapshot,
        program.deltas,
        c.limits,
      );
    } catch (e) {
      if (e instanceof MaterializationInputError) throw e;
      throw e;
    }
    if (verb === "read") {
      const body = map([
        ["kind", tstr("read")],
        ["registration", tstr(registration)],
        ["control", tstr(control.revision)],
        ["generation", float(control.image.generation)],
        ["basis", basis],
        ["results", array(results)],
      ]);
      mLimit(encode(body).length, c.limits.artifactBytes);
      await check();
      return { status: "completed", body };
    }
    // Prospective transition, image and body are bounded before the repeated check and CAS.
    const outcome = await commitTransition(host, control, stored, descriptor, source, program, {
      verb,
      registration,
      generation,
      at,
      receivedAt,
      basis,
      results,
    });
    if (outcome.status === "prepared") {
      await check();
      return await outcome.commit();
    }
    return outcome;
  }
  const outcome = await commitTransition(host, control, stored, descriptor, undefined, undefined, {
    verb,
    registration,
    generation,
    at,
    receivedAt,
  });
  return outcome.status === "prepared" ? await outcome.commit() : outcome;
}

interface Prospective {
  readonly verb: MaterializationLifecycleVerb;
  readonly registration: string;
  readonly generation: number;
  readonly at: number;
  readonly receivedAt: number;
  readonly basis?: CborValue;
  readonly results?: readonly CborValue[];
}
type Prepared =
  | MaterializationLifecycleOutcome
  | {
      readonly status: "prepared";
      readonly commit: () => Promise<MaterializationLifecycleOutcome>;
    };
/** Sign the transition, plan the next selection, bound the image, then CAS (MR-16, MR-18). */
async function commitTransition(
  host: MaterializationLifecycleHost,
  control: ControlState,
  stored: StoredEntry | undefined,
  descriptor: Descriptor,
  source: SourceCheck | undefined,
  program: Program | undefined,
  x: Prospective,
): Promise<Prepared> {
  const c = host.catalog;
  const p = (value: string | number): Target => ({ kind: "primitive", value });
  const ref = (delta: string): Target => ({ kind: "delta", deltaRef: { delta } });
  const entry = stored?.entry;
  const sourceRevision = source ? source.snapshot.revision : entry!.sourceRevision;
  const authority = source ? source.authority.id : entry!.authority;
  const transitionClaims = materializationDescriptionClaims(c.receiver, x.receivedAt, "state/1", {
    registration: [ref(x.registration)],
    generation: [p(x.generation)],
    "prior-control": [p(control.revision)],
    "prior-transition": [p(entry?.transition ?? "")],
    verb: [p(x.verb)],
    "source-revision": [p(sourceRevision)],
    authority: [p(authority)],
    at: [p(x.at)],
    "definition-at": [p(descriptor.definitionAt)],
    "hyperschema-pin": [p(descriptor.hyperPin)],
    "schema-pin": [p(descriptor.readingPin)],
    ...(x.verb === "retire" ? {} : { capture: [ref(source!.capture.id)] }),
  });
  const expected = canonicalBytes(transitionClaims);
  const transition = structuredClone(host.signer.sign(structuredClone(transitionClaims)));
  verifyCommandAppearance(transition);
  if (bytesToHex(canonicalBytes(transition.claims)) !== bytesToHex(expected))
    throw Error("invalid materialization transition signer");
  const appearance = (d: Delta): readonly [string, Uint8Array] => {
    const bytes = encodeMaterializationAppearance(d, c.limits);
    return [materializationAppearanceKey(bytes), bytes];
  };
  let plan: MaterializationControlTransition;
  try {
    if (x.verb === "install") {
      const support = new Map<string, Uint8Array>([
        appearance(descriptor.delta),
        ...program!.deltas.map(appearance),
        appearance(source!.capture),
        appearance(source!.authority),
        appearance(transition),
      ]);
      plan = {
        verb: "install",
        entry: {
          registration: x.registration,
          sourceRevision,
          authority,
          at: x.at,
          definitionAt: descriptor.definitionAt,
          hyperschemaPin: descriptor.hyperPin,
          schemaPin: descriptor.readingPin,
          capture: source!.capture.id,
        },
        transition: transition.id,
        support,
      };
    } else if (x.verb === "retire") {
      plan = {
        verb: "retire",
        registration: x.registration,
        transition: transition.id,
        support: new Map([appearance(transition)]),
      };
    } else {
      const superseded = [
        stored!.transition,
        ...(x.verb === "replace-source" ? [stored!.capture!, stored!.authority!] : []),
      ].map((d) => appearance(d)[0]);
      const support = new Map<string, Uint8Array>([
        appearance(transition),
        ...(x.verb === "replace-source"
          ? [appearance(source!.capture), appearance(source!.authority)]
          : []),
      ]);
      plan =
        x.verb === "replace-source"
          ? {
              verb: "replace-source",
              registration: x.registration,
              sourceRevision,
              authority,
              capture: source!.capture.id,
              transition: transition.id,
              support,
              superseded,
            }
          : {
              verb: "advance-time",
              registration: x.registration,
              at: x.at,
              transition: transition.id,
              support,
              superseded,
            };
    }
  } catch (e) {
    if (e instanceof MaterializationSourceError) mFail(e.code);
    throw e;
  }
  const planned = planMaterializationControl(control.selection, plan, controlLimits(c.limits));
  if (planned.status !== "planned") mFail(planned.code);
  let bytes: Uint8Array;
  try {
    bytes = encodeMaterializationControl(
      materializationControlImage(planned.selection, controlLimits(c.limits)),
      controlLimits(c.limits),
    );
  } catch (e) {
    if (e instanceof MaterializationControlError) mFail(e.code);
    throw e;
  }
  const next = materializationControlRevision(bytes, x.generation);
  const body =
    x.verb === "retire"
      ? map([
          ["kind", tstr("retire")],
          ["registration", tstr(x.registration)],
          ["transition", tstr(transition.id)],
          ["control", tstr(next)],
          ["generation", float(x.generation)],
        ])
      : map([
          ["kind", tstr(x.verb)],
          ["registration", tstr(x.registration)],
          ["transition", tstr(transition.id)],
          ["control", tstr(next)],
          ["generation", float(x.generation)],
          ["basis", x.basis!],
          ["results", array([...x.results!])],
        ]);
  mLimit(encode(body).length, c.limits.artifactBytes);
  return {
    status: "prepared",
    commit: async () => {
      let dispatched = false;
      let write;
      try {
        dispatched = true;
        write = await host.controlStore.compareAndSet(
          c.receiver,
          c.configuration.id,
          control.revision,
          bytes,
          next,
        );
      } catch (e) {
        host.diagnostic(e);
        if (!dispatched) throw e;
        return { status: "indeterminate", body: map([["code", tstr("commit-unconfirmed")]]) };
      }
      if (write.status === "conflict") return refused("write-conflict");
      if (write.status === "rejected") return refused("control-rejected");
      if (write.status === "committed-unconfirmed")
        return { status: "indeterminate", body: map([["code", tstr("commit-unconfirmed")]]) };
      if (write.revision !== next) throw Error("control store named a different revision");
      try {
        host.hooks.postCasResultMaterialization?.(next);
      } catch (e) {
        host.diagnostic(e);
        return {
          status: "indeterminate",
          body: map([
            ["code", tstr("result-unavailable")],
            ["control", tstr(next)],
          ]),
        };
      }
      return { status: "completed", body };
    },
  };
}
/** Explicit host initialization of the empty image (MR-14/15); never lazy. */
export async function initializeMaterializationControl(
  store: MaterializationControlStore,
  receiver: string,
  configuration: string,
  limits: MaterializationLimits,
): Promise<void> {
  const l = controlLimits(limits);
  const empty = encodeMaterializationControl(
    materializationControlImage(emptyMaterializationControl(receiver, configuration), l),
    l,
  );
  const result = await store.initialize(receiver, configuration, empty);
  if (result.status === "existing") {
    const image = decodeMaterializationControl(result.bytes, l);
    if (
      image.receiver !== receiver ||
      image.configuration !== configuration ||
      result.revision !== materializationControlRevision(result.bytes, image.generation)
    )
      throw Error("invalid materialization control store");
  }
}
