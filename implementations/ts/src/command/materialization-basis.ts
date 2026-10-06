// SPEC-16 MR-11/19/20: full signed program closure and compact attributed source basis.
import { array, bstr, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { DeltaSet } from "../delta/set.js";
import type { Delta } from "../delta/types.js";
import {
  commandBytes,
  commandNumber,
  commandRef,
  commandText,
  decodeBindings,
  type CommandFields,
} from "../command-data/codec.js";
import type { MaterializationLimits } from "../command-data/materialization-codec.js";
import {
  decodeMaterializationAppearance,
  encodeMaterializationAppearance,
  materializationComponentCommitments,
  type MaterializationSourceSnapshot,
  MaterializationSourceError,
} from "../federation/materialization-source.js";
import { readMaterializationDefinitions } from "../schema-load/command-definitions.js";
import { validateMaterializationProgram, CommandProgramError } from "../schema/command-program.js";
import {
  mBytes,
  mFields,
  mId,
  mList,
  mNumber,
  mOrdered,
  mPeer,
  mText,
  mFail,
  mLimit,
  mEqual,
  MaterializationInputError,
} from "./materialization-values.js";

export const MATERIALIZATION_BASIS_FIELDS = [
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
] as const;
export function materializationBasisProgram(value: CborValue, limits: MaterializationLimits) {
  const fs = mFields(value, MATERIALIZATION_BASIS_FIELDS, ["historicalCutoff"]);
  const definitions = mList(fs.get("definitions"));
  mLimit(definitions.length, limits.definitions);
  for (const x of definitions) mLimit(mBytes(x).length, limits.artifactBytes);
  const deltas: Delta[] = [];
  for (const x of definitions) {
    const bytes = mBytes(x);
    mLimit(bytes.length, limits.artifactBytes);
    try {
      deltas.push(decodeMaterializationAppearance(bytes, limits));
    } catch (e) {
      if (e instanceof MaterializationSourceError && e.code === "resource-limit") mFail(e.code);
      mFail("invalid-definition");
    }
  }
  mOrdered(deltas.map((d) => d.id));
  const hyper = mId(fs.get("hyperschema")),
    reading = mId(fs.get("schema"));
  const at = mNumber(fs.get("definitionAt"));
  let parsed;
  try {
    parsed = readMaterializationDefinitions(deltas, at, limits);
  } catch (e) {
    mFail(
      e instanceof Error && e.message === "resource-limit"
        ? "resource-limit"
        : "invalid-definition",
    );
  }
  // Missing top acts in embedded evidence have the required closure category.
  if (!deltas.some((d) => d.id === hyper) || !deltas.some((d) => d.id === reading))
    mFail("definition-closure");
  if (
    parsed.find((d) => d.id === hyper)?.kind !== "hyper" ||
    parsed.find((d) => d.id === reading)?.kind !== "reading"
  )
    mFail("invalid-definition");
  let bindings;
  try {
    bindings = new Map(Object.entries(decodeBindings(mBytes(fs.get("bindings")))));
  } catch (e) {
    if (e instanceof MaterializationInputError) throw e;
    return mFail();
  }
  let selected;
  try {
    selected = validateMaterializationProgram(
      parsed,
      hyper,
      reading,
      mId(fs.get("hyperschemaPin")),
      mId(fs.get("schemaPin")),
      bindings,
    );
  } catch (e) {
    if (e instanceof CommandProgramError) mFail(e.code);
    throw e;
  }
  return { fields: fs, deltas, bindings, selected };
}
export function validateMaterializationBasis(
  value: CborValue,
  limits: MaterializationLimits,
  snapshot?: MaterializationSourceSnapshot,
): void {
  const fs = mFields(value, MATERIALIZATION_BASIS_FIELDS, ["historicalCutoff"]);
  for (const k of [
    "binding",
    "revision",
    "authority",
    "selection",
    "membership",
    "appearanceDigest",
    "hyperschema",
    "hyperschemaPin",
    "schema",
    "schemaPin",
    "definitionDigest",
  ])
    mId(fs.get(k));
  for (const k of ["at", "servingAt", "definitionAt"]) mNumber(fs.get(k));
  if (fs.has("historicalCutoff") && mNumber(fs.get("historicalCutoff")) !== mNumber(fs.get("at")))
    mFail();
  if (mText(fs.get("interpretation")) !== "core/1") mFail();
  const components = mList(fs.get("components"));
  mLimit(components.length, limits.components);
  if (!components.length) mFail();
  const peers: string[] = [];
  for (const c of components) {
    const f = mFields(c, ["peer", "revision", "capturedAt"]);
    peers.push(mPeer(f.get("peer")));
    mId(f.get("revision"));
    mNumber(f.get("capturedAt"));
  }
  mOrdered(peers);
  const parsed = materializationBasisProgram(value, limits);
  if (DeltaSet.from(parsed.deltas).digest() !== mId(fs.get("definitionDigest"))) mFail();
  if (snapshot) {
    for (const k of [
      "binding",
      "revision",
      "authority",
      "selection",
      "membership",
      "appearanceDigest",
    ] as const)
      if (mId(fs.get(k)) !== snapshot[k]) mFail();
    if (!mEqual(fs.get("components")!, materializationComponentCommitments(snapshot))) mFail();
    if (
      fs.has("historicalCutoff") !== (snapshot.historicalCutoff !== undefined) ||
      (fs.has("historicalCutoff") &&
        mNumber(fs.get("historicalCutoff")) !== snapshot.historicalCutoff)
    )
      mFail();
  }
}
export function gatherMaterializationBasis(
  f: CommandFields,
  snapshot: MaterializationSourceSnapshot,
  definitions: readonly Delta[],
  limits: MaterializationLimits,
): CborValue {
  const signed = [...definitions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return map([
    ...(
      ["binding", "revision", "authority", "selection", "membership", "appearanceDigest"] as const
    ).map((k) => [k, tstr(snapshot[k])] as const),
    ["components", materializationComponentCommitments(snapshot)],
    ["at", float(commandNumber(f, "at"))],
    ["servingAt", float(commandNumber(f, "serving-at"))],
    ...(f["historical-cutoff"]
      ? [["historicalCutoff", float(commandNumber(f, "historical-cutoff"))] as const]
      : []),
    ["bindings", bstr(commandBytes(f, "bindings"))],
    ["definitionAt", float(commandNumber(f, "definition-at"))],
    ["interpretation", tstr("core/1")],
    ["hyperschema", tstr(commandRef(f, "hyperschema"))],
    ["hyperschemaPin", tstr(commandText(f, "hyperschema-pin"))],
    ["schema", tstr(commandRef(f, "schema"))],
    ["schemaPin", tstr(commandText(f, "schema-pin"))],
    ["definitions", array(signed.map((d) => bstr(encodeMaterializationAppearance(d, limits))))],
    ["definitionDigest", tstr(DeltaSet.from(signed).digest())],
  ]);
}
