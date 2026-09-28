// Internal closed holding inventory. No arrival testimony or serving authority is assigned here.
import { bstr, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { contentAddress } from "../delta/hash.js";
import { manifestMemberIds } from "../delta/manifest.js";
import { DeltaSet } from "../delta/set.js";
import { verifyDelta } from "../delta/sign.js";
import type { Delta } from "../delta/types.js";
import { packSet, unpackSet } from "../storage/pack.js";
import {
  encodeRefusalSnapshot,
  refusalSnapshotDigest,
  type RefusalSnapshot,
} from "./refusal-snapshot.js";

const VERSION = 1;

export interface ImportedHoldings {
  readonly holdings: readonly Delta[];
  readonly covers: readonly Delta[];
}

function validSignature(delta: Delta): boolean {
  try {
    return verifyDelta(delta) === "verified";
  } catch {
    return false;
  }
}

function checkedSet(rows: readonly Delta[], label: string): DeltaSet {
  const set = new DeltaSet();
  for (const row of rows) {
    if (!set.add(row)) throw new Error(`imported holdings: duplicate ${label} id`);
  }
  return set;
}

function validated(
  snapshot: RefusalSnapshot,
  imported: ImportedHoldings,
): { holdings: DeltaSet; covers: DeltaSet } {
  encodeRefusalSnapshot(snapshot);
  const refused = new Set(snapshot.current.map((row) => row.targetId));
  const holdings = checkedSet(imported.holdings, "holding");
  const covers = checkedSet(imported.covers, "cover");
  for (const row of covers) {
    if (!validSignature(row) || manifestMemberIds(row).length === 0)
      throw new Error("imported holdings: invalid signed cover");
  }
  for (const row of holdings) {
    if (refused.has(row.id)) throw new Error("imported holdings: current refusal is admitted");
    if (row.sig !== undefined) {
      if (!validSignature(row)) throw new Error("imported holdings: invalid holding signature");
    } else if (
      ![...covers].some(
        (cover) =>
          cover.claims.author === row.claims.author && manifestMemberIds(cover).includes(row.id),
      )
    ) {
      throw new Error("imported holdings: unsigned holding has no verified cover");
    }
  }
  return { holdings, covers };
}

/** Canonical, closed inventory; the old peer's handoff record must bind its digest. */
export function encodeImportedHoldings(
  snapshot: RefusalSnapshot,
  imported: ImportedHoldings,
): Uint8Array {
  const { holdings, covers } = validated(snapshot, imported);
  return encode(
    map([
      ["version", float(VERSION)],
      ["snapshotDigest", tstr(refusalSnapshotDigest(snapshot))],
      ["holdings", bstr(packSet(holdings))],
      ["covers", bstr(packSet(covers))],
    ]),
  );
}

function fields(value: CborValue): Map<string, CborValue> {
  if (value.t !== "map" || value.v.length !== 4)
    throw new Error("imported holdings: invalid fields");
  const result = new Map(value.v);
  if (result.size !== 4) throw new Error("imported holdings: duplicate field");
  return result;
}

function bytes(value: CborValue | undefined): Uint8Array {
  if (value?.t !== "bstr") throw new Error("imported holdings: expected bytes");
  return value.v;
}

export function decodeImportedHoldings(
  image: Uint8Array,
  snapshot: RefusalSnapshot,
): ImportedHoldings {
  const top = fields(decode(image));
  if (top.get("version")?.t !== "float" || top.get("version")?.v !== VERSION)
    throw new Error("imported holdings: unsupported version");
  const digest = top.get("snapshotDigest");
  if (digest?.t !== "tstr" || digest.v !== refusalSnapshotDigest(snapshot))
    throw new Error("imported holdings: wrong refusal snapshot");
  const imported: ImportedHoldings = {
    holdings: [...unpackSet(bytes(top.get("holdings")))],
    covers: [...unpackSet(bytes(top.get("covers")))],
  };
  if (!Buffer.from(encodeImportedHoldings(snapshot, imported)).equals(Buffer.from(image)))
    throw new Error("imported holdings: noncanonical image");
  return imported;
}

export function importedHoldingsDigest(
  snapshot: RefusalSnapshot,
  imported: ImportedHoldings,
): string {
  return contentAddress(encodeImportedHoldings(snapshot, imported));
}
