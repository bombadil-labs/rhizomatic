// The crash rail of the SQLite store (slice 4 plan §6 and §8 item 15). A child process appends
// batches in a loop, and the parent kills it with SIGKILL after a varied delay, 50 times. Each
// delay starts at the child's first acknowledged commit of that round, so every round kills the
// child while it appends, on a fast disk or a slow one. After each kill a reopen finds every
// batch whole or absent, every acknowledged commit present, and the count, the floor and the
// feed in agreement with the rows. The store has no hook for this: the kill lands wherever the
// child is.

import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openSqliteStore } from "../src/storage/sqlite-store.js";
import type { ChangeRecord } from "../src/storage/store.js";
import { BATCH, CRASH_PEER, batchDelta } from "./support/sqlite-crash-child.js";
import { audit, sqliteFixture } from "./support/sqlite-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const child = resolve(here, "support/sqlite-crash-child.ts");

const fixture = sqliteFixture("rhizomatic-sqlite-crash");
afterAll(() => fixture.cleanup());

const KILLS = 50;

/**
 * Starts the child, waits for its first acknowledged commit, kills it `delay` ms later, and waits
 * for its end. Answers the last revision the child printed as committed.
 */
async function killDuringAppends(path: string, delay: number): Promise<number> {
  const proc = spawn(process.execPath, ["--import", "tsx", child, path], {
    cwd: pkg,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let errors = "";
  proc.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  const ended = new Promise<NodeJS.Signals | number | null>((done) =>
    proc.on("exit", (code, signal) => done(signal ?? code)),
  );
  await new Promise<void>((committed, fail) => {
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("committed ")) committed();
    });
    void ended.then(() => fail(new Error(`the child ended before its first commit: ${errors}`)));
  });
  await new Promise((wait) => setTimeout(wait, delay));
  proc.kill("SIGKILL");
  const end = await ended;
  if (end !== "SIGKILL") throw new Error(`the child ended with ${String(end)}: ${errors}`);
  return Math.max(...[...out.matchAll(/^committed (\d+)\n/gm)].map((m) => Number(m[1])));
}

/** Reopens the store and checks that every batch is whole or absent, with the feed and count. */
async function whole(path: string): Promise<number> {
  audit(path);
  const store = await openSqliteStore(path);
  const peer = await store.peer(CRASH_PEER);
  const snapshot = await peer.read();
  const r = snapshot.revision;
  // Every batch up to r is whole, and the next one left nothing.
  const entities = Array.from({ length: r + 1 }, (_, n) => `batch:${n + 1}`);
  const held = await snapshot.targets(entities);
  const expected = entities
    .slice(0, r)
    .flatMap((_, n) => Array.from({ length: BATCH }, (_, j) => batchDelta(n + 1, j).id));
  expect(new Set(held)).toEqual(new Set(expected));
  expect([snapshot.count, held.length]).toEqual([BATCH * r, BATCH * r]);
  expect(snapshot.head).toBe(r === 0 ? null : `head-${r}`);
  // The feed names exactly the batches, one record each.
  const records: ChangeRecord[] = [];
  for (let from = 0; from < r; ) {
    const page = await peer.changes(from);
    if (page.status !== "ok") throw new Error(page.status);
    records.push(...page.records);
    from = page.through;
  }
  expect(records.map((record) => record.revision)).toEqual(
    Array.from({ length: r }, (_, n) => n + 1),
  );
  expect(new Set(records.flatMap((record) => record.added))).toEqual(new Set(expected));
  await store.close();
  return r;
}

describe("a crash during an append", () => {
  it(`leaves every batch whole or absent and keeps every acknowledged commit, ${KILLS} kills at varied delays after a commit`, async () => {
    const path = fixture.path();
    const revisions: number[] = [];
    for (let kill = 0; kill < KILLS; kill++) {
      const acknowledged = await killDuringAppends(path, (kill * 7) % 41);
      const r = await whole(path);
      expect(r, `kill ${kill}: the store lost an acknowledged commit`).toBeGreaterThanOrEqual(
        acknowledged,
      );
      expect(r, `kill ${kill}: the round committed nothing`).toBeGreaterThan(revisions.at(-1) ?? 0);
      revisions.push(r);
    }
    console.log(`crash rail: revisions after each kill: ${revisions.join(" ")}`);
  }, 600_000);
});

describe("a commit that fails", () => {
  // A file size limit, set by the shell, makes the engine's writes fail. The child appends until
  // one append is not committed. `ulimit -f` counts blocks of 512 bytes in a POSIX shell.
  it.skipIf(process.platform === "win32")(
    "answers uncertain, and a reopen without the limit finds every batch whole or absent [gap: Linux and macOS only; Windows has no file size limit in its shell]",
    async () => {
      const path = fixture.path();
      const run = spawnSync(
        "sh",
        [
          "-c",
          'ulimit -f 2048 && exec "$0" --import tsx "$1" "$2" full',
          process.execPath,
          child,
          path,
        ],
        { cwd: pkg, encoding: "utf8", timeout: 300_000 },
      );
      const last = run.stdout.trim().split("\n").at(-1)!;
      expect([run.status, JSON.parse(last) as unknown], run.stderr).toEqual([
        0,
        {
          status: "uncertain",
          fault: expect.stringContaining("SQLITE_IOERR"),
          batch: expect.any(Number),
        },
      ]);
      const r = await whole(path);
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThan((JSON.parse(last) as { batch: number }).batch);
    },
    600_000,
  );
});
