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
} from "../command-data/codec.js";
import {
  encodeMaterializationLimits,
  readMaterializationDescription,
  MATERIALIZATION_MAX_LIMITS,
  type MaterializationLimits,
} from "../command-data/materialization-codec.js";
import {
  decodeMaterializationSnapshot,
  validateMaterializationCaptureBasis,
  type MaterializationSourceSnapshot,
} from "../federation/materialization-source.js";
import { decodeView, viewCanonicalHex, type View } from "../resolve-kernel/resolution.js";
import {
  materializationBasisProgram,
  validateMaterializationBasis,
} from "./materialization-basis.js";
import {
  validateGatherMaterializationEvidence,
  materializationHexBytes,
} from "./materialization-evidence.js";
import {
  mFields,
  mCanonical,
  mText,
  mId,
  mBytes,
  mNumber,
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
}
export interface MaterializationResult {
  readonly classification: "verified-structure" | "verified-context";
  readonly sourceCommitments: "attested" | "commitments-verified";
  readonly receiverTestimony: true;
  readonly executionVerified: false;
  readonly status: "completed" | "refused";
  readonly body: CborValue;
  readonly value?: View;
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
  if (status !== "completed") mFail();
  const kind = body.t === "map" ? mText(new Map(body.v).get("kind")) : mFail();
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
  const b = mFields(
    basis,
    [
      "binding",
      "revision",
      "authority",
      "selection",
      "membership",
      "appearanceDigest",
      "components",
      "at",
      "servingAt",
      "bindings",
      "definitionAt",
      "interpretation",
      "hyperschema",
      "hyperschemaPin",
      "schema",
      "schemaPin",
      "definitions",
      "definitionDigest",
    ],
    ["historicalCutoff"],
  );
  for (const k of ["binding", "revision", "authority"] as const)
    if (context[k] !== undefined && mId(b.get(k)) !== context[k]) mFail();
  let snapshot: MaterializationSourceSnapshot | undefined;
  if ((context.capture === undefined) !== (context.snapshot === undefined)) mFail();
  if (context.capture && context.snapshot) {
    verifyCommandAppearance(context.capture);
    verifyCommandAppearance(context.snapshot);
    const cf = readMaterializationDescription(context.capture),
      sf = readMaterializationDescription(context.snapshot);
    if (commandText(cf, "kind") !== "capture/1" || commandText(sf, "kind") !== "snapshot/1")
      mFail();
    const payload = commandBytes(sf, "data");
    snapshot = decodeMaterializationSnapshot(payload, limits);
    validateMaterializationCaptureBasis(commandBytes(cf, "basis"), payload, limits);
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
  }
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
