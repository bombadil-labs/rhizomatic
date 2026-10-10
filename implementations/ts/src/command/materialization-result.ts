// SPEC-16 MR-20: contextual readback labels attested commitments separately from recomputed bytes.
import { type CborValue } from "../delta/cbor.js";
import { contentAddress, bytesToHex } from "../delta/hash.js";
import type { Delta } from "../delta/types.js";
import {
  commandText,
  commandRef,
  commandEntity,
  commandBytes,
  commandNumber,
  verifyCommandAppearance,
  type CommandFields,
} from "../command-data/codec.js";
import {
  encodeMaterializationLimits,
  readMaterializationDescription,
  MATERIALIZATION_MAX_LIMITS,
  compareMaterializationText,
  type MaterializationLimits,
  type MaterializationVerb,
} from "../command-data/materialization-codec.js";
import {
  decodeMaterializationSnapshotEvidence,
  type MaterializationSourceSnapshot,
} from "../federation/materialization-source.js";
import { decodeView, viewCanonicalHex, type View } from "../resolve-kernel/resolution.js";
import {
  MATERIALIZATION_BASIS_FIELDS,
  materializationBasisProgram,
  validateMaterializationBasis,
} from "./materialization-basis.js";
import {
  validateGatherMaterializationEvidence,
  validateMaterializationEnvelope,
  materializationHexBytes,
} from "./materialization-evidence.js";
import {
  classifyMaterializationControl,
  descriptorClosure,
  type ControlState,
} from "./materialization-lifecycle.js";
import {
  MaterializationInputError,
  mFields,
  mCanonical,
  mText,
  mId,
  mBytes,
  mNumber,
  mList,
  mOrdered,
  mEqual,
  mFail,
} from "./materialization-values.js";

export interface MaterializationResultContext {
  readonly receiver: string;
  readonly configuration: string;
  readonly request: string;
  readonly requestDelta?: Delta;
  readonly evidence?: Delta;
  readonly binding?: string;
  readonly revision?: string;
  readonly authority?: string;
  readonly capture?: Delta;
  readonly snapshot?: Delta;
  readonly receivedAt?: number;
  /** The control image a maintained body names, as the store holds it after the CAS (MR-20). */
  readonly control?: Uint8Array;
}
export interface MaterializationResult {
  readonly classification: "verified-structure" | "verified-context";
  readonly sourceCommitments: "attested" | "commitments-verified";
  readonly receiverTestimony: true;
  readonly executionVerified: false;
  readonly status: "completed" | "refused" | "indeterminate";
  readonly body: CborValue;
  /** The decoded View of a resolve body. */
  readonly value?: View;
  /** The decoded View of every root result of a maintained body, keyed by root. */
  readonly values?: ReadonlyMap<string, View>;
}
const REFUSALS = [
  "invalid-appearance",
  "entry-missing",
  "invalid-request",
  "request-outside-validity",
  "configuration-mismatch",
  "unauthorized",
  "unsupported-operation",
  "invalid-arguments",
  "missing-support",
  "unexpected-support",
  "resource-limit",
  "resource-exhausted",
  "invalid-source",
  "source-changed",
  "source-unavailable",
  "invalid-definition",
  "pin-mismatch",
  "ambiguous-definition",
  "definition-closure",
  "definition-cycle",
  "invalid-program",
  "invalid-evidence",
  "missing-reading",
  "execution-failed",
  "already-installed",
  "precondition-failed",
  "time-regression",
  "registration-missing",
  "retired",
  "invalid-control",
  "control-unavailable",
  "write-conflict",
  "control-rejected",
];
const TRANSITION_BODY = [
  "kind",
  "registration",
  "transition",
  "control",
  "generation",
  "basis",
  "results",
];
/** MR-19 maintained body shapes by kind; each lists its exact field set. */
const MAINTAINED_BODIES: Record<string, readonly string[]> = {
  install: TRANSITION_BODY,
  "replace-source": TRANSITION_BODY,
  "advance-time": TRANSITION_BODY,
  read: ["kind", "registration", "control", "generation", "basis", "results"],
  retire: ["kind", "registration", "transition", "control", "generation"],
  restore: ["kind", "control", "generation", "selections"],
};
const SELECTION_FIELDS = [
  "registration",
  "status",
  "sourceRevision",
  "authority",
  "at",
  "definitionAt",
  "hyperschemaPin",
  "schemaPin",
  "availability",
];
export function readMaterializationResult(
  outcome: Delta,
  context: MaterializationResultContext,
  limits: MaterializationLimits = MATERIALIZATION_MAX_LIMITS,
): MaterializationResult {
  encodeMaterializationLimits(limits);
  verifyCommandAppearance(outcome);
  const outer = readMaterializationDescription(outcome);
  if (
    commandText(outer, "kind") !== "outcome/1" ||
    commandEntity(outer, "receiver") !== context.receiver ||
    commandRef(outer, "configuration") !== context.configuration ||
    commandRef(outer, "request") !== context.request ||
    (context.receivedAt !== undefined && context.receivedAt !== outcome.claims.timestamp)
  )
    mFail();
  const request = context.requestDelta;
  if (request) {
    verifyCommandAppearance(request);
    const common = readMaterializationDescription(request);
    if (
      request.id !== context.request ||
      commandText(common, "kind") !== "request/1" ||
      commandEntity(common, "receiver") !== context.receiver ||
      commandRef(common, "configuration") !== context.configuration
    )
      mFail();
  }
  const body = mCanonical(commandBytes(outer, "result"), limits.artifactBytes),
    status = commandText(outer, "status");
  if (status === "refused") {
    const fs = mFields(body, ["code"]);
    if (!REFUSALS.includes(mText(fs.get("code")))) mFail();
    return {
      classification: request ? "verified-context" : "verified-structure",
      sourceCommitments: "attested",
      receiverTestimony: true,
      executionVerified: false,
      status,
      body,
    };
  }
  if (status === "indeterminate") {
    const fs = mFields(body, ["code"], ["control"]);
    const code = mText(fs.get("code"));
    if (code === "result-unavailable") mId(fs.get("control"));
    else if (code !== "commit-unconfirmed" || fs.has("control")) mFail();
    return {
      classification: request ? "verified-context" : "verified-structure",
      sourceCommitments: "attested",
      receiverTestimony: true,
      executionVerified: false,
      status,
      body,
    };
  }
  if (status !== "completed") mFail();
  const kind = body.t === "map" ? mText(new Map(body.v).get("kind")) : mFail();
  if (kind in MAINTAINED_BODIES) return readMaintainedResult(outcome, context, limits, body, kind);
  const fs = mFields(
    body,
    kind === "gather"
      ? ["kind", "root", "basis", "envelope", "transport", "hview"]
      : kind === "resolve"
        ? ["kind", "root", "basis", "transport", "hview", "value", "view"]
        : mFail(),
  );
  if (!mText(fs.get("root"))) mFail();
  const basis = fs.get("basis")!,
    program = materializationBasisProgram(basis, limits);
  validateMaterializationBasis(basis, limits);
  const b = basisFields(context, basis);
  const snapshot = verifySourceCommitments(context, basis, limits);
  let value: View | undefined;
  if (kind === "gather") validateGatherMaterializationEvidence(body, limits);
  else {
    const payload = mBytes(fs.get("value"));
    value = decodeView(payload);
    if (
      contentAddress(payload) !== mId(fs.get("view")) ||
      bytesToHex(materializationHexBytes(viewCanonicalHex(value))) !== bytesToHex(payload)
    )
      mFail();
    mId(fs.get("transport"));
    mId(fs.get("hview"));
  }
  let completeContext = false;
  if (request) {
    const f = readMaterializationDescription(request, kind as "gather" | "resolve");
    if (kind === "gather") {
      if (
        mText(fs.get("root")) !== commandEntity(f, "root") ||
        mNumber(b.get("servingAt")) !== outcome.claims.timestamp
      )
        mFail();
      for (const [wire, key] of [
        ["at", "at"],
        ["serving-at", "servingAt"],
        ["definition-at", "definitionAt"],
      ] as const)
        if (commandNumber(f, wire) !== mNumber(b.get(key))) mFail();
      for (const [wire, key] of [
        ["hyperschema", "hyperschema"],
        ["schema", "schema"],
      ] as const)
        if (commandRef(f, wire) !== mId(b.get(key))) mFail();
      for (const [wire, key] of [
        ["hyperschema-pin", "hyperschemaPin"],
        ["schema-pin", "schemaPin"],
        ["interpretation", "interpretation"],
      ] as const)
        if (commandText(f, wire) !== mText(b.get(key))) mFail();
      if (
        bytesToHex(commandBytes(f, "bindings")) !== bytesToHex(mBytes(b.get("bindings"))) ||
        Boolean(f["historical-cutoff"]) !== b.has("historicalCutoff") ||
        (f["historical-cutoff"] &&
          commandNumber(f, "historical-cutoff") !== mNumber(b.get("historicalCutoff")))
      )
        mFail();
      const named = [
        commandRef(f, "hyperschema"),
        commandRef(f, "schema"),
        ...(f.definition ?? []).map((t) => commandRef({ x: [t] }, "x")),
      ].sort();
      if (named.join() !== program.deltas.map((d) => d.id).join()) mFail();
      if (context.capture && context.capture.id !== commandRef(f, "capture")) mFail();
      if (context.snapshot && context.snapshot.id !== commandRef(f, "snapshot")) mFail();
      completeContext = true;
    } else if (context.evidence) {
      verifyCommandAppearance(context.evidence);
      if (context.evidence.id !== commandRef(f, "evidence")) mFail();
      const ef = readMaterializationDescription(context.evidence);
      if (commandText(ef, "kind") !== "evidence/1") mFail();
      const gathered = mCanonical(commandBytes(ef, "result"), limits.artifactBytes);
      validateGatherMaterializationEvidence(gathered, limits);
      const gf = mFields(gathered, ["kind", "root", "basis", "envelope", "transport", "hview"]);
      for (const k of ["root", "basis", "transport", "hview"])
        if (!mEqual(gf.get(k)!, fs.get(k)!)) mFail();
      completeContext = true;
    }
  }
  return {
    classification: completeContext ? "verified-context" : "verified-structure",
    sourceCommitments: snapshot ? "commitments-verified" : "attested",
    receiverTestimony: true,
    executionVerified: false,
    status: "completed",
    body,
    ...(value ? { value } : {}),
  };
}

/** The Basis field map, with every contextual expected binding/revision/authority compared. */
function basisFields(
  context: MaterializationResultContext,
  basis: CborValue,
): Map<string, CborValue> {
  const b = mFields(basis, MATERIALIZATION_BASIS_FIELDS, ["historicalCutoff"]);
  for (const k of ["binding", "revision", "authority"] as const)
    if (context[k] !== undefined && mId(b.get(k)) !== context[k]) mFail();
  return b;
}
/** Recompute a supplied capture/snapshot pair's commitments and compare them to the Basis. */
function verifySourceCommitments(
  context: MaterializationResultContext,
  basis: CborValue,
  limits: MaterializationLimits,
): MaterializationSourceSnapshot | undefined {
  if ((context.capture === undefined) !== (context.snapshot === undefined)) mFail();
  if (!context.capture || !context.snapshot) return undefined;
  verifyCommandAppearance(context.capture);
  verifyCommandAppearance(context.snapshot);
  const cf = readMaterializationDescription(context.capture),
    sf = readMaterializationDescription(context.snapshot);
  if (commandText(cf, "kind") !== "capture/1" || commandText(sf, "kind") !== "snapshot/1") mFail();
  const payload = commandBytes(sf, "data");
  const decoded = decodeMaterializationSnapshotEvidence(payload, limits);
  const snapshot = decoded.snapshot;
  decoded.validateCaptureBasis(commandBytes(cf, "basis"));
  if (
    commandRef(cf, "source-binding") !== snapshot.binding ||
    commandRef(cf, "authority") !== snapshot.authority ||
    context.capture.claims.timestamp !== snapshot.servingAt ||
    context.capture.claims.validFrom !== snapshot.servingAt ||
    (context.capture.claims.validUntil !== undefined &&
      snapshot.servingAt >= context.capture.claims.validUntil)
  )
    mFail();
  validateMaterializationBasis(basis, limits, snapshot);
  return snapshot;
}
/** One MR-19 RootResult: strict envelope, recomputed digests, decoded View. */
function readRootResult(v: CborValue, limits: MaterializationLimits): [string, View] {
  const fs = mFields(v, ["root", "envelope", "transport", "hview", "value", "view"]);
  const root = mText(fs.get("root"));
  if (!root) mFail();
  validateMaterializationEnvelope(
    mBytes(fs.get("envelope")),
    mId(fs.get("transport")),
    mId(fs.get("hview")),
    limits,
  );
  const payload = mBytes(fs.get("value"));
  const value = decodeView(payload);
  if (
    contentAddress(payload) !== mId(fs.get("view")) ||
    bytesToHex(materializationHexBytes(viewCanonicalHex(value))) !== bytesToHex(payload)
  )
    mFail();
  return [root, value];
}
interface Selection {
  readonly registration: string;
  readonly status: string;
  readonly sourceRevision: string;
  readonly authority: string;
  readonly at: number;
  readonly definitionAt: number;
  readonly hyperschemaPin: string;
  readonly schemaPin: string;
}
/** One RestoreBody selection; availability is a function of status, never a claim of its own. */
function readSelection(v: CborValue): Selection {
  const fs = mFields(v, SELECTION_FIELDS);
  const status = mText(fs.get("status"));
  if (status !== "active" && status !== "retired") mFail();
  if (mText(fs.get("availability")) !== (status === "active" ? "unchecked" : "retired")) mFail();
  return {
    registration: mId(fs.get("registration")),
    status,
    sourceRevision: mId(fs.get("sourceRevision")),
    authority: mId(fs.get("authority")),
    at: mNumber(fs.get("at")),
    definitionAt: mNumber(fs.get("definitionAt")),
    hyperschemaPin: mId(fs.get("hyperschemaPin")),
    schemaPin: mId(fs.get("schemaPin")),
  };
}
/**
 * MR-20 for the six maintained bodies. Structure is always verified; the answer is contextual
 * only when the request and the named control image both link to it, and a serving body also
 * covers its descriptor's complete root partition.
 */
function readMaintainedResult(
  outcome: Delta,
  context: MaterializationResultContext,
  limits: MaterializationLimits,
  body: CborValue,
  kind: string,
): MaterializationResult {
  const fs = mFields(body, MAINTAINED_BODIES[kind]!);
  const serving = fs.has("basis");
  const generation = mNumber(fs.get("generation"));
  if (!Number.isInteger(generation) || generation < (kind === "restore" ? 0 : 1)) mFail();
  const control = mText(fs.get("control"));
  if (kind === "restore" ? (control === "") !== (generation === 0) : control === "") mFail();
  if (control !== "") mId(fs.get("control"));
  const registration = kind === "restore" ? undefined : mId(fs.get("registration"));
  const transition = fs.has("transition") ? mId(fs.get("transition")) : undefined;
  const selections = kind === "restore" ? mList(fs.get("selections")).map(readSelection) : [];
  mOrdered(selections.map((x) => x.registration));
  let program: ReturnType<typeof materializationBasisProgram> | undefined;
  let b: Map<string, CborValue> | undefined;
  let snapshot: MaterializationSourceSnapshot | undefined;
  const values = new Map<string, View>();
  if (serving) {
    const basis = fs.get("basis")!;
    program = materializationBasisProgram(basis, limits);
    validateMaterializationBasis(basis, limits);
    b = basisFields(context, basis);
    snapshot = verifySourceCommitments(context, basis, limits);
    const rows = mList(fs.get("results"));
    if (rows.length > limits.roots) mFail("resource-limit");
    for (const r of rows) {
      const [root, view] = readRootResult(r, limits);
      if (values.has(root)) mFail();
      values.set(root, view);
    }
    mOrdered([...values.keys()]);
  } else if (
    context.capture ||
    context.snapshot ||
    context.binding !== undefined ||
    context.revision !== undefined ||
    context.authority !== undefined
  )
    mFail();
  let requestLinked = false;
  const request = context.requestDelta;
  let f: CommandFields | undefined;
  if (request) {
    f = readMaterializationDescription(request, kind as MaterializationVerb);
    if (registration !== undefined && commandRef(f, "registration") !== registration) mFail();
    if ((kind === "read" || kind === "restore") && commandText(f, "expected-control") !== control)
      mFail();
    if (serving) {
      if (mNumber(b!.get("servingAt")) !== outcome.claims.timestamp) mFail();
      if (commandNumber(f, "serving-at") !== outcome.claims.timestamp) mFail();
      if (
        (kind === "install" || kind === "advance-time") &&
        commandNumber(f, "at") !== mNumber(b!.get("at"))
      )
        mFail();
      if (
        (kind === "read" || kind === "advance-time") &&
        commandText(f, "expected-source") !== mId(b!.get("revision"))
      )
        mFail();
      if (context.capture && f.capture && context.capture.id !== commandRef(f, "capture")) mFail();
      if (context.snapshot && context.snapshot.id !== commandRef(f, "snapshot")) mFail();
    }
    requestLinked = true;
  }
  let controlLinked = false;
  if (context.control) {
    let state: ControlState;
    try {
      state = classifyMaterializationControl(
        context.control,
        context.receiver,
        context.configuration,
        limits,
      );
    } catch (e) {
      if (e instanceof MaterializationInputError && e.code === "resource-limit") throw e;
      mFail();
    }
    if (state.revision !== control || state.image.generation !== generation) mFail();
    if (kind === "restore") {
      const expected: Selection[] = state.image.entries.map((e) => ({
        registration: e.registration,
        status: e.status,
        sourceRevision: e.sourceRevision,
        authority: e.authority,
        at: e.at,
        definitionAt: e.definitionAt,
        hyperschemaPin: e.hyperschemaPin,
        schemaPin: e.schemaPin,
      }));
      if (JSON.stringify(expected) !== JSON.stringify(selections)) mFail();
    } else {
      const stored = state.stored.get(registration!) ?? mFail();
      const e = stored.entry;
      if (transition !== undefined && stored.transition.id !== transition) mFail();
      if ((e.status === "retired") !== (kind === "retire")) mFail();
      if (transition !== undefined && f) {
        // The selected transition must answer this request: same verb, and its prior control is
        // the control the request expected.
        const tf = readMaterializationDescription(stored.transition);
        if (
          commandText(tf, "verb") !== kind ||
          commandText(tf, "prior-control") !== commandText(f, "expected-control")
        )
          mFail();
      }
      if (serving) {
        const d = stored.descriptor!;
        if (
          e.sourceRevision !== mId(b!.get("revision")) ||
          e.authority !== mId(b!.get("authority")) ||
          e.at !== mNumber(b!.get("at")) ||
          e.definitionAt !== mNumber(b!.get("definitionAt")) ||
          e.hyperschemaPin !== mText(b!.get("hyperschemaPin")) ||
          e.schemaPin !== mText(b!.get("schemaPin")) ||
          d.binding !== mId(b!.get("binding")) ||
          d.hyper !== mId(b!.get("hyperschema")) ||
          d.reading !== mId(b!.get("schema")) ||
          bytesToHex(d.bindings) !== bytesToHex(mBytes(b!.get("bindings"))) ||
          descriptorClosure(d).join() !== program!.deltas.map((x) => x.id).join() ||
          [...d.roots].sort(compareMaterializationText).join("\u0000") !==
            [...values.keys()].join("\u0000")
        )
          mFail();
      }
    }
    controlLinked = true;
  }
  return {
    classification: requestLinked && controlLinked ? "verified-context" : "verified-structure",
    sourceCommitments: snapshot ? "commitments-verified" : "attested",
    receiverTestimony: true,
    executionVerified: false,
    status: "completed",
    body,
    ...(serving ? { values } : {}),
  };
}
