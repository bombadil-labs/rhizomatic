// The child of the crash rail (sqlite-store-crash.test.ts). It opens the store at the path it is
// given and appends batches of eight deltas until it is killed. Batch n points at entity
// `batch:n`, so the parent can tell a whole batch from a part of one.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDelta } from "../../src/delta/set.js";
import { openSqliteStore } from "../../src/storage/sqlite-store.js";
import { StoreError, type AppendResult, type PeerStore } from "../../src/storage/store.js";

export const BATCH = 8;
export const CRASH_PEER = "peer:crash";

export const batchDelta = (n: number, j: number) =>
  makeDelta({
    timestamp: n,
    validFrom: 0,
    author: `ed25519:${"0e".repeat(32)}`,
    pointers: [
      { role: "about", target: { kind: "entity", entity: { id: `batch:${n}` } } },
      { role: "j", target: { kind: "primitive", value: j } },
    ],
  });

/**
 * Appends until killed. With `full`, the file size is limited from outside: the child appends
 * until an append is not committed, prints that answer as one JSON line, and ends.
 */
async function main(path: string, full: boolean): Promise<void> {
  // Past the file size limit the system sends SIGXFSZ; with a listener, the write fails instead.
  if (full) process.on("SIGXFSZ", () => undefined);
  const store = await openSqliteStore(path, { changeRetention: "unbounded" });
  let peer: PeerStore;
  try {
    peer = await store.peer(CRASH_PEER);
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    peer = await store.createPeer(CRASH_PEER, { erasure: "unproven" });
  }
  process.stdout.write("ready\n");
  for (;;) {
    const snapshot = await peer.read();
    const n = snapshot.revision + 1;
    let result: AppendResult;
    try {
      result = await peer.append({
        expectedHead: snapshot.head,
        nextHead: `head-${n}`,
        frame: null,
        added: Array.from({ length: BATCH }, (_, j) => {
          const delta = batchDelta(n, j);
          const sequence = BATCH * (n - 1) + j + 1;
          return {
            delta,
            arrival: { id: delta.id, at: n, sequence, transfer: n, sender: "crash" },
          };
        }),
      });
    } catch (error) {
      if (!full) throw error;
      process.stdout.write(
        `${JSON.stringify({ refused: (error as StoreError).code, batch: n })}\n`,
      );
      process.exit(0);
    }
    if (result.status === "committed") continue;
    if (!full) throw new Error(`append answered ${result.status}`);
    process.stdout.write(`${JSON.stringify({ ...result, batch: n })}\n`);
    process.exit(0);
  }
}

// Run as a program, not when a rail imports the batch shape.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv[2]!, process.argv[3] === "full");
