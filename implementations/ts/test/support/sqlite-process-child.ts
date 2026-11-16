// A child of the many-process rails (sqlite-store-processes.test.ts). It runs one job on the store
// at a path, given as JSON in its first argument, and prints its answer as one line
// `<word> <json>`. A job can wait for a go file before it starts (`go`), so that several
// children start together.
//
// A job can also hold at one point, from the test side: the child wraps the statements of
// `better-sqlite3` in this process only, and the store has no hook for it. A hold prints
// `held <point>` and waits until the file `<path>.go-<point>` exists. The points:
//
// - `identity`: just after open reads the identity it recorded, under the write lock.
// - `lock`: just before open asks for the write lock of its identity check (its second
//   `BEGIN IMMEDIATE`), outside any transaction. After the go file the child prints
//   `locking lock`, and its next statement is that `BEGIN IMMEDIATE`.
// - `checked`: just after a snapshot's call reads the peer's revision, inside its read
//   transaction, before the data statement.
// - `locked`: just after an append reads the peer row, under the write lock.
//
// A hold that waits for a minute ends the child, so a failed rail leaves no process behind.
//
// The jobs:
//
// - `write`: appends `batches` batches of `size` new deltas to the peer. Each batch reads the
//   head and revision, appends from that head, and reads again on `conflict`. With `turn`, the
//   child appends only at a revision r with r mod `turn.of` = `turn.mine`, so two children
//   take turns in a fixed order. Prints `done {committed, conflicts}`.
// - `follow`: follows the peer's feed from revision 0 until revision `until`, with the
//   contract's `followFeed`. A pull that throws `snapshot-moved` is asked again. Prints
//   `followed {revisions, added, delivered, pulls, moved}`.
// - `open`: opens the store (with `restored` when asked) and prints `histories {peer: history}`.
// - `read`: takes a snapshot, then gets `ids` on it, holding at `checked`. Prints
//   `got {revision, ids}` or `refused <code>`.
// - `append`: appends one batch of `size` new deltas whose arrivals start after `after`,
//   holding at `locked`. Prints `appended <status>` or `refused <code>`.
// - `create`: creates the peer with the host mint `mint`. Prints `created <history>` or
//   `refused <code>`.

import { existsSync, writeSync } from "node:fs";
import Database from "better-sqlite3";
import { makeDelta } from "../../src/delta/set.js";
import type { Delta } from "../../src/delta/types.js";
import { followFeed } from "../../src/storage/follow.js";
import { SQLITE_STATEMENTS } from "../../src/storage/sqlite-statements.js";
import { openSqliteStore } from "../../src/storage/sqlite-store.js";
import { StoreError, type VerifiedDelta } from "../../src/storage/store.js";

type Job = {
  op: "write" | "follow" | "open" | "read" | "append" | "create";
  path: string;
  peer?: string;
  go?: string;
  hold?: string;
  tag?: string;
  batches?: number;
  size?: number;
  turn?: { of: number; mine: number };
  until?: number;
  restored?: boolean;
  ids?: string[];
  after?: number;
  mint?: string;
};

const job = JSON.parse(process.argv[2]!) as Job;
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const print = (word: string, value: unknown): void => {
  writeSync(1, `${word} ${typeof value === "string" ? value : JSON.stringify(value)}\n`);
};
const waitFor = (file: string): void => {
  const deadline = Date.now() + 60_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) process.exit(3);
    sleep(2);
  }
};

let armed = false;
function at(point: string): void {
  if (!armed || job.hold !== point) return;
  armed = false;
  print("held", point);
  waitFor(`${job.path}.go-${point}`);
}

type Method = (this: Database.Statement, ...args: unknown[]) => unknown;
const probe = new Database(":memory:");
const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<"get" | "run", Method>;
probe.close();
const { get, run } = statement;
let writeLocks = 0;
statement.run = function (...args) {
  if (this.source === "BEGIN IMMEDIATE" && armed && job.hold === "lock" && ++writeLocks === 2) {
    at("lock");
    print("locking", "lock");
  }
  return run.apply(this, args);
};
statement.get = function (...args) {
  const result = get.apply(this, args);
  if (this.source === SQLITE_STATEMENTS.metaGet && args[0] === "identity") at("identity");
  if (this.source === SQLITE_STATEMENTS.peerRead) {
    at("checked");
    at("locked");
  }
  return result;
};

const AUTHOR = `ed25519:${"0c".repeat(32)}`;
const fact = (entity: string): Delta =>
  makeDelta({
    timestamp: 1,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "about", target: { kind: "entity", entity: { id: entity } } }],
  });
const member = (delta: Delta, sequence: number): VerifiedDelta => ({
  delta,
  arrival: { id: delta.id, at: 1, sequence, transfer: 1, sender: "child" },
});
const refused = (error: unknown): string => {
  if (error instanceof StoreError) return error.code;
  throw error;
};

if (job.go !== undefined) waitFor(job.go);
armed = job.hold === "identity" || job.hold === "lock";
const store = await openSqliteStore(job.path, {
  ...(job.restored === true ? { restored: true } : {}),
  ...(job.mint === undefined ? {} : { mintHistory: () => job.mint! }),
});
armed = false;
try {
  switch (job.op) {
    case "open": {
      const histories: Record<string, string> = {};
      for await (const id of store.openAdmin().peers())
        histories[id] = (await store.peer(id)).history;
      print("histories", histories);
      break;
    }
    case "create":
      try {
        const peer = await store.createPeer(job.peer!, { erasure: "unproven" });
        print("created", peer.history);
      } catch (error) {
        print("refused", refused(error));
      }
      break;
    case "write": {
      // Every batch has `size` deltas, so at revision r no arrival passes r × size: a batch
      // appended from revision r numbers its arrivals from r × size + 1.
      const peer = await store.peer(job.peer!);
      const size = job.size!;
      const committed: { revision: number; added: string[] }[] = [];
      let conflicts = 0;
      for (let batch = 0; batch < job.batches!; ) {
        const now = await peer.read();
        const { revision, head } = now;
        now.release();
        if (job.turn !== undefined && revision % job.turn.of !== job.turn.mine) {
          sleep(1);
          continue;
        }
        const added = Array.from({ length: size }, (_, i) =>
          member(fact(`${job.tag}-${batch}-${i}`), revision * size + i + 1),
        );
        const result = await peer.append({
          expectedHead: head,
          nextHead: `${job.tag}-${batch}`,
          frame: null,
          added,
        });
        if (result.status === "conflict") {
          conflicts++;
          continue;
        }
        if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
        committed.push({ revision: result.revision, added: [...result.added] });
        batch++;
      }
      print("done", { committed, conflicts });
      break;
    }
    case "follow": {
      const peer = await store.peer(job.peer!);
      const first = await peer.read();
      const cursor = followFeed(peer, { history: first.history, revision: 0 });
      first.release();
      const revisions: number[] = [];
      const added: string[][] = [];
      let delivered = 0;
      let pulls = 0;
      let moved = 0;
      while (cursor.position.revision < job.until!) {
        // Under steady writes a pull can meet snapshot-moved on each of its tries and throw
        // (plan §11). A pull that fails does not move the cursor, so the follower pulls again.
        let pull;
        try {
          pull = await cursor.pull();
        } catch (error) {
          if (!(error instanceof StoreError && error.code === "snapshot-moved")) throw error;
          moved++;
          continue;
        }
        pulls++;
        if (pull.status !== "ok") {
          print("resync", pull.current);
          process.exit(4);
        }
        for (const record of pull.records) {
          revisions.push(record.revision);
          added.push([...record.added]);
        }
        delivered += pull.deltas.length;
        if (pull.records.length === 0) sleep(1);
      }
      print("followed", { revisions, added, delivered, pulls, moved });
      break;
    }
    case "read": {
      const snapshot = await (await store.peer(job.peer!)).read();
      armed = true;
      try {
        const got = await snapshot.get(job.ids!);
        print("got", { revision: snapshot.revision, ids: got.map((d) => d.id) });
      } catch (error) {
        print("refused", refused(error));
      }
      break;
    }
    case "append": {
      const peer = await store.peer(job.peer!);
      const now = await peer.read();
      const head = now.head;
      now.release();
      const added = Array.from({ length: job.size! }, (_, i) =>
        member(fact(`${job.tag}-${i}`), job.after! + i + 1),
      );
      armed = true;
      try {
        const result = await peer.append({
          expectedHead: head,
          nextHead: `${job.tag}-head`,
          frame: null,
          added,
        });
        print("appended", result.status);
      } catch (error) {
        print("refused", refused(error));
      }
      break;
    }
  }
} finally {
  await store.close();
}
