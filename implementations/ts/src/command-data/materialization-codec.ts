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
export const MATERIALIZATION_VERBS = Object.freeze([
  "gather",
  "resolve",
  "install",
  "replace-source",
  "advance-time",
  "retire",
  "read",
  "restore",
] as const);
export type MaterializationVerb = (typeof MATERIALIZATION_VERBS)[number];
/** Release A installs the first two verbs; release B installs all eight (MR-08). */
export const MATERIALIZATION_RELEASE_VERBS = Object.freeze({
  A: MATERIALIZATION_VERBS.slice(0, 2),
  B: MATERIALIZATION_VERBS,
});
export const materializationVerbEffect = (verb: MaterializationVerb): "none" | "control" =>
  ["install", "replace-source", "advance-time", "retire"].includes(verb) ? "control" : "none";
export type MaterializationDescriptionKind =
  | "endpoint/1"
  | "operation/1"
  | "request/1"
  | "source-binding/1"
  | "authority/1"
  | "capture/1"
  | "snapshot/1"
  | "evidence/1"
  | "outcome/1"
  | "registration/1"
  | "state/1"
  | "control-image/1";
const COMMON = ["kind", "receiver", "configuration", "operation"];
const LIFECYCLE = ["expected-control", "registration", "expected-source"];
/** Verb-specific request roles after the common fields (MR-08 table). */
const VERB_ROLES: Record<Exclude<MaterializationVerb, "gather">, readonly string[]> = {
  resolve: ["evidence"],
  install: ["expected-control", "registration", "capture", "snapshot", "at", "serving-at"],
  "replace-source": [
    "expected-control",
    "registration",
    "expected-source",
    "capture",
    "snapshot",
    "serving-at",
  ],
  "advance-time": [
    "expected-control",
    "registration",
    "expected-source",
    "snapshot",
    "at",
    "serving-at",
  ],
  retire: ["expected-control", "registration"],
  read: ["expected-control", "registration", "expected-source", "snapshot", "serving-at"],
  restore: ["expected-control"],
};
export const STATE_VERBS = Object.freeze(["install", "replace-source", "advance-time", "retire"]);
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
  "request/1": [...COMMON, ...LIFECYCLE, ...GATHER, "evidence"],
  "source-binding/1": ["kind", "receiver", "spec"],
  "authority/1": ["kind", "source-binding", "spec"],
  "capture/1": ["kind", "source-binding", "authority", "basis"],
  "snapshot/1": ["kind", "data"],
  "evidence/1": ["kind", "result"],
  "outcome/1": ["kind", "receiver", "configuration", "request", "status", "result"],
  "registration/1": [
    "kind",
    "source-binding",
    "hyperschema",
    "hyperschema-pin",
    "schema",
    "schema-pin",
    "definition",
    "roots",
    "bindings",
    "definition-at",
    "interpretation",
    "result-kind",
    "time-policy",
    "alias",
  ],
  "state/1": [
    "kind",
    "registration",
    "generation",
    "prior-control",
    "prior-transition",
    "verb",
    "source-revision",
    "authority",
    "at",
    "definition-at",
    "hyperschema-pin",
    "schema-pin",
    "capture",
  ],
  "control-image/1": ["kind", "data"],
};
const SETS = [
  "caller",
  "administrator",
  "installed",
  "source-binding",
  "definition",
  "roots",
  "alias",
];
const setKey = (t: Target): string =>
  t.kind === "delta"
    ? t.deltaRef.delta
    : t.kind === "primitive" && typeof t.value === "string"
      ? t.value
      : t.kind === "entity" && t.entity.context === undefined
        ? t.entity.id
        : fail();
/**
 * Bytewise order of the UTF-8 encodings (MR-04/MR-13), which is code point order; JavaScript's
 * default string order compares UTF-16 code units and disagrees above U+FFFF.
 */
export function compareMaterializationText(a: string, b: string): number {
  const xs = [...a],
    ys = [...b];
  for (let i = 0; i < xs.length && i < ys.length; i++) {
    const d = xs[i]!.codePointAt(0)! - ys[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return xs.length - ys.length;
}
const bySetKey = (a: Target, b: Target) => compareMaterializationText(setKey(a), setKey(b));
const isN = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
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
      const values = ts.map(setKey);
      if (new Set(values).size !== values.length) fail();
    } else if (ts.length !== (optional.includes(k) ? Math.min(ts.length, 1) : 1)) fail();
  }
}
export function materializationOperationVerb(name: string): MaterializationVerb {
  const verb = name.startsWith(MATERIALIZATION_PREFIX)
    ? name.slice(MATERIALIZATION_PREFIX.length)
    : fail();
  return (MATERIALIZATION_VERBS as readonly string[]).includes(verb)
    ? (verb as MaterializationVerb)
    : fail();
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
/** Readers accept pointer permutations: set-valued roles read in their canonical sorted order. */
export function materializationFields(delta: Delta): CommandFields {
  const fields: Record<string, Target[]> = Object.create(null) as Record<string, Target[]>;
  for (const p of delta.claims.pointers) {
    if (!p.role.startsWith(MATERIALIZATION_PREFIX)) fail();
    const k = p.role.slice(MATERIALIZATION_PREFIX.length);
    (fields[k] ??= []).push(p.target);
  }
  for (const k of SETS)
    if (fields[k] && fields[k].length > 1) fields[k] = [...fields[k]].sort(bySetKey);
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
      verb === "gather" ? [...COMMON, ...GATHER] : [...COMMON, ...VERB_ROLES[verb]],
      verb === "gather" ? ["historical-cutoff"] : [],
      verb === "gather" ? ["definition"] : [],
    );
    if (verb === "resolve") {
      commandRef(f, "evidence");
      return f;
    }
    if (verb !== "gather") {
      const control = commandText(f, "expected-control");
      if (control !== "" && !isCommandId(control)) fail();
      for (const k of VERB_ROLES[verb]) {
        if (["registration", "capture", "snapshot"].includes(k)) commandRef(f, k);
        if (k === "expected-source" && !isCommandId(commandText(f, k))) fail();
        if (["at", "serving-at"].includes(k)) commandNumber(f, k);
      }
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
    kind === "state/1" ? ["capture"] : [],
    kind === "endpoint/1"
      ? ["caller", "administrator", "installed", "source-binding"]
      : kind === "registration/1"
        ? ["definition", "roots", "alias"]
        : [],
  );
  if (
    ["endpoint/1", "source-binding/1", "outcome/1"].includes(kind) &&
    !isCommandKey(commandEntity(f, "receiver"))
  )
    fail();
  if (kind === "endpoint/1") {
    if (!f.caller?.length || !f.administrator?.length || ![2, 8].includes(f.installed?.length ?? 0))
      fail();
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
    const verb = materializationOperationVerb(commandEntity(f, "name"));
    for (const [k, v] of Object.entries({
      interpreter: MATERIALIZATION_PREFIX + verb + "/1",
      "input-contract": MATERIALIZATION_PREFIX + verb + "/1",
      "output-contract": MATERIALIZATION_PREFIX + "outcome/1",
      effect: materializationVerbEffect(verb),
      replay: "re-evaluate/1",
      dependencies: "explicit-support/1",
    }))
      if (commandText(f, k) !== v) fail();
  }
  if (kind === "registration/1") {
    for (const k of ["source-binding", "hyperschema", "schema"]) commandRef(f, k);
    for (const k of ["hyperschema-pin", "schema-pin"]) if (!isCommandId(commandText(f, k))) fail();
    const ids = [commandRef(f, "hyperschema"), commandRef(f, "schema")];
    for (const t of f.definition ?? []) {
      const id = commandRef({ x: [t] }, "x");
      if (ids.includes(id)) fail();
      ids.push(id);
    }
    // MR-13: roots are distinct nonempty entities and aliases distinct nonempty texts, each
    // sorted bytewise; a text root or an entity alias is not a registration descriptor.
    const roots = (f.roots ?? []).map((t) =>
      t.kind === "entity" && t.entity.context === undefined ? t.entity.id : fail(),
    );
    const strictlyAscending = (xs: string[]) =>
      xs.every((x, i) => x && (i === 0 || compareMaterializationText(xs[i - 1]!, x) < 0));
    if (!roots.length || !strictlyAscending(roots)) fail();
    const aliases = (f.alias ?? []).map((t) =>
      t.kind === "primitive" && typeof t.value === "string" ? t.value : fail(),
    );
    if (!strictlyAscending(aliases)) fail();
    decodeBindings(commandBytes(f, "bindings"));
    commandNumber(f, "definition-at");
    if (
      commandText(f, "interpretation") !== "core/1" ||
      commandText(f, "result-kind") !== "hview-and-view/1" ||
      commandText(f, "time-policy") !== "live-time/1"
    )
      fail();
  }
  if (kind === "state/1") {
    commandRef(f, "registration");
    if (!isN(commandNumber(f, "generation")) || commandNumber(f, "generation") < 1) fail();
    for (const k of ["prior-control", "prior-transition"]) {
      const v = commandText(f, k);
      if (v !== "" && !isCommandId(v)) fail();
    }
    const verb = commandText(f, "verb");
    if (!STATE_VERBS.includes(verb)) fail();
    for (const k of ["source-revision", "authority", "hyperschema-pin", "schema-pin"])
      if (!isCommandId(commandText(f, k))) fail();
    for (const k of ["at", "definition-at"]) commandNumber(f, k);
    if ((verb === "retire") !== (f.capture === undefined)) fail();
    if (f.capture) commandRef(f, "capture");
    if (delta.claims.timestamp !== delta.claims.validFrom || delta.claims.validUntil !== undefined)
      fail();
  }
  if (["authority/1", "capture/1"].includes(kind)) commandRef(f, "source-binding");
  if (kind === "capture/1") commandRef(f, "authority");
  for (const k of ["spec", "basis", "data", "result"]) if (f[k]) commandBytes(f, k);
  if (kind === "control-image/1") commandBytes(f, "data");
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
    if (SETS.includes(k)) targets = [...targets].sort(bySetKey);
    return targets.map((target) => ({ role: MATERIALIZATION_PREFIX + k, target }));
  });
  const claims = { author, timestamp: at, validFrom: at, pointers };
  assertValidClaims(claims);
  return claims;
}
