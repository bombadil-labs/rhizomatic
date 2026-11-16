// The child of the erasure rails (sqlite-store-erasure.test.ts). It opens the store at the path it
// is given and purges ids for one peer. A mode stops it at one point of the purge, from the test
// side: it wraps the statements of `better-sqlite3` in this process only, and the store has no
// hook for it.
//
// - `kill-after-delete-commit`: SIGKILL just after the purge's own transaction commits, before
//   any other statement.
// - `kill-at-raise`: SIGKILL just before the rebuild raises the generation, after the delete
//   committed.
// - `kill-at-vacuum`: SIGKILL after the generation is raised, just before `VACUUM`.
// - `kill-at-settle`: SIGKILL after the rebuild and the truncate, just before the debts are
//   marked settled.
// - `hold-after-checkpoint`: after the rebuild's truncate, print `checkpointed` and wait until the
//   file `<path>.go` exists; then mark the debts and end.
// - `hold-at-vacuum`: after the generation is raised and before `VACUUM`, print `vacuum` and
//   wait until the file `<path>.go` exists.
// - `hold-after-report`: print the report and wait to be killed.
// - `plain`: print the report and end.
//
// A child that waits ends itself after a minute.

import { existsSync, writeSync } from "node:fs";
import Database from "better-sqlite3";
import { SQLITE_STATEMENTS } from "../../src/storage/sqlite-statements.js";
import { openSqliteStore } from "../../src/storage/sqlite-store.js";

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  for (;;) sleep(1000);
};

// A child that is never released or killed ends itself after a minute, so a failed rail leaves no
// process behind.
const deadline = Date.now() + 60_000;
const wait = (): void => {
  if (Date.now() > deadline) process.exit(3);
  sleep(10);
};

type Method = (this: Database.Statement, ...args: unknown[]) => unknown;

async function main(path: string, peerId: string, mode: string, ids: string[]): Promise<void> {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<
    "run" | "get",
    Method
  >;
  probe.close();
  const { run, get } = statement;
  const killAt: Record<string, string> = {
    "kill-at-raise": SQLITE_STATEMENTS.generationRaise,
    "kill-at-vacuum": SQLITE_STATEMENTS.vacuum,
    "kill-at-settle": SQLITE_STATEMENTS.surfaceDebtSettle,
  };
  const at = killAt[mode];
  let dropped = false;
  statement.run = function (...args) {
    if (this.source === at) die();
    if (mode === "hold-at-vacuum" && this.source === SQLITE_STATEMENTS.vacuum) {
      writeSync(1, "vacuum\n");
      while (!existsSync(`${path}.go`)) wait();
    }
    const result = run.apply(this, args);
    if (this.source === SQLITE_STATEMENTS.holdingDrop) dropped = true;
    if (mode === "kill-after-delete-commit" && dropped && this.source === "COMMIT") die();
    return result;
  };
  let held = false;
  statement.get = function (...args) {
    const result = get.apply(this, args);
    if (mode === "hold-after-checkpoint" && !held && this.source === SQLITE_STATEMENTS.checkpoint) {
      held = true;
      writeSync(1, "checkpointed\n");
      while (!existsSync(`${path}.go`)) wait();
    }
    return result;
  };
  const store = await openSqliteStore(path, { busyTimeoutMs: 100 });
  const peer = await store.peer(peerId);
  const report = await peer.purge(ids);
  writeSync(1, `${JSON.stringify(report)}\n`);
  if (mode === "hold-after-report") for (;;) wait();
  await store.close();
}

await main(
  process.argv[2]!,
  process.argv[3]!,
  process.argv[4]!,
  JSON.parse(process.argv[5]!) as string[],
);
