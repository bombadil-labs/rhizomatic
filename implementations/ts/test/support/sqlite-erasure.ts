// Marked deltas and a scan of every file in a directory, for the erasure rails of the SQLite store
// (slice 4 plan §7). A marked delta carries a distinct marker in each place the schema copies
// erasable material: a primitive value, an entity id, a referenced id, the author, the sender of
// its arrival record and its signature. A scan reads every file of the directory whole and names
// each marker it finds, in which file.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDelta } from "../../src/delta/set.js";
import type { Delta } from "../../src/delta/types.js";
import type { PeerStore, VerifiedDelta } from "../../src/storage/store.js";

export type Marked = {
  readonly delta: Delta;
  readonly sender: string;
  /** Every marker of the delta, by the place it marks. */
  readonly markers: Readonly<Record<MarkerPlace, string>>;
};
export type MarkerPlace = "value" | "entity" | "reference" | "author" | "sender" | "signature";

const hex = (text: string): string => Buffer.from(text, "latin1").toString("hex");
const pad = (n: number): string => ".".repeat(((n * 40503) >>> 0) % 700);

/** A delta of group `tag`, number `n`, with a distinct marker in every erasable place. */
export function marked(tag: string, n: number): Marked {
  // A scrambled prefix puts each key at a random place in its index, as real keys are: inserts
  // then split pages in the middle, which is what leaves copies of cells behind.
  const scramble = ((n * 2654435761) >>> 0).toString(36).padStart(7, "0");
  const at = (place: string): string => `${place}${scramble}${tag}${String(n).padStart(6, "0")}Z`;
  const sig = hex(at("Sg")).padEnd(128, "0");
  const markers = {
    value: at("MkVal"),
    entity: at("MkEnt"),
    reference: at("MkRef"),
    author: at("MkAut"),
    sender: at("MkSnd"),
    signature: sig.slice(0, 2 * at("Sg").length),
  };
  const delta = makeDelta(
    {
      timestamp: n,
      validFrom: 0,
      author: markers.author,
      pointers: [
        { role: "about", target: { kind: "entity", entity: { id: markers.entity } } },
        // A length that varies from delta to delta, as real values do.
        { role: "says", target: { kind: "primitive", value: `${markers.value}${pad(n)}` } },
        { role: "cites", target: { kind: "delta", deltaRef: { delta: markers.reference } } },
      ],
    },
    sig,
  );
  return { delta, sender: markers.sender, markers };
}

// One count of arrivals for the whole process, so that every append passes a peer's last one.
let sequence = 0;

/** An append for the peer, from the head it has now, that numbers arrivals itself. */
export async function writerOf(peer: PeerStore) {
  const now = await peer.read();
  let head = now.head;
  now.release();
  return async (deltas: readonly Marked[]): Promise<void> => {
    const next = `head-${sequence + 1}`;
    const added = deltas.map(
      ({ delta, sender }): VerifiedDelta => ({
        delta,
        arrival: { id: delta.id, at: 1, sequence: ++sequence, transfer: 1, sender },
      }),
    );
    const result = await peer.append({ expectedHead: head, nextHead: next, frame: null, added });
    if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
    head = next;
  };
}

/** Every file of the directory, read whole, with every given marker it holds. */
export function scan(dir: string, markers: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    for (const marker of markers)
      if (bytes.includes(Buffer.from(marker, "latin1"))) found.push(`${name}: ${marker}`);
  }
  return found;
}

/** The markers of the deltas, every place. */
export const markersOf = (deltas: readonly Marked[]): string[] =>
  deltas.flatMap((d) => Object.values(d.markers));

/** A new directory under the system temp directory, and its removal. */
export function space(prefix: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
