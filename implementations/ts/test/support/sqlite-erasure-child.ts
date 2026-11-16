// The child of the erasure rails (sqlite-store-erasure.test.ts). It opens the store at the path it
// is given and purges ids for one peer. A mode stops it at points of the purge, from the test
// side: it wraps the statements of `better-sqlite3` in this process only, and the store has no
// hook for it.
//
// A mode is a list of steps, joined by commas. Each step is `hold-<point>` or `kill-<point>`. A
// hold prints `held <point>` and waits until the file `<path>.go-<point>` exists. A kill sends
// SIGKILL to the child. The points, in the order a purge passes them:
//
// - `delete-commit`: just after the first transaction of the purge commits.
// - `read`: before the rebuild reads the count of deletes (`residue.dirty`).
// - `read-done`: just after that read.
// - `vacuum`: before `VACUUM`.
// - `in-vacuum`: prints `held in-vacuum` and runs `VACUUM` at once; the test kills it then.
// - `checkpoint`: before the checkpoint.
// - `checkpoint-done`: just after the checkpoint.
// - `last`: before the last transaction begins.
// - `in-last`: inside the last transaction, after its first statement.
// - `after-last`: just after the last transaction commits, before the report is made.
// - `report`: after the report is printed (a hold only).
//
// The mode `serve` reads one purge per line from stdin, as JSON `{path, peer, ids, mode}`, and
// prints `report <json>` or `refused <code>` for each. The mode `plain` purges once and ends.
//
// A hold that waits for a minute ends the child, so a failed rail leaves no process behind.

import { createInterface } from "node:readline";
import { existsSync, writeSync } from "node:fs";
import Database from "better-sqlite3";
import { SQLITE_STATEMENTS } from "../../src/storage/sqlite-statements.js";
import { openSqliteStore, type SqliteStore } from "../../src/storage/sqlite-store.js";
import { StoreError } from "../../src/storage/store.js";

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

type Method = (this: Database.Statement, ...args: unknown[]) => unknown;

const [firstPath, peerId, startMode, idsText] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
let path = firstPath;

let steps = new Map<string, string>();
let begun = 0;
let committed = false;

function at(point: string): void {
  const step = steps.get(point);
  if (step === undefined) return;
  steps.delete(point);
  if (step === "kill") {
    process.kill(process.pid, "SIGKILL");
    for (;;) sleep(1000);
  }
  writeSync(1, `held ${point}\n`);
  if (point === "in-vacuum") return;
  const deadline = Date.now() + 60_000;
  while (!existsSync(`${path}.go-${point}`)) {
    if (Date.now() > deadline) process.exit(3);
    sleep(5);
  }
}

const probe = new Database(":memory:");
const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<"run" | "get", Method>;
probe.close();
const { run, get } = statement;
statement.run = function (...args) {
  const source = this.source;
  if (source === "BEGIN IMMEDIATE" && ++begun === 2) at("last");
  if (source === SQLITE_STATEMENTS.vacuum) {
    at("vacuum");
    at("in-vacuum");
  }
  const result = run.apply(this, args);
  if (source === "COMMIT" && begun === 1 && !committed) {
    committed = true;
    at("delete-commit");
  } else if (source === "COMMIT" && begun === 2) at("after-last");
  else if (begun === 2 && source !== "BEGIN IMMEDIATE") at("in-last");
  return result;
};
statement.get = function (...args) {
  const source = this.source;
  if (source === SQLITE_STATEMENTS.residueDirty) at("read");
  if (source === SQLITE_STATEMENTS.checkpoint && begun > 0) at("checkpoint");
  const result = get.apply(this, args);
  if (source === SQLITE_STATEMENTS.residueDirty) at("read-done");
  else if (source === SQLITE_STATEMENTS.checkpoint && begun > 0) at("checkpoint-done");
  else if (begun === 2) at("in-last");
  return result;
};

function arm(mode: string): void {
  steps = new Map(
    mode
      .split(",")
      .filter((step) => step !== "" && step !== "plain")
      .map((step) => {
        const [action, ...point] = step.split("-");
        return [point.join("-"), action!];
      }),
  );
  begun = 0;
  committed = false;
}

let store: SqliteStore | undefined;

async function purge(at: string, peer: string, ids: string[], mode: string): Promise<string> {
  if (store === undefined || at !== path) {
    await store?.close();
    path = at;
    store = await openSqliteStore(path, { busyTimeoutMs: 100 });
  }
  arm(mode);
  let line: string;
  try {
    line = `report ${JSON.stringify(await (await store.peer(peer)).purge(ids))}`;
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    line = `refused ${error.code}`;
  }
  begun = 0;
  return line;
}

if (startMode === "serve") {
  for await (const text of createInterface({ input: process.stdin })) {
    const asked = JSON.parse(text) as { path: string; peer: string; ids: string[]; mode: string };
    writeSync(1, `${await purge(asked.path, asked.peer, asked.ids, asked.mode)}\n`);
  }
} else {
  writeSync(1, `${await purge(path, peerId, JSON.parse(idsText) as string[], startMode)}\n`);
  at("report");
}
await store?.close();
