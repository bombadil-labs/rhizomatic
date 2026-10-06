// SPEC-16 MR-04/08: closed delta-only grammar. Parsing never installs a capability.
import { assertValidClaims } from "../delta/delta.js";
import { float, map, encode } from "../delta/cbor.js";
import { VOCAB_PREFIX } from "../delta/vocab.js";
import type { Claims, Delta, Target } from "../delta/types.js";
import {
  canonicalCommandCbor,
  commandBytes,
  commandEntity,
  commandNumber,
  commandRef,
  commandText,
  decodeBindings,
  isCommandId,
  isCommandKey,
  type CommandFields,
} from "./codec.js";

export const MATERIALIZATION_PREFIX = `${VOCAB_PREFIX}.materialization.`;
export const MATERIALIZATION_MAX_LIMITS = Object.freeze({
  artifactBytes: 16777216,
  deliveryAppearances: 8192,
  deliveryBytes: 33554432,
  appearances: 4096,
  entries: 16384,
  nodes: 4096,
  depth: 32,
  pointers: 256,
  buckets: 256,
  readings: 256,
  definitions: 256,
  syntaxDepth: 64,
  syntaxNodes: 16384,
  roots: 64,
  registrations: 64,
  components: 64,
  inventoryIds: 16384,
});
export type MaterializationLimits =
  Readonly<typeof MATERIALIZATION_MAX_LIMITS> extends infer T
    ? { readonly [K in keyof T]: number }
    : never;
export type MaterializationVerb = "gather" | "resolve";
export type MaterializationDescriptionKind =
  | "endpoint/1"
  | "operation/1"
  | "request/1"
  | "source-binding/1"
  | "authority/1"
  | "capture/1"
  | "snapshot/1"
  | "evidence/1"
  | "outcome/1";
const COMMON = ["kind", "receiver", "configuration", "operation"];
const GATHER = [
  "capture",
  "snapshot",
  "root",
  "at",
  "serving-at",
  "interpretation",
  "hyperschema",
  "hyperschema-pin",
  "schema",
  "schema-pin",
  "bindings",
  "definition-at",
  "definition",
  "historical-cutoff",
];
const ORDER: Record<MaterializationDescriptionKind, readonly string[]> = {
  "endpoint/1": [
    "kind",
    "receiver",
    "caller",
    "administrator",
    "installed",
    "source-binding",
    "limits",
  ],
  "operation/1": [
    "kind",
    "name",
    "interpreter",
    "input-contract",
    "output-contract",
    "effect",
    "replay",
    "dependencies",
  ],
  "request/1": [...COMMON, ...GATHER, "evidence"],
  "source-binding/1": ["kind", "receiver", "spec"],
  "authority/1": ["kind", "source-binding", "spec"],
  "capture/1": ["kind", "source-binding", "authority", "basis"],
  "snapshot/1": ["kind", "data"],
  "evidence/1": ["kind", "result"],
  "outcome/1": ["kind", "receiver", "configuration", "request", "status", "result"],
};
const fail = (): never => {
  throw new Error("invalid materialization description");
};
function shape(
  f: CommandFields,
  allowed: readonly string[],
  optional: readonly string[] = [],
  sets: readonly string[] = [],
): void {
  if (Object.keys(f).some((k) => !allowed.includes(k))) fail();
  for (const k of allowed) {
    const ts = f[k] ?? [];
    if (sets.includes(k)) {
      const values = ts.map((t) =>
        t.kind === "delta"
          ? t.deltaRef.delta
          : t.kind === "primitive" && typeof t.value === "string"
            ? t.value
            : fail(),
      );
      if (new Set(values).size !== values.length) fail();
    } else if (ts.length !== (optional.includes(k) ? Math.min(ts.length, 1) : 1)) fail();
  }
}
export function readMaterializationLimits(bytes: Uint8Array): MaterializationLimits {
  const v = canonicalCommandCbor(bytes);
  if (v.t !== "map") return fail();
  if (v.v.length !== Object.keys(MATERIALIZATION_MAX_LIMITS).length) fail();
  const result: Record<string, number> = {};
  for (const [k, x] of v.v) {
    if (
      !Object.hasOwn(MATERIALIZATION_MAX_LIMITS, k) ||
      x.t !== "float" ||
      !Number.isSafeInteger(x.v) ||
      x.v < 1 ||
      x.v > MATERIALIZATION_MAX_LIMITS[k as keyof MaterializationLimits]
    )
      fail();
    Object.defineProperty(result, k, { value: x.v, enumerable: true });
  }
  return result as unknown as MaterializationLimits;
}
export function encodeMaterializationLimits(limits: MaterializationLimits): Uint8Array {
  const bytes = encode(map(Object.entries(limits).map(([k, v]) => [k, float(v)])));
  readMaterializationLimits(bytes);
  return bytes;
}
export function materializationFields(delta: Delta): CommandFields {
  const fields: Record<string, Target[]> = Object.create(null) as Record<string, Target[]>;
  for (const p of delta.claims.pointers) {
    if (!p.role.startsWith(MATERIALIZATION_PREFIX)) fail();
    const k = p.role.slice(MATERIALIZATION_PREFIX.length);
    (fields[k] ??= []).push(p.target);
  }
  return fields;
}
/** Without verb, request reading validates only common fields (MR-21 stage 2). */
export function readMaterializationDescription(
  delta: Delta,
  verb?: MaterializationVerb,
): CommandFields {
  const f = materializationFields(delta);
  if (f.kind?.length !== 1) fail();
  const kind = commandText(f, "kind") as MaterializationDescriptionKind;
  if (!Object.hasOwn(ORDER, kind)) fail();
  if (kind === "request/1") {
    for (const k of COMMON) if (f[k]?.length !== 1) fail();
    if (!isCommandKey(commandEntity(f, "receiver"))) fail();
    commandRef(f, "configuration");
    commandRef(f, "operation");
    if (verb === undefined) return f;
    shape(
      f,
      verb === "gather" ? [...COMMON, ...GATHER] : [...COMMON, "evidence"],
      verb === "gather" ? ["historical-cutoff"] : [],
      verb === "gather" ? ["definition"] : [],
    );
    if (verb === "resolve") {
      commandRef(f, "evidence");
      return f;
    }
    for (const k of ["capture", "snapshot", "hyperschema", "schema"]) commandRef(f, k);
    for (const k of ["hyperschema-pin", "schema-pin"]) if (!isCommandId(commandText(f, k))) fail();
    if (!commandEntity(f, "root") || commandText(f, "interpretation") !== "core/1") fail();
    for (const k of [
      "at",
      "serving-at",
      "definition-at",
      ...(f["historical-cutoff"] ? ["historical-cutoff"] : []),
    ])
      commandNumber(f, k);
    if (f["historical-cutoff"] && commandNumber(f, "at") !== commandNumber(f, "historical-cutoff"))
      fail();
    const ids = [commandRef(f, "hyperschema"), commandRef(f, "schema")];
    for (const t of f.definition ?? []) {
      const id = commandRef({ x: [t] }, "x");
      if (ids.includes(id)) fail();
      ids.push(id);
    }
    decodeBindings(commandBytes(f, "bindings"));
    return f;
  }
  shape(
    f,
    ORDER[kind],
    [],
    kind === "endpoint/1" ? ["caller", "administrator", "installed", "source-binding"] : [],
  );
  if (
    ["endpoint/1", "source-binding/1", "outcome/1"].includes(kind) &&
    !isCommandKey(commandEntity(f, "receiver"))
  )
    fail();
  if (kind === "endpoint/1") {
    if (!f.caller?.length || !f.administrator?.length || f.installed?.length !== 2) fail();
    const keys = (k: string) =>
      (f[k] ?? []).map((t) => {
        const key = commandText({ x: [t] }, "x");
        if (!isCommandKey(key)) fail();
        return key;
      });
    const callers = keys("caller");
    if (keys("administrator").some((k) => !callers.includes(k))) fail();
    for (const k of ["installed", "source-binding"])
      for (const t of f[k] ?? []) commandRef({ x: [t] }, "x");
    readMaterializationLimits(commandBytes(f, "limits"));
  }
  if (kind === "operation/1") {
    const name = commandEntity(f, "name");
    const verb =
      name === MATERIALIZATION_PREFIX + "gather"
        ? "gather"
        : name === MATERIALIZATION_PREFIX + "resolve"
          ? "resolve"
          : fail();
    for (const [k, v] of Object.entries({
      interpreter: MATERIALIZATION_PREFIX + verb + "/1",
      "input-contract": MATERIALIZATION_PREFIX + verb + "/1",
      "output-contract": MATERIALIZATION_PREFIX + "outcome/1",
      effect: "none",
      replay: "re-evaluate/1",
      dependencies: "explicit-support/1",
    }))
      if (commandText(f, k) !== v) fail();
  }
  if (["authority/1", "capture/1"].includes(kind)) commandRef(f, "source-binding");
  if (kind === "capture/1") commandRef(f, "authority");
  for (const k of ["spec", "basis", "data", "result"]) if (f[k]) commandBytes(f, k);
  if (kind === "outcome/1") {
    commandRef(f, "configuration");
    commandRef(f, "request");
    if (
      delta.claims.author !== commandEntity(f, "receiver") ||
      delta.claims.timestamp !== delta.claims.validFrom ||
      delta.claims.validUntil !== undefined ||
      !["completed", "refused", "indeterminate"].includes(commandText(f, "status"))
    )
      fail();
  }
  return f;
}
export function materializationDescriptionClaims(
  author: string,
  at: number,
  kind: MaterializationDescriptionKind,
  fields: CommandFields,
): Claims {
  if (!isCommandKey(author)) fail();
  const f: CommandFields = { ...fields, kind: [{ kind: "primitive", value: kind }] };
  if (Object.keys(f).some((k) => !ORDER[kind].includes(k))) fail();
  const pointers = ORDER[kind].flatMap((k) => {
    let targets = f[k] ?? [];
    if (["caller", "administrator", "installed", "source-binding", "definition"].includes(k))
      targets = [...targets].sort((a, b) => {
        const key = (t: Target) =>
          t.kind === "delta" ? t.deltaRef.delta : t.kind === "primitive" ? String(t.value) : fail();
        return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
      });
    return targets.map((target) => ({ role: MATERIALIZATION_PREFIX + k, target }));
  });
  const claims = { author, timestamp: at, validFrom: at, pointers };
  assertValidClaims(claims);
  return claims;
}
