// Independent SPEC-16 MR-14 control image oracles. No reactor, command or M2/M3 codec imports:
// existing L0 CBOR, hashing and signing supply primitives only. Expected bytes are assembled from
// the MR-14 map shape by hand so a shared misreading in both witnesses cannot pass.
import { writeFileSync } from "node:fs";
import { array, bstr, encode, float, map, tstr, type CborValue } from "../src/delta/cbor.js";
import { canonicalBytes } from "../src/delta/delta.js";
import { bytesToHex, contentAddress } from "../src/delta/hash.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import type { Delta } from "../src/delta/types.js";

const hex = (b: Uint8Array) => bytesToHex(b);
const seeds = { receiver: "03".repeat(32), capturer: "06".repeat(32) };
const receiver = authorForSeed(seeds.receiver);
const configuration = contentAddress(encode(tstr("control-vectors-configuration")));
const id = (label: string) => contentAddress(encode(tstr(label)));
/** Any signed delta serves the codec: control treats support as opaque appearance bytes. */
function act(label: string, seed = seeds.receiver): Delta {
  return signClaims(
    {
      author: authorForSeed(seed),
      timestamp: 10,
      validFrom: 10,
      pointers: [
        { role: "rhizomatic.materialization.kind", target: { kind: "primitive", value: label } },
      ],
    },
    seed,
  );
}
const appearance = (d: Delta) =>
  encode(
    map([
      ["id", tstr(d.id)],
      ["claims", bstr(canonicalBytes(d.claims))],
      ["sig", bstr(Uint8Array.from(d.sig!.match(/../g)!, (x) => parseInt(x, 16)))],
    ]),
  );
const key = (bytes: Uint8Array) => contentAddress(bytes);
interface Entry {
  registration: string;
  status: "active" | "retired";
  transition: string;
  sourceRevision: string;
  authority: string;
  at: number;
  definitionAt: number;
  hyperschemaPin: string;
  schemaPin: string;
  capture?: string;
}
const entryValue = (e: Entry): CborValue =>
  map([
    ["registration", tstr(e.registration)],
    ["status", tstr(e.status)],
    ["transition", tstr(e.transition)],
    ["sourceRevision", tstr(e.sourceRevision)],
    ["authority", tstr(e.authority)],
    ["at", float(e.at)],
    ["definitionAt", float(e.definitionAt)],
    ["hyperschemaPin", tstr(e.hyperschemaPin)],
    ["schemaPin", tstr(e.schemaPin)],
    ...(e.capture === undefined ? [] : [["capture", tstr(e.capture)] as const]),
  ]);
function imageValue(
  generation: number,
  entries: readonly Entry[],
  deltas: readonly Uint8Array[],
  extra: readonly (readonly [string, CborValue])[] = [],
  format = "rhizomatic.materialization-control/1",
): CborValue {
  return map([
    ["format", tstr(format)],
    ["receiver", tstr(receiver)],
    ["configuration", tstr(configuration)],
    ["generation", float(generation)],
    ["entries", array(entries.map(entryValue))],
    ["deltas", array(deltas.map(bstr))],
    ...extra,
  ]);
}
const sortedByKey = (ds: Uint8Array[]) =>
  [...ds].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
const descriptor = act("registration/1"),
  capture = act("capture/1", seeds.capturer),
  authority = act("authority/1", seeds.capturer),
  install = act("state/1 install"),
  retireAct = act("state/1 retire"),
  descriptor2 = act("registration/1 second");
const active: Entry = {
  registration: descriptor.id,
  status: "active",
  transition: install.id,
  sourceRevision: id("source-revision"),
  authority: authority.id,
  at: 1000,
  definitionAt: 1000,
  hyperschemaPin: id("hyper-pin"),
  schemaPin: id("schema-pin"),
  capture: capture.id,
};
const retired: Entry = {
  registration: descriptor2.id,
  status: "retired",
  transition: retireAct.id,
  sourceRevision: id("source-revision-2"),
  authority: id("authority-2"),
  at: 1500,
  definitionAt: 1000,
  hyperschemaPin: id("hyper-pin"),
  schemaPin: id("schema-pin-2"),
};
const activeSupport = sortedByKey([descriptor, capture, authority, install].map(appearance));
const twoEntries = [active, retired].sort((a, b) => (a.registration < b.registration ? -1 : 1));
const twoSupport = sortedByKey([...activeSupport, appearance(retireAct)]);
const limits = { artifactBytes: 16777216, registrations: 64, definitions: 256 };
const positives = [
  { id: "empty", generation: 0, entries: [] as Entry[], deltas: [] as Uint8Array[] },
  { id: "active_one", generation: 1, entries: [active], deltas: activeSupport },
  { id: "active_and_retired", generation: 3, entries: twoEntries, deltas: twoSupport },
].map((p) => {
  const bytes = encode(imageValue(p.generation, p.entries, p.deltas));
  return {
    id: p.id,
    imageHex: hex(bytes),
    revision: p.generation === 0 ? "" : contentAddress(bytes),
    expected: {
      receiver,
      configuration,
      generation: p.generation,
      entries: p.entries,
      deltaKeys: p.deltas.map(key),
    },
  };
});
const negatives: { id: string; imageHex: string; code: string; limits?: typeof limits }[] = [];
const neg = (
  id: string,
  value: CborValue | Uint8Array,
  code = "invalid-control",
  l?: typeof limits,
) =>
  negatives.push({
    id,
    imageHex: hex(value instanceof Uint8Array ? value : encode(value)),
    code,
    ...(l ? { limits: l } : {}),
  });
neg("unknown_key", imageValue(1, [active], activeSupport, [["extra", tstr("x")]]));
neg(
  "wrong_format",
  imageValue(1, [active], activeSupport, [], "rhizomatic.materialization-control/2"),
);
neg("entries_unsorted", imageValue(3, [...twoEntries].reverse(), twoSupport));
neg("duplicate_registration", imageValue(2, [active, active], activeSupport));
{
  const noCapture = Object.fromEntries(
    Object.entries(active).filter(([k]) => k !== "capture"),
  ) as Entry;
  neg("active_without_capture", imageValue(1, [noCapture], activeSupport));
}
neg(
  "retired_with_capture",
  imageValue(
    3,
    twoEntries.map((e) => ({ ...e, capture: capture.id })),
    twoSupport,
  ),
);
neg("generation_zero_with_entries", imageValue(0, [active], activeSupport));
neg("generation_without_entries", imageValue(1, [], []));
neg("generation_fraction", imageValue(1.5, [active], activeSupport));
neg("generation_negative", imageValue(-1, [], []));
neg("bad_status", imageValue(1, [{ ...active, status: "paused" as "active" }], activeSupport));
neg("deltas_unsorted", imageValue(1, [active], [...activeSupport].reverse()));
neg("duplicate_delta", imageValue(1, [active], [...activeSupport, activeSupport[0]!]));
neg(
  "delta_not_bytes",
  map([
    ["format", tstr("rhizomatic.materialization-control/1")],
    ["receiver", tstr(receiver)],
    ["configuration", tstr(configuration)],
    ["generation", float(1)],
    ["entries", array([entryValue(active)])],
    ["deltas", array([tstr("not bytes")])],
  ]),
);
neg(
  "bad_receiver",
  map([
    ["format", tstr("rhizomatic.materialization-control/1")],
    ["receiver", tstr("not-a-key")],
    ["configuration", tstr(configuration)],
    ["generation", float(0)],
    ["entries", array([])],
    ["deltas", array([])],
  ]),
);
neg("bad_id_field", imageValue(1, [{ ...active, authority: "1e20short" }], activeSupport));
// Canonical encoders refuse non-finite numbers; splice a half-float Infinity into valid bytes.
{
  const probe = hex(encode(imageValue(1, [active], activeSupport)));
  const finite = hex(encode(float(1000)));
  if (!probe.includes(finite)) throw Error("nonfinite probe anchor missing");
  neg(
    "nonfinite_at",
    Uint8Array.from(probe.replace(finite, "f97c00").match(/../g)!, (x) => parseInt(x, 16)),
  );
}
// Noncanonical map key order: the strict decoder requires exact re-encoding (MR-04).
{
  const canonical = imageValue(0, [], []);
  if (canonical.t !== "map") throw Error();
  const swapped = map([...canonical.v].reverse());
  const raw = encode(swapped);
  // encode() sorts keys; splice a hand-built unsorted map instead.
  const head = Uint8Array.of(0xa6);
  const pair = (k: string, v: CborValue) => [encode(tstr(k)), encode(v)].flatMap((b) => [...b]);
  const body = [...canonical.v].reverse().flatMap(([k, v]) => pair(k, v));
  const unsorted = Uint8Array.from([...head, ...body]);
  if (hex(unsorted) === hex(raw)) throw Error("unsorted probe must differ from canonical bytes");
  neg("noncanonical_key_order", unsorted);
}
neg("truncated", encode(imageValue(1, [active], activeSupport)).slice(0, -3));
neg("entries_over_registrations", imageValue(3, twoEntries, twoSupport), "resource-limit", {
  ...limits,
  registrations: 1,
});
neg("image_over_artifact_bytes", imageValue(1, [active], activeSupport), "resource-limit", {
  ...limits,
  artifactBytes: encode(imageValue(1, [active], activeSupport)).length - 1,
});
const out = {
  format: "rhizomatic-materialization-control-vectors/1",
  oracle:
    "SPEC-16 MR-14 map shape assembled by hand over existing canonical CBOR, contentAddress and Ed25519 signing. No reactor, command or control codec imports. Support deltas are arbitrary signed acts: the image codec treats them as opaque appearance bytes keyed by H(bytes).",
  keys: { receiver },
  configuration,
  limits,
  positives,
  negatives,
};
writeFileSync("vectors/materialization/control-image.json", JSON.stringify(out, null, 2) + "\n");
console.log(`control-image vectors: ${positives.length} positives, ${negatives.length} negatives`);
