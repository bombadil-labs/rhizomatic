// A child of the many-process rails (sqlite-store-processes.test.ts). It runs one job on the store
// at a path, given as JSON in its first argument, and prints its answer as one line
// `<word> <json>`. A job can wait for a go file before it starts (`go`), so that several
// children start together; it prints `waiting go` first. The go file holds a time in ms since
// the epoch, and the child waits until that time, so that several children start within a
// millisecond. A missing or empty go file is "not yet".
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
// The open, and each read, append and pull of `write` and `follow`, are asked again when the
// store refuses `store-unavailable` and says "ask again" (reading 105): another process held a
// lock past `busyTimeoutMs`, which a slow disk can make happen. The first such refusal prints
// `busy <what>`. A call still refused after a minute ends the child with the count and the time.
//
// The jobs:
//
// - `write`: appends `batches` batches of `size` new deltas to the peer. Each batch reads the
//   head and revision, appends from that head, and reads again on `conflict`. With `turn`, the
//   child appends only at a revision r with r mod `turn.of` = `turn.mine`, so two children
//   take turns in a fixed order. Prints `done {committed, conflicts, asked}`, where `asked` counts
//   the calls asked again.
// - `follow`: follows the peer's feed from revision 0 until revision `until`, with the
//   contract's `followFeed`. A pull that throws `snapshot-moved` is asked again. Prints
//   `followed {revisions, added, delivered, pulls, moved}`.
// - `open`: opens the store (with `restored` when asked) and prints `histories {peer: history}`,
//   then `formats {peer: appFormat}`, then `refused-after [ms]`: the time each refused try of the
//   open took.
// - `read`: takes a snapshot, then gets `ids` on it, holding at `checked`. Prints
//   `got {revision, ids}` or `refused <code>`.
// - `append`: appends one batch of `size` new deltas whose arrivals start after `after`,
//   holding at `locked`. Prints `appended <status>` or `refused <code>`.
// - `create`: creates the peer with the host mint `mint`, and with `appFormat` when given.
//   Prints `created <history>` or `refused <code>`.
// - `pairs`: appends one batch of two new deltas, one about each of the two entities in `ids`,
//   again and again, sleeping `pause` ms after each, until the file `<path>.stop` exists. It
//   prints `started 1` after its first commit and `done {batches}` at its end.

import { existsSync, readFileSync, writeSync } from "node:fs";
import Database from "better-sqlite3";
import { makeDelta } from "../../src/delta/set.js";
import type { Delta } from "../../src/delta/types.js";
import { followFeed } from "../../src/storage/follow.js";
import { SQLITE_STATEMENTS } from "../../src/storage/sqlite-statements.js";
import { openSqliteStore } from "../../src/storage/sqlite-store.js";
import { StoreError, type VerifiedDelta } from "../../src/storage/store.js";

type Job = {
  op: "write" | "follow" | "open" | "read" | "append" | "create" | "pairs";
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
  busyTimeoutMs?: number;
  pause?: number;
  appFormat?: string;
};

const job = JSON.parse(process.argv[2]!) as Job;
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
// A write to a full pipe can take part of the line, or none (EAGAIN), so it writes until all is out.
const print = (word: string, value: unknown): void => {
  const line = Buffer.from(
    `${word} ${typeof value === "string" ? value : JSON.stringify(value)}\n`,
  );
  for (let at = 0; at < line.length; ) {
    try {
      at += writeSync(1, line, at);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EAGAIN") throw error;
      sleep(1);
    }
  }
};
const waitFor = (file: string): void => {
  const deadline = Date.now() + 60_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) process.exit(3);
    sleep(2);
  }
};

/** The start time in a go file; a missing or empty file, or one with no number, is "not yet". */
const startTime = (file: string): number => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (text !== "" && Number.isFinite(Number(text))) return Number(text);
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
  arrival: { id: delta.id, at: 1, sequence, transfer: sequence, sender: "child" },
});
const refused = (error: unknown): string => {
  if (error instanceof StoreError) return error.code;
  throw error;
};

const ASK_AGAIN_MS = 60_000;
let asked = 0;
const refusedAfter: number[] = [];
async function again<T>(what: string, call: () => Promise<T>): Promise<T> {
  const started = Date.now();
  for (let tries = 1; ; tries++) {
    const tried = performance.now();
    try {
      return await call();
    } catch (error) {
      if (
        !(error instanceof StoreError && error.code === "store-unavailable") ||
        !error.message.endsWith("ask again")
      )
        throw error;
      refusedAfter.push(performance.now() - tried);
      const spent = Date.now() - started;
      if (spent > ASK_AGAIN_MS)
        throw new Error(
          `${what} refused store-unavailable ${tries} times in ${spent} ms, past the bound of ${ASK_AGAIN_MS} ms: ${error.message}`,
        );
      if (asked++ === 0) print("busy", what);
    }
  }
}

if (job.go !== undefined) {
  print("waiting", "go");
  const at = startTime(job.go);
  while (Date.now() < at);
}
armed = job.hold === "identity" || job.hold === "lock";
const store = await again("open", () =>
  openSqliteStore(job.path, {
    ...(job.restored === true ? { restored: true } : {}),
    ...(job.mint === undefined ? {} : { mintHistory: () => job.mint! }),
    ...(job.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: job.busyTimeoutMs }),
  }),
);
armed = false;
try {
  switch (job.op) {
    case "open": {
      const histories: Record<string, string> = {};
      const formats: Record<string, string | null> = {};
      for await (const id of store.openAdmin().peers()) {
        const peer = await store.peer(id);
        histories[id] = peer.history;
        formats[id] = peer.appFormat;
      }
      print("histories", histories);
      print("formats", formats);
      print("refused-after", refusedAfter);
      break;
    }
    case "create":
      try {
        const peer = await store.createPeer(job.peer!, {
          erasure: "unproven",
          ...(job.appFormat === undefined ? {} : { appFormat: job.appFormat }),
        });
        print("created", peer.history);
      } catch (error) {
        print("refused", refused(error));
      }
      break;
    case "write": {
      // Every batch has `size` deltas, so at revision r no arrival passes r × size: a batch
      // appended from revision r numbers its arrivals from r × size + 1.
      const peer = await again("peer", () => store.peer(job.peer!));
      const size = job.size!;
      const committed: { revision: number; added: string[] }[] = [];
      let conflicts = 0;
      for (let batch = 0; batch < job.batches!; ) {
        const now = await again("read", () => peer.read());
        const { revision, head } = now;
        now.release();
        if (job.turn !== undefined && revision % job.turn.of !== job.turn.mine) {
          sleep(1);
          continue;
        }
        const added = Array.from({ length: size }, (_, i) =>
          member(fact(`${job.tag}-${batch}-${i}`), revision * size + i + 1),
        );
        const result = await again("append", () =>
          peer.append({ expectedHead: head, nextHead: `${job.tag}-${batch}`, frame: null, added }),
        );
        if (result.status === "conflict") {
          conflicts++;
          continue;
        }
        if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
        committed.push({ revision: result.revision, added: [...result.added] });
        batch++;
      }
      print("done", { committed, conflicts, asked });
      break;
    }
    case "follow": {
      const peer = await again("peer", () => store.peer(job.peer!));
      const first = await again("read", () => peer.read());
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
          pull = await again("pull", () => cursor.pull());
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
    case "pairs": {
      const peer = await again("peer", () => store.peer(job.peer!));
      const stop = `${job.path}.stop`;
      const deadline = Date.now() + 300_000;
      let batches = 0;
      while (!existsSync(stop) && Date.now() < deadline) {
        const now = await again("read", () => peer.read());
        const { revision, head } = now;
        now.release();
        const added = job.ids!.map((entity, i) =>
          member(
            makeDelta({
              timestamp: batches + 1,
              validFrom: 0,
              author: AUTHOR,
              pointers: [{ role: "about", target: { kind: "entity", entity: { id: entity } } }],
            }),
            revision * job.ids!.length + i + 1,
          ),
        );
        const result = await again("append", () =>
          peer.append({
            expectedHead: head,
            nextHead: `${job.tag}-${batches}`,
            frame: null,
            added,
          }),
        );
        if (result.status === "conflict") continue;
        if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
        if (++batches === 1) print("started", 1);
        if (job.pause! > 0) sleep(job.pause!);
      }
      print("done", { batches });
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
