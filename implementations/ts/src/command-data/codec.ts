// SPEC-15: pure description codecs. Verification is attribution, never installation.
import { decode, encode, map, tstr, float, bool, type CborValue } from "../delta/cbor.js";
import { canonicalBytes, assertValidClaims } from "../delta/delta.js";
import { claimsToJson, parseClaims } from "../delta/json-profile.js";
import { signClaims, verifyDelta, authorForSeed } from "../delta/sign.js";
import { VOCAB_PREFIX } from "../delta/vocab.js";
import type { Delta, Pointer, Primitive, Target } from "../delta/types.js";

export const COMMAND_PREFIX = `${VOCAB_PREFIX}.command.`;
export const COMMAND_PROFILE = `${VOCAB_PREFIX}.command/1`;
export type Interpretation = "core/1" | "principal-sameAuthor/1" | "principal-rootOrSameAuthor/1";
export type CommandFields = Readonly<Record<string, readonly Target[]>>;
export type DescriptionKind = "endpoint/1" | "operation/1" | "request/1" | "outcome/1";
export const isCommandId = (value: string): boolean => /^1e20[0-9a-f]{64}$/.test(value);
export const isCommandKey = (value: string): boolean => /^ed25519:[0-9a-f]{64}$/.test(value);
const head = (v: string): boolean => v === "" || isCommandId(v);
function fail(): never {
  throw new Error("invalid command description");
}
const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
export function canonicalCommandCbor(bytes: Uint8Array): CborValue {
  const v = decode(bytes);
  const visit = (x: CborValue): void => {
    if (x.t === "map") {
      const keys = new Set<string>();
      for (const [k, c] of x.v) {
        if (keys.has(k)) fail();
        keys.add(k);
        visit(c);
      }
    } else if (x.t === "array") x.v.forEach(visit);
  };
  visit(v);
  if (!equal(encode(v), bytes)) fail();
  return v;
}
export function encodeBindings(bindings: Readonly<Record<string, Primitive>>): Uint8Array {
  if (Object.hasOwn(bindings, "root")) fail();
  return encode(
    map(
      Object.entries(bindings).map(([k, v]) => [
        k,
        typeof v === "string" ? tstr(v) : typeof v === "boolean" ? bool(v) : float(v),
      ]),
    ),
  );
}
export function decodeBindings(bytes: Uint8Array): Readonly<Record<string, Primitive>> {
  const v = canonicalCommandCbor(bytes);
  if (v.t !== "map") fail();
  const entries = v.v.map(([k, x]): [string, Primitive] => {
    if (k === "root" || !["tstr", "bool", "float"].includes(x.t)) fail();
    return [k, x.v as Primitive];
  });
  return Object.fromEntries(entries);
}
export function serializeCommandDelta(delta: Delta): unknown {
  return { id: delta.id, claims: claimsToJson(delta.claims), sig: delta.sig };
}
export function parseCommandDelta(raw: unknown): Delta {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail();
  const o = raw as Record<string, unknown>;
  if (
    Object.keys(o).some((k) => !["id", "claims", "sig"].includes(k)) ||
    typeof o.id !== "string" ||
    (o.sig !== undefined && typeof o.sig !== "string")
  )
    fail();
  const d = {
    id: o.id,
    claims: parseClaims(o.claims),
    ...(o.sig === undefined ? {} : { sig: o.sig }),
  };
  assertValidClaims(d.claims);
  return d;
}
export function verifyCommandAppearance(delta: Delta): void {
  if (
    !isCommandId(delta.id) ||
    !isCommandKey(delta.claims.author) ||
    delta.sig === undefined ||
    verifyDelta(delta) !== "verified"
  )
    fail();
  canonicalBytes(delta.claims);
}
export function commandFields(delta: Delta): CommandFields {
  const fields: Record<string, Target[]> = {};
  for (const p of delta.claims.pointers) {
    if (!p.role.startsWith(COMMAND_PREFIX)) fail();
    const role = p.role.slice(COMMAND_PREFIX.length);
    (fields[role] ??= []).push(p.target);
  }
  return fields;
}
export function commandText(fields: CommandFields, key: string): string {
  const t = fields[key]?.[0];
  if (t?.kind !== "primitive" || typeof t.value !== "string") fail();
  return t.value;
}
export function commandEntity(fields: CommandFields, key: string): string {
  const t = fields[key]?.[0];
  if (t?.kind !== "entity" || t.entity.context !== undefined) fail();
  return t.entity.id;
}
export function commandRef(fields: CommandFields, key: string): string {
  const t = fields[key]?.[0];
  if (t?.kind !== "delta" || t.deltaRef.context !== undefined || !isCommandId(t.deltaRef.delta))
    fail();
  return t.deltaRef.delta;
}
export function commandNumber(fields: CommandFields, key: string): number {
  const t = fields[key]?.[0];
  if (t?.kind !== "primitive" || typeof t.value !== "number" || !Number.isFinite(t.value)) fail();
  return t.value;
}
export function commandBytes(fields: CommandFields, key: string): Uint8Array {
  const t = fields[key]?.[0];
  if (t?.kind !== "bytes" || t.mime !== "application/cbor") fail();
  return t.value;
}
const COMMON = ["kind", "receiver", "configuration", "operation", "expected-head"];
export const EVALUATE_FIELDS = [
  "source",
  "expected-digest",
  "root",
  "at",
  "interpretation",
  "hyperschema",
  "hyperschema-pin",
  "schema",
  "schema-pin",
  "definition",
  "bindings",
];
const ORDERS: Record<DescriptionKind, readonly string[]> = {
  "endpoint/1": ["kind", "receiver", "caller", "installed", "quota", "max-deltas", "max-bytes"],
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
  "request/1": [...COMMON, "payload", ...EVALUATE_FIELDS],
  "outcome/1": ["kind", "receiver", "configuration", "request", "status", "result"],
};
function shapes(
  fields: CommandFields,
  allowed: readonly string[],
  optional: readonly string[] = [],
  sets: readonly string[] = [],
): void {
  if (Object.keys(fields).some((k) => !allowed.includes(k))) fail();
  for (const k of allowed) {
    const list = fields[k] ?? [];
    if (sets.includes(k)) {
      const keys = list.map((v) =>
        k === "caller" && v.kind === "primitive"
          ? `${typeof v.value}:${String(v.value)}`
          : v.kind === "delta"
            ? v.deltaRef.delta
            : fail(),
      );
      if (new Set(keys).size !== keys.length) fail();
    } else if (list.length !== (optional.includes(k) ? Math.min(list.length, 1) : 1)) fail();
  }
}
export function readConfiguration(delta: Delta): CommandFields {
  const f = commandFields(delta);
  shapes(f, ORDERS["endpoint/1"], [], ["caller", "installed"]);
  if (
    commandText(f, "kind") !== "endpoint/1" ||
    !isCommandKey(commandEntity(f, "receiver")) ||
    !f.caller?.length ||
    f.installed?.length !== 2
  )
    fail();
  for (const t of f.caller) {
    if (t.kind !== "primitive" || typeof t.value !== "string" || !isCommandKey(t.value)) fail();
  }
  for (const t of f.installed) {
    if (t.kind !== "delta" || t.deltaRef.context !== undefined || !isCommandId(t.deltaRef.delta))
      fail();
  }
  for (const k of ["quota", "max-deltas", "max-bytes"]) {
    const v = commandNumber(f, k);
    if (!Number.isSafeInteger(v) || v < 0 || (k !== "quota" && v === 0)) fail();
  }
  return f;
}
export function readOperation(delta: Delta): "retain" | "evaluate" {
  const f = commandFields(delta);
  shapes(f, ORDERS["operation/1"]);
  if (commandText(f, "kind") !== "operation/1") fail();
  const name = commandEntity(f, "name");
  const kind =
    name === `${COMMAND_PREFIX}retain`
      ? "retain"
      : name === `${COMMAND_PREFIX}evaluate`
        ? "evaluate"
        : fail();
  const expected: Record<string, string> = {
    interpreter: `${COMMAND_PREFIX}${kind}/1`,
    "input-contract": `${COMMAND_PREFIX}${kind}/1`,
    "output-contract": `${COMMAND_PREFIX}outcome/1`,
    effect: kind === "retain" ? "admission" : "none",
    replay: "re-evaluate/1",
    dependencies: "explicit-support/1",
  };
  for (const [k, v] of Object.entries(expected)) if (commandText(f, k) !== v) fail();
  return kind;
}
export function readRequestCommon(delta: Delta): CommandFields {
  const f = commandFields(delta);
  for (const k of COMMON) {
    const n = f[k]?.length ?? 0;
    if (k === "expected-head" ? n > 1 : n !== 1) fail();
  }
  if (commandText(f, "kind") !== "request/1" || !isCommandKey(commandEntity(f, "receiver"))) fail();
  commandRef(f, "configuration");
  commandRef(f, "operation");
  if (f["expected-head"] && !head(commandText(f, "expected-head"))) fail();
  return f;
}
export function readRequestArguments(delta: Delta, kind: "retain" | "evaluate"): CommandFields {
  const f = readRequestCommon(delta);
  const allowed = kind === "retain" ? [...COMMON, "payload"] : [...COMMON, ...EVALUATE_FIELDS];
  shapes(f, allowed, kind === "retain" ? ["expected-head"] : ["expected-head", "expected-digest"], [
    kind === "retain" ? "payload" : "definition",
  ]);
  if (kind === "retain") {
    if (!f.payload?.length) fail();
    for (const t of f.payload) {
      if (t.kind !== "delta" || t.deltaRef.context !== undefined || !isCommandId(t.deltaRef.delta))
        fail();
    }
  } else {
    if (
      !["admitted", "catalog"].includes(commandText(f, "source")) ||
      !["core/1", "principal-sameAuthor/1", "principal-rootOrSameAuthor/1"].includes(
        commandText(f, "interpretation"),
      )
    )
      fail();
    if (commandText(f, "source") === "catalog" && f["expected-head"]) fail();
    commandEntity(f, "root");
    commandNumber(f, "at");
    for (const k of ["hyperschema", "schema"]) commandRef(f, k);
    for (const k of ["hyperschema-pin", "schema-pin", "expected-digest"])
      if (f[k] && !isCommandId(commandText(f, k))) fail();
    for (const t of f.definition ?? [])
      if (t.kind !== "delta" || t.deltaRef.context !== undefined || !isCommandId(t.deltaRef.delta))
        fail();
    const ids = [
      commandRef(f, "hyperschema"),
      commandRef(f, "schema"),
      ...(f.definition ?? []).map((t) => (t.kind === "delta" ? t.deltaRef.delta : fail())),
    ];
    if (new Set(ids).size !== ids.length) fail();
    decodeBindings(commandBytes(f, "bindings"));
  }
  return f;
}
export function writeCommandDescription(
  seed: string,
  at: number,
  kind: DescriptionKind,
  fields: CommandFields,
): Delta {
  const f: CommandFields = { ...fields, kind: [{ kind: "primitive" as const, value: kind }] };
  const pointers: Pointer[] = [];
  for (const key of ORDERS[kind]) {
    let targets = f[key] ?? [];
    if (["caller", "installed", "payload", "definition"].includes(key))
      targets = [...targets].sort((a, b) => {
        const value = (t: Target) =>
          t.kind === "delta" ? t.deltaRef.delta : t.kind === "primitive" ? String(t.value) : fail();
        return value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0;
      });
    for (const target of targets) pointers.push({ role: COMMAND_PREFIX + key, target });
  }
  if (Object.keys(f).some((k) => !ORDERS[kind].includes(k))) fail();
  return signClaims({ timestamp: at, validFrom: at, author: authorForSeed(seed), pointers }, seed);
}
export const COMMAND_REFUSALS = [
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
  "admission-rejected",
  "write-conflict",
  "source-changed",
  "source-unavailable",
  "precondition-failed",
  "resource-limit",
  "resource-exhausted",
  "invalid-definition",
  "pin-mismatch",
  "ambiguous-definition",
  "definition-closure",
  "definition-cycle",
  "invalid-program",
] as const;
export interface ReadOutcome {
  readonly fields: CommandFields;
  readonly status: "completed" | "refused" | "indeterminate";
  readonly body: ReadonlyMap<string, CborValue>;
  readonly value?: Uint8Array;
}
export function readOutcome(delta: Delta): ReadOutcome {
  if (delta.claims.timestamp !== delta.claims.validFrom || delta.claims.validUntil !== undefined)
    fail();
  const f = commandFields(delta);
  shapes(f, ORDERS["outcome/1"]);
  if (commandText(f, "kind") !== "outcome/1" || !isCommandKey(commandEntity(f, "receiver"))) fail();
  commandRef(f, "configuration");
  if (delta.claims.author !== commandEntity(f, "receiver")) fail();
  commandRef(f, "request");
  const status = commandText(f, "status");
  if (!["completed", "refused", "indeterminate"].includes(status)) fail();
  const decoded = canonicalCommandCbor(commandBytes(f, "result"));
  if (decoded.t !== "map") fail();
  const body = new Map(decoded.v);
  const text = (k: string) => {
    const x = body.get(k);
    return x?.t === "tstr" ? x.v : fail();
  };
  const exact = (keys: string[]) => {
    if (body.size !== keys.length || keys.some((k) => !body.has(k))) fail();
  };
  if (status !== "completed") {
    exact(["code"]);
    const code = text("code");
    if (
      status === "indeterminate"
        ? code !== "commit-unconfirmed"
        : !COMMAND_REFUSALS.includes(code as (typeof COMMAND_REFUSALS)[number])
    )
      fail();
  } else if (text("kind") === "retain") {
    exact(["kind", "beforeHead", "head", "beforeDigest", "digest", "admitted", "duplicate"]);
    for (const k of ["beforeHead", "head"]) if (!head(text(k))) fail();
    for (const k of ["beforeDigest", "digest"]) if (!isCommandId(text(k))) fail();
    const ids = (k: string): string[] => {
      const a = body.get(k);
      if (a?.t !== "array") fail();
      const values = a.v.map((x) => (x.t === "tstr" && isCommandId(x.v) ? x.v : fail()));
      if (values.some((v, i) => i > 0 && values[i - 1]! >= v)) fail();
      return values;
    };
    const admitted = ids("admitted"),
      duplicate = ids("duplicate");
    if (admitted.some((id) => duplicate.includes(id))) fail();
  } else if (text("kind") === "evaluate") {
    const source = text("source");
    if (!["admitted", "catalog"].includes(source)) fail();
    exact([
      "kind",
      "source",
      "digest",
      "definitionDigest",
      "at",
      "interpretation",
      "hyperschemaPin",
      "schemaPin",
      "value",
      ...(source === "admitted" ? ["head"] : []),
    ]);
    for (const k of ["digest", "definitionDigest", "hyperschemaPin", "schemaPin"])
      if (!isCommandId(text(k))) fail();
    if (source === "admitted" && !head(text("head"))) fail();
    if (
      body.get("at")?.t !== "float" ||
      !["core/1", "principal-sameAuthor/1", "principal-rootOrSameAuthor/1"].includes(
        text("interpretation"),
      ) ||
      body.get("value")?.t !== "bstr"
    )
      fail();
  } else fail();
  const value = body.get("value");
  return {
    fields: f,
    status: status as ReadOutcome["status"],
    body,
    ...(value?.t === "bstr" ? { value: value.v } : {}),
  };
}
