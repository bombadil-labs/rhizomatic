// The crash rail of the SQLite store (slice 4 plan §6 and §8 item 15). A child process appends
// batches in a loop, and the parent kills it with SIGKILL after a varied delay, 50 times. After
// each kill a reopen finds every batch whole or absent, and the count, the floor and the feed
// agree with the rows. The store has no hook for this: the kill lands wherever the child is.

import { spawn } from "node:child_process";
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

/** Starts the child, waits until it appends, kills it after `delay` ms, and waits for its end. */
async function killDuringAppends(path: string, delay: number): Promise<void> {
  const proc = spawn(process.execPath, ["--import", "tsx", child, path], {
    cwd: pkg,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  proc.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  const ended = new Promise<NodeJS.Signals | number | null>((done) =>
    proc.on("exit", (code, signal) => done(signal ?? code)),
  );
  await new Promise<void>((ready, fail) => {
    proc.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) ready();
    });
    void ended.then(() => fail(new Error(`the child ended before it was ready: ${errors}`)));
  });
  await new Promise((wait) => setTimeout(wait, delay));
  proc.kill("SIGKILL");
  const end = await ended;
  if (end !== "SIGKILL") throw new Error(`the child ended with ${String(end)}: ${errors}`);
}

describe("a crash during an append", () => {
  it(`leaves every batch whole or absent, ${KILLS} kills at varied delays`, async () => {
    const path = fixture.path();
    const revisions: number[] = [];
    for (let kill = 0; kill < KILLS; kill++) {
      await killDuringAppends(path, (kill * 7) % 41);
      audit(path);
      const store = await openSqliteStore(path);
      const peer = await store.peer(CRASH_PEER);
      const snapshot = await peer.read();
      const r = snapshot.revision;
      revisions.push(r);
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
    }
    console.log(`crash rail: revisions after each kill: ${revisions.join(" ")}`);
    // The kills landed while the child appended, not before its first append.
    expect(revisions.at(-1)!).toBeGreaterThan(KILLS);
  }, 600_000);
});
