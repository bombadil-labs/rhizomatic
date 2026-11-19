// A child of the peer delete rails (sqlite-store-peer-delete.test.ts). It runs one job on the
// store at a path, given as JSON in its first argument, and prints each answer as one whole line
// `<word> <json>`. A call refused `store-unavailable` with "ask again" (another process held a
// lock past the wait) is asked again, for up to a minute; any other refusal is printed as
// `refused <code> <message>`, and an error that is not a refusal ends the child with code 1.
// No job asks `deletePeer` again: a repeat is a new call, and it deletes the peer that has the id
// when it begins (§4.13 reading 144). A refused delete prints its refusal.
//
// The jobs:
//
// - `delete`: deletes the peer. Prints `report <DeleteReport>`. With `slowMs`, the child sleeps
//   that long after each commit of this process, from the test side: it wraps the statements of
//   `better-sqlite3` in this process only, and the store has no hook for it. A test that kills the
//   child then kills it between two of the delete's transactions. With `hold`, the child stops
//   after the delete's first commit, prints `held <pid>`, and waits for the file
//   `<path>.go-<pid>`. So a test can let other calls run between that transaction and the next.
// - `recreate`: deletes the peer, prints `report <DeleteReport>`, creates the peer again with the
//   posture `posture`, and prints `created <history>`. With `fill`, it then appends that many new
//   deltas to the new peer in one append.
// - `watch`: opens the peer and takes a snapshot of it, prints `ready 1`, and waits for the file
//   `<path>.go-watch`. Then it calls every call of the handle and of the snapshot, and prints
//   `codes {handle: [...], snapshot: [...]}`, each a refusal code or `answered`.
// - `append`: appends one new delta at a time to the peer, each from the head it reads, under a
//   head named with this process's id, until a call is refused, or until `count` commits. Prints
//   `appended 1` after its first commit, then `done {committed, ids, refused}`.
//
// Every job opens the store with `busyTimeoutMs` (default 200), then prints `open <pid>`.

import { existsSync, writeSync } from "node:fs";
import Database from "better-sqlite3";
import { makeDelta } from "../../src/delta/set.js";
import { openSqliteStore, type SqliteStore } from "../../src/storage/sqlite-store.js";
import { StoreError, type PeerStore } from "../../src/storage/store.js";

type Job = {
  op: "delete" | "watch" | "append" | "recreate";
  path: string;
  peer: string;
  after?: number;
  slowMs?: number;
  hold?: boolean;
  busyTimeoutMs?: number;
  posture?: "proven" | "unproven";
  fill?: number;
  count?: number;
};

const job = JSON.parse(process.argv[2]!) as Job;
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
// Set just before the delete begins: the open's own commits do not stop the child.
let armed = false;
/** Waits for `<path>.go-<pid>`, for up to a minute. */
const held = (): void => {
  print("held", process.pid);
  const deadline = Date.now() + 60_000;
  while (!existsSync(`${job.path}.go-${process.pid}`)) {
    if (Date.now() > deadline) process.exit(3);
    sleep(2);
  }
};
if (job.slowMs !== undefined || job.hold === true) {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as {
    run: (this: Database.Statement, ...args: unknown[]) => unknown;
  };
  probe.close();
  const run = statement.run;
  const slowMs = job.slowMs ?? 0;
  statement.run = function (...args) {
    const result = run.apply(this, args);
    if (this.source === "COMMIT") {
      if (armed) {
        armed = false;
        held();
      }
      sleep(slowMs);
    }
    return result;
  };
}
// A write to a full pipe can take part of the line, or none (EAGAIN), so it writes until all is out.
const print = (word: string, value: unknown): void => {
  const line = Buffer.from(`${word} ${JSON.stringify(value)}\n`);
  for (let at = 0; at < line.length; ) {
    try {
      at += writeSync(1, line, at);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EAGAIN") throw error;
      sleep(1);
    }
  }
};

/** The call, asked again while the store says to ask again. */
async function patient<T>(call: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      const again =
        error instanceof StoreError &&
        error.code === "store-unavailable" &&
        error.message.includes("ask again");
      if (!again || Date.now() > deadline) throw error;
      sleep(5);
    }
  }
}

/** A refusal's code, or `answered`. Any other error passes up. */
async function code(call: () => unknown): Promise<string> {
  try {
    await call();
    return "answered";
  } catch (error) {
    if (error instanceof StoreError) return error.code;
    throw error;
  }
}

async function watch(store: SqliteStore): Promise<void> {
  const peer = await patient(() => store.peer(job.peer));
  const snapshot = await patient(() => peer.read());
  print("ready", 1);
  const deadline = Date.now() + 60_000;
  while (!existsSync(`${job.path}.go-watch`)) {
    if (Date.now() > deadline) process.exit(3);
    sleep(2);
  }
  const id = `1e20${"0".repeat(64)}`;
  print("codes", {
    handle: [
      await code(() => peer.history),
      await code(() => peer.appFormat),
      await code(() => peer.read()),
      await code(() => peer.append({ expectedHead: null, nextHead: "h", frame: null, added: [] })),
      await code(() => peer.purge([id])),
      await code(() => peer.changes(0)),
    ],
    snapshot: [
      await code(() => snapshot.get([id])),
      await code(() => snapshot.arrivals([id])),
      await code(() => snapshot.targets(["e"])),
      await code(() => snapshot.negators([id])),
      await code(() => snapshot.scope({ anchors: [{ kind: "entity", entity: "e" }] })),
      await code(() => snapshot.digest("")),
    ],
  });
}

/** A new delta about an entity of its own, by an author named with this process's id. */
const fresh = (n: number) =>
  makeDelta({
    timestamp: n,
    validFrom: 0,
    author: `appender-${process.pid}`,
    pointers: [{ role: "about", target: { kind: "entity", entity: { id: `e${n}` } } }],
  });

async function append(peer: PeerStore): Promise<void> {
  const ids: string[] = [];
  let sequence = job.after ?? 0;
  while (ids.length < (job.count ?? Infinity)) {
    let refused: string;
    try {
      const now = await patient(() => peer.read());
      const head = now.head;
      now.release();
      const n = ++sequence;
      const delta = fresh(n);
      const result = await patient(() =>
        peer.append({
          expectedHead: head,
          nextHead: `head-${process.pid}-${n}`,
          frame: null,
          added: [
            {
              delta,
              arrival: { id: delta.id, at: 1, sequence: n, transfer: n, sender: "child" },
            },
          ],
        }),
      );
      if (result.status === "committed") {
        ids.push(delta.id);
        if (ids.length === 1) print("appended", 1);
      }
      continue;
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      refused = error.code;
    }
    print("done", { committed: ids.length, ids, refused });
    return;
  }
  print("done", { committed: ids.length, ids, refused: null });
}

const store = await patient(() =>
  openSqliteStore(job.path, { busyTimeoutMs: job.busyTimeoutMs ?? 200 }),
);
print("open", process.pid);
try {
  if (job.op === "delete") {
    armed = job.hold === true;
    print("report", await store.deletePeer(job.peer));
  } else if (job.op === "recreate") {
    print("report", await store.deletePeer(job.peer));
    const peer = await patient(() => store.createPeer(job.peer, { erasure: job.posture! }));
    print("created", peer.history);
    if (job.fill !== undefined) {
      const after = job.after ?? 0;
      const added = Array.from({ length: job.fill }, (_, i) => {
        const delta = fresh(after + i + 1);
        const n = after + i + 1;
        return {
          delta,
          arrival: { id: delta.id, at: 1, sequence: n, transfer: n, sender: "child" },
        };
      });
      const result = await patient(() =>
        peer.append({
          expectedHead: null,
          nextHead: `head-${process.pid}-fill`,
          frame: null,
          added,
        }),
      );
      print("filled", result.status);
    }
  } else if (job.op === "watch") await watch(store);
  else await append(await patient(() => store.peer(job.peer)));
} catch (error) {
  if (!(error instanceof StoreError)) throw error;
  print("refused", `${error.code} ${error.message}`);
} finally {
  await store.close();
}
