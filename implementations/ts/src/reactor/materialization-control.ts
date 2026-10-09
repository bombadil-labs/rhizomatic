// SPEC-16 MR-13/14/16/17: normalized maintained selections, the canonical control image codec
// and the pure conditional transition planner. Input is already verified by command; this owner
// validates structure and lifetime only. Caches, sources and signing live elsewhere.
import { array, bstr, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { bytesToHex, contentAddress } from "../delta/hash.js";

export const MATERIALIZATION_CONTROL_FORMAT = "rhizomatic.materialization-control/1";
/** External name of the initialized empty generation-0 image (MR-14). */
export const MATERIALIZATION_CONTROL_EMPTY_REVISION = "";
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;
const ID = /^1e20[0-9a-f]{64}$/;
const PEER = /^ed25519:[0-9a-f]{64}$/;

export class MaterializationControlError extends Error {
  constructor(readonly code: "invalid-control" | "resource-limit") {
    super(code);
  }
}
const fail = (code: "invalid-control" | "resource-limit" = "invalid-control"): never => {
  throw new MaterializationControlError(code);
};
const limit = (n: number, max: number): void => {
  if (n > max) fail("resource-limit");
};

export interface MaterializationControlLimits {
  readonly artifactBytes: number;
  readonly registrations: number;
  readonly definitions: number;
}
export type MaterializationControlStatus = "active" | "retired";
export interface MaterializationControlEntry {
  readonly registration: string;
  readonly status: MaterializationControlStatus;
  readonly transition: string;
  readonly sourceRevision: string;
  readonly authority: string;
  readonly at: number;
  readonly definitionAt: number;
  readonly hyperschemaPin: string;
  readonly schemaPin: string;
  readonly capture?: string;
}
/** Flat decoded image: entries sorted by registration, deltas keyed by full appearance key. */
export interface MaterializationControlImage {
  readonly receiver: string;
  readonly configuration: string;
  readonly generation: number;
  readonly entries: readonly MaterializationControlEntry[];
  readonly deltas: ReadonlyMap<string, Uint8Array>;
}
/** Normalized selection: each entry names the support it keeps reachable (MR-14). */
export interface MaterializationControlSelection {
  readonly receiver: string;
  readonly configuration: string;
  readonly generation: number;
  readonly entries: ReadonlyMap<
    string,
    {
      readonly entry: MaterializationControlEntry;
      readonly support: ReadonlyMap<string, Uint8Array>;
    }
  >;
}

/** Full appearance transport key: H(C(Appearance)) over the exact stored bytes. */
export function materializationAppearanceKey(bytes: Uint8Array): string {
  return contentAddress(bytes);
}
export function emptyMaterializationControl(
  receiver: string,
  configuration: string,
): MaterializationControlSelection {
  if (!PEER.test(receiver) || !ID.test(configuration)) fail();
  return { receiver, configuration, generation: 0, entries: new Map() };
}
const ENTRY_FIELDS = [
  "registration",
  "status",
  "transition",
  "sourceRevision",
  "authority",
  "at",
  "definitionAt",
  "hyperschemaPin",
  "schemaPin",
] as const;
function checkEntry(e: MaterializationControlEntry): void {
  for (const k of [
    "registration",
    "transition",
    "sourceRevision",
    "authority",
    "hyperschemaPin",
    "schemaPin",
  ] as const)
    if (!ID.test(e[k])) fail();
  for (const k of ["at", "definitionAt"] as const) if (!Number.isFinite(e[k])) fail();
  if (e.status === "active") {
    if (e.capture === undefined || !ID.test(e.capture)) fail();
  } else if (e.status === "retired") {
    if (e.capture !== undefined) fail();
  } else fail();
}
function encodeEntry(e: MaterializationControlEntry): CborValue {
  return map([
    ...ENTRY_FIELDS.map(
      (k) => [k, k === "at" || k === "definitionAt" ? float(e[k]) : tstr(e[k] as string)] as const,
    ),
    ...(e.capture === undefined ? [] : [["capture", tstr(e.capture)] as const]),
  ]);
}
const sortedEntries = (
  entries: Iterable<MaterializationControlEntry>,
): MaterializationControlEntry[] =>
  [...entries].sort((a, b) =>
    a.registration < b.registration ? -1 : a.registration > b.registration ? 1 : 0,
  );
function checkGeneration(generation: number, entryCount: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) fail();
  if (generation === 0 && entryCount > 0) fail();
  if (generation > 0 && entryCount === 0) fail();
}

/** Derive the flat image from a selection: deltas are the distinct reachable union. */
export function materializationControlImage(
  selection: MaterializationControlSelection,
  limits: MaterializationControlLimits,
): MaterializationControlImage {
  if (!PEER.test(selection.receiver) || !ID.test(selection.configuration)) fail();
  limit(selection.entries.size, limits.registrations);
  const entries = sortedEntries([...selection.entries.values()].map((x) => x.entry));
  checkGeneration(selection.generation, entries.length);
  const deltas = new Map<string, Uint8Array>();
  for (const [registration, { entry, support }] of selection.entries) {
    if (registration !== entry.registration) fail();
    checkEntry(entry);
    // Support is opaque here; command binds the single retired act to entry.transition.
    if (entry.status === "retired" && support.size !== 1) fail();
    for (const [key, bytes] of support) {
      if (materializationAppearanceKey(bytes) !== key) fail();
      const old = deltas.get(key);
      if (old !== undefined && bytesToHex(old) !== bytesToHex(bytes)) fail();
      deltas.set(key, bytes);
    }
  }
  return {
    receiver: selection.receiver,
    configuration: selection.configuration,
    generation: selection.generation,
    entries,
    deltas: new Map([...deltas].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}
export function encodeMaterializationControl(
  image: MaterializationControlImage,
  limits: MaterializationControlLimits,
): Uint8Array {
  if (!PEER.test(image.receiver) || !ID.test(image.configuration)) fail();
  limit(image.entries.length, limits.registrations);
  checkGeneration(image.generation, image.entries.length);
  const keys = [...image.deltas.keys()];
  limit(keys.length, limits.registrations * (limits.definitions + 4));
  for (let i = 0; i < image.entries.length; i++) {
    checkEntry(image.entries[i]!);
    if (i > 0 && image.entries[i - 1]!.registration >= image.entries[i]!.registration) fail();
  }
  for (let i = 0; i < keys.length; i++) {
    const bytes = image.deltas.get(keys[i]!)!;
    limit(bytes.length, limits.artifactBytes);
    if (materializationAppearanceKey(bytes) !== keys[i]) fail();
    if (i > 0 && keys[i - 1]! >= keys[i]!) fail();
  }
  const bytes = encode(
    map([
      ["format", tstr(MATERIALIZATION_CONTROL_FORMAT)],
      ["receiver", tstr(image.receiver)],
      ["configuration", tstr(image.configuration)],
      ["generation", float(image.generation)],
      ["entries", array(image.entries.map(encodeEntry))],
      ["deltas", array(keys.map((k) => bstr(image.deltas.get(k)!)))],
    ]),
  );
  limit(bytes.length, limits.artifactBytes);
  return bytes;
}
const fields = (
  v: CborValue,
  required: readonly string[],
  optional: readonly string[] = [],
): Map<string, CborValue> => {
  if (v.t !== "map") return fail();
  const fs = new Map<string, CborValue>();
  for (const [k, x] of v.v) {
    if (fs.has(k) || ![...required, ...optional].includes(k)) fail();
    fs.set(k, x);
  }
  if (required.some((k) => !fs.has(k))) fail();
  return fs;
};
const text = (x: CborValue | undefined): string => (x?.t === "tstr" ? x.v : fail());
const id = (x: CborValue | undefined): string => (ID.test(text(x)) ? text(x) : fail());
const number = (x: CborValue | undefined): number =>
  x?.t === "float" && Number.isFinite(x.v) ? x.v : fail();
/** Strict bounded decode with exact re-encoding; count bounds precede allocation. */
export function decodeMaterializationControl(
  input: Uint8Array,
  limits: MaterializationControlLimits,
): MaterializationControlImage {
  limit(input.length, limits.artifactBytes);
  // Exact re-encoding below is the canonical-form check; duplicate keys fail in `fields`.
  let value: CborValue;
  try {
    value = decode(input);
  } catch {
    return fail();
  }
  const fs = fields(value, [
    "format",
    "receiver",
    "configuration",
    "generation",
    "entries",
    "deltas",
  ]);
  if (text(fs.get("format")) !== MATERIALIZATION_CONTROL_FORMAT) fail();
  const receiver = text(fs.get("receiver"));
  if (!PEER.test(receiver)) fail();
  const configuration = id(fs.get("configuration"));
  const generation = number(fs.get("generation"));
  const rawEntries = fs.get("entries"),
    rawDeltas = fs.get("deltas");
  if (rawEntries?.t !== "array" || rawDeltas?.t !== "array") return fail();
  limit(rawEntries.v.length, limits.registrations);
  limit(rawDeltas.v.length, limits.registrations * (limits.definitions + 4));
  const entries: MaterializationControlEntry[] = rawEntries.v.map((e) => {
    const f = fields(e, ENTRY_FIELDS, ["capture"]);
    const raw = text(f.get("status"));
    const status: MaterializationControlStatus =
      raw === "active" ? "active" : raw === "retired" ? "retired" : fail();
    const entry: MaterializationControlEntry = {
      registration: id(f.get("registration")),
      status,
      transition: id(f.get("transition")),
      sourceRevision: id(f.get("sourceRevision")),
      authority: id(f.get("authority")),
      at: number(f.get("at")),
      definitionAt: number(f.get("definitionAt")),
      hyperschemaPin: id(f.get("hyperschemaPin")),
      schemaPin: id(f.get("schemaPin")),
      ...(f.has("capture") ? { capture: id(f.get("capture")) } : {}),
    };
    checkEntry(entry);
    return entry;
  });
  const deltas = new Map<string, Uint8Array>();
  for (const d of rawDeltas.v) {
    const bytes = d.t === "bstr" ? d.v : fail();
    deltas.set(materializationAppearanceKey(bytes), bytes);
  }
  const image: MaterializationControlImage = {
    receiver,
    configuration,
    generation,
    entries,
    deltas,
  };
  const again = encodeMaterializationControl(image, limits);
  if (bytesToHex(again) !== bytesToHex(input)) fail();
  return image;
}
/** External revision name: empty text for generation 0, else H(imageBytes). */
export function materializationControlRevision(bytes: Uint8Array, generation: number): string {
  return generation === 0 ? MATERIALIZATION_CONTROL_EMPTY_REVISION : contentAddress(bytes);
}

export interface MaterializationControlActive {
  readonly registration: string;
  readonly sourceRevision: string;
  readonly authority: string;
  readonly at: number;
  readonly definitionAt: number;
  readonly hyperschemaPin: string;
  readonly schemaPin: string;
  readonly capture: string;
}
export type MaterializationControlTransition =
  | {
      readonly verb: "install";
      readonly entry: MaterializationControlActive;
      readonly transition: string;
      /** Descriptor, complete definition closure, capture, authority and the transition act. */
      readonly support: ReadonlyMap<string, Uint8Array>;
    }
  | {
      readonly verb: "replace-source";
      readonly registration: string;
      readonly sourceRevision: string;
      readonly authority: string;
      readonly capture: string;
      readonly transition: string;
      /** Replacement capture, authority and transition acts. */
      readonly support: ReadonlyMap<string, Uint8Array>;
      /** Keys of the superseded capture, authority and transition acts. */
      readonly superseded: readonly string[];
    }
  | {
      readonly verb: "advance-time";
      readonly registration: string;
      readonly at: number;
      readonly transition: string;
      readonly support: ReadonlyMap<string, Uint8Array>;
      readonly superseded: readonly string[];
    }
  | {
      readonly verb: "retire";
      readonly registration: string;
      readonly transition: string;
      /** The terminal retire transition act only. */
      readonly support: ReadonlyMap<string, Uint8Array>;
    };
export type MaterializationControlPlan =
  | { readonly status: "planned"; readonly selection: MaterializationControlSelection }
  | {
      readonly status: "refused";
      readonly code:
        | "resource-limit"
        | "registration-missing"
        | "retired"
        | "already-installed"
        | "time-regression";
    };
const nextGeneration = (g: number): number | undefined =>
  g + 1 > MAX_GENERATION ? undefined : g + 1;
function withSupport(
  support: ReadonlyMap<string, Uint8Array>,
  keep: Iterable<string>,
  add: ReadonlyMap<string, Uint8Array>,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const k of keep) {
    out.set(k, support.get(k) ?? fail());
  }
  for (const [k, bytes] of add) out.set(k, bytes);
  return out;
}
/** Pure conditional planner: returns the prospective selection or the MR-16 known refusal. */
export function planMaterializationControl(
  current: MaterializationControlSelection,
  transition: MaterializationControlTransition,
  limits: MaterializationControlLimits,
): MaterializationControlPlan {
  const registration =
    transition.verb === "install" ? transition.entry.registration : transition.registration;
  const existing = current.entries.get(registration);
  if (transition.verb === "install") {
    if (existing)
      return {
        status: "refused",
        code: existing.entry.status === "retired" ? "retired" : "already-installed",
      };
    if (current.entries.size + 1 > limits.registrations)
      return { status: "refused", code: "resource-limit" };
  } else {
    if (!existing) return { status: "refused", code: "registration-missing" };
    if (existing.entry.status === "retired") return { status: "refused", code: "retired" };
    if (transition.verb === "advance-time" && transition.at < existing.entry.at)
      return { status: "refused", code: "time-regression" };
  }
  const generation = nextGeneration(current.generation);
  if (generation === undefined) return { status: "refused", code: "resource-limit" };
  for (const [k, bytes] of transition.support)
    if (materializationAppearanceKey(bytes) !== k) fail();
  const entries = new Map(current.entries);
  if (transition.verb === "install") {
    const entry: MaterializationControlEntry = {
      ...transition.entry,
      status: "active",
      transition: transition.transition,
    };
    checkEntry(entry);
    entries.set(registration, { entry, support: new Map(transition.support) });
  } else if (transition.verb === "retire") {
    if (transition.support.size !== 1) fail();
    const e = existing!.entry;
    const entry: MaterializationControlEntry = {
      registration: e.registration,
      status: "retired",
      transition: transition.transition,
      sourceRevision: e.sourceRevision,
      authority: e.authority,
      at: e.at,
      definitionAt: e.definitionAt,
      hyperschemaPin: e.hyperschemaPin,
      schemaPin: e.schemaPin,
    };
    entries.set(registration, { entry, support: new Map(transition.support) });
  } else {
    const keep = [...existing!.support.keys()].filter((k) => !transition.superseded.includes(k));
    const entry: MaterializationControlEntry =
      transition.verb === "replace-source"
        ? {
            ...existing!.entry,
            sourceRevision: transition.sourceRevision,
            authority: transition.authority,
            capture: transition.capture,
            transition: transition.transition,
          }
        : { ...existing!.entry, at: transition.at, transition: transition.transition };
    checkEntry(entry);
    entries.set(registration, {
      entry,
      support: withSupport(existing!.support, keep, transition.support),
    });
  }
  return {
    status: "planned",
    selection: {
      receiver: current.receiver,
      configuration: current.configuration,
      generation,
      entries,
    },
  };
}
