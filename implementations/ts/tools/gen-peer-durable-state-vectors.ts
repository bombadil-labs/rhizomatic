/** Generate pinned bytes for the private permanent-posture image. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaims } from "../src/delta/json-profile.js";
import { DeltaSet } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { planArrivals, type ArrivalRecord } from "../src/federation/arrival.js";
import {
  encodeDurablePeerState,
  type DurablePeerState,
  type PurgeObligation,
} from "../src/federation/durable-state.js";
import type { PeerState } from "../src/federation/peer-state.js";

const vectors = fileURLToPath(new URL("../../../vectors/", import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(resolve(vectors, name), "utf8")) as never;
interface BaseCase {
  peerId: string;
  admitted: string[];
  cursor: { lastSequence: number; lastTransfer: number };
  arrivals: Array<Omit<ArrivalRecord, "id"> & { id: string }>;
  refused: string[];
}
interface Row {
  name: string;
  baseCase: number;
  extraAdmitted: string[];
  extraRefused?: string[];
  extraArrivalAt?: number;
  extraSender?: string;
  refusalCounter: number;
  obligationCounter: number;
  quotaUsed: number;
  events: Array<{ sequence: number; target: string; orders: string[]; priorEpoch?: number }>;
  exclusions: Array<{ order: string; target: string; event: number; priorEpoch?: number }>;
  obligations: Array<{
    sequence: number;
    target: string;
    generation: number;
    event: number;
    priorEpoch?: number;
    status: PurgeObligation["status"];
    fault?: string;
  }>;
  expectedHex: string;
}
const baseCases = (read("peer/state.json") as { cases: BaseCase[] }).cases;
const fixture = read("principal/evidence.json") as {
  deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }>;
};
const named = new Map<string, Delta>(
  fixture.deltas.map((row) => [
    row.name,
    { id: row.id, claims: parseClaims(row.claims), ...(row.sig ? { sig: row.sig } : {}) },
  ]),
);
const id = (name: string) => named.get(name)!.id;
const file = resolve(vectors, "peer/durable-state.json");
const vector = read("peer/durable-state.json") as { cases: Row[] };
for (const c of vector.cases) {
  const source = baseCases[c.baseCase]!;
  let base: PeerState = {
    peerId: source.peerId,
    admitted: DeltaSet.from(source.admitted.map((name) => named.get(name)!)),
    cursor: source.cursor,
    arrivals: source.arrivals.map((row) => ({ ...row, id: id(row.id) })),
    refusedIds: new Set(source.refused.map(id)),
  };
  if (c.extraAdmitted.length) {
    const extras = c.extraAdmitted.map((name) => named.get(name)!);
    const planned = planArrivals(
      base.cursor,
      new Set(base.admitted.ids()),
      extras.map((delta) => delta.id),
      c.extraArrivalAt!,
      c.extraSender!,
    );
    base = {
      ...base,
      admitted: DeltaSet.from([...base.admitted, ...extras]),
      cursor: { lastSequence: planned.lastSequence, lastTransfer: planned.lastTransfer },
      arrivals: [...base.arrivals, ...planned.arrivals],
    };
  }
  if (c.extraRefused?.length)
    base = { ...base, refusedIds: new Set([...base.refusedIds, ...c.extraRefused.map(id)]) };
  const state: DurablePeerState = {
    base,
    refusalCounter: c.refusalCounter,
    obligationCounter: c.obligationCounter,
    quotaUsed: c.quotaUsed,
    events: c.events.map((row) => ({
      sequence: row.sequence,
      targetId: id(row.target),
      orderIds: row.orders.map(id).sort(),
      ...(row.priorEpoch === undefined ? {} : { priorEpoch: row.priorEpoch }),
    })),
    exclusions: c.exclusions.map((row) => ({
      orderId: id(row.order),
      targetId: id(row.target),
      eventSequence: row.event,
      ...(row.priorEpoch === undefined ? {} : { priorEpoch: row.priorEpoch }),
    })),
    obligations: c.obligations.map((row) => ({
      sequence: row.sequence,
      targetId: id(row.target),
      generation: row.generation,
      eventSequence: row.event,
      status: row.status,
      ...(row.priorEpoch === undefined ? {} : { priorEpoch: row.priorEpoch }),
      ...(row.fault === undefined ? {} : { fault: row.fault }),
    })),
  };
  c.expectedHex = Buffer.from(encodeDurablePeerState(state)).toString("hex");
}
writeFileSync(file, JSON.stringify(vector, null, 2) + "\n");
