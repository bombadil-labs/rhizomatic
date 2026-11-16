// Marked deltas and a scan of every file in a directory, for the erasure rails of the SQLite store
// (slice 4 plan §7). A marked delta carries a distinct marker in each place the schema copies
// erasable material: a primitive value, an entity id, a referenced id, the author, the sender of
// its arrival record and its signature. A scan reads every file of the directory whole and names
// each marker it finds, in which file.
//
// A scan runs in a process of its own that holds no connection. On Linux the close of any
// descriptor of a file drops every POSIX lock the process holds on that file, so a scan in a
// process that holds the store would let go of the store's locks.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

/**
 * An append for the peer, from the head it has now, that numbers arrivals itself. A process that
 * appends to a store another process filled passes `after`, a sequence above every one there.
 */
export async function writerOf(peer: PeerStore, after = 0) {
  sequence = Math.max(sequence, after);
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

// The scan, as a plain script. It reads `{dir, markers}` as JSON and prints the names it found.
const SCAN = `
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const scan = ({ dir, markers }) => {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    for (const marker of markers)
      if (bytes.includes(Buffer.from(marker, "latin1"))) found.push(name + ": " + marker);
  }
  return found;
};
if (process.argv[1] === "serve")
  require("node:readline")
    .createInterface({ input: process.stdin })
    .on("line", (line) => process.stdout.write(JSON.stringify(scan(JSON.parse(line))) + "\\n"));
else process.stdout.write(JSON.stringify(scan(JSON.parse(readFileSync(0, "utf8")))));
`;

/** Every file of the directory, read whole by another process, with every given marker it holds. */
export function scan(dir: string, markers: readonly string[]): string[] {
  const out = execFileSync(process.execPath, ["-e", SCAN], {
    input: JSON.stringify({ dir, markers }),
    maxBuffer: 1 << 28,
  });
  return JSON.parse(out.toString()) as string[];
}

/** A process that scans on request, for a check that scans many times. */
export function scanner() {
  const proc = spawn(process.execPath, ["-e", SCAN, "serve"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffered = "";
  const waiting: ((found: string[]) => void)[] = [];
  proc.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      waiting.shift()!(JSON.parse(line) as string[]);
    }
  });
  return {
    scan: (dir: string, markers: readonly string[]) =>
      new Promise<string[]>((done) => {
        waiting.push(done);
        proc.stdin.write(`${JSON.stringify({ dir, markers })}\n`);
      }),
    end: () => proc.kill("SIGKILL"),
  };
}

/** The markers of the deltas, every place. */
export const markersOf = (deltas: readonly Marked[]): string[] =>
  deltas.flatMap((d) => Object.values(d.markers));

/**
 * The markers of every appearance that is dead in the file now, read by another connection: the
 * sender and signature of an appearance no holding keeps, and the payload of a delta no row keeps.
 */
export function deadMarkers(path: string, appearances: readonly Marked[]): string[] {
  const db = new Database(path, { readonly: true });
  try {
    const senders = new Set(
      (db.prepare("SELECT arrival FROM holding").all() as { arrival: string }[]).map(
        (r) => (JSON.parse(r.arrival) as { sender: string }).sender,
      ),
    );
    const deltas = new Set(
      (db.prepare("SELECT id FROM delta").all() as { id: string }[]).map((r) => r.id),
    );
    return [
      ...new Set(
        appearances.flatMap((a) => [
          ...(senders.has(a.sender) ? [] : [a.markers.sender, a.markers.signature]),
          ...(deltas.has(a.delta.id)
            ? []
            : [a.markers.value, a.markers.entity, a.markers.reference, a.markers.author]),
        ]),
      ),
    ];
  } finally {
    db.close();
  }
}

/** The same delta as `of`, as another holding carries it: its own sender and signature. */
export const appearance = (tag: string, n: number, of: Marked): Marked => {
  const own = marked(tag, n);
  return {
    delta: { ...of.delta, sig: own.delta.sig! },
    sender: own.sender,
    markers: { ...of.markers, sender: own.sender, signature: own.markers.signature },
  };
};

/**
 * A batch that a process appends and that never commits (finding 1 of the fourth review): an
 * appearance under `tag` of each delta of `of`, then `fill` marked deltas whose value is 20,000
 * bytes long. A batch of 1,200 such deltas (24 MB) is larger than the page cache of
 * `better-sqlite3` (16 MB), so the engine writes pages of it to the log before the commit.
 */
export type BatchSpec = {
  readonly tag: string;
  readonly of: readonly (readonly [tag: string, n: number])[];
  readonly fill: number;
};
export const batchOf = (spec: BatchSpec): Marked[] => [
  ...spec.of.map(([tag, n], i) => appearance(spec.tag, i, marked(tag, n))),
  ...Array.from({ length: spec.fill }, (_, i) => {
    const m = marked(`${spec.tag}F`, i);
    const value = `${m.markers.value}${"~".repeat(20_000)}`;
    const pointers = m.delta.claims.pointers.map((p) =>
      p.role === "says" ? { role: "says", target: { kind: "primitive" as const, value } } : p,
    );
    return { ...m, delta: makeDelta({ ...m.delta.claims, pointers }, m.delta.sig!) };
  }),
];

/** A new directory under the system temp directory, and its removal. */
export function space(prefix: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
