// A seeded model check of erasure on the SQLite store (slice 4 plan §7), with two real processes.
// A child process serves purges (test/support/sqlite-erasure-child.ts, mode `serve`) and holds in
// a window of each one: before the rebuild reads the count, before `VACUUM`, before the
// checkpoint, or before the last transaction. In the window this process appends, purges, or
// takes or lets go of a reader that keeps the log busy, or runs a write that does not commit:
// another connection with a small page cache writes a delta and a holding, whose pages reach the
// log, and rolls back. Peers of mixed posture act on a few ids; every appended holding has its
// own sender and signature.
//
// The child holds again just after the last commit of its purge. A process that holds no
// connection then scans every file of the store's directory (support `scanner`), and this
// process checks one rule against the report that follows:
//
//   a file surface `absent`, or the claim `proven`, means no marker of a dead appearance is in any
//   file; `removed` means no row of the delta is in the file.
//
// A purge in this process is checked the same way just after it returns. Every store lives in its
// own `mkdtempSync` directory, which the check removes.

import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, expect, it } from "vitest";
import { openSqliteStore, type SqliteStore } from "../src/storage/sqlite-store.js";
import type { PeerStore, PurgeReport } from "../src/storage/store.js";
import {
  appearance,
  deadMarkers,
  marked,
  scanner,
  space,
  writerOf,
  type Marked,
} from "./support/sqlite-erasure.js";

const here = dirname(fileURLToPath(import.meta.url));
const childScript = resolve(here, "support/sqlite-erasure-child.ts");

/** Two seeds: each runs in about 85 s on Linux, so the pair stays under three minutes. */
const SEEDS = [20261116, 4_041_977];
const SEQUENCES = 450;
const WINDOWS = ["read", "vacuum", "checkpoint", "last", "none"] as const;
const POINTS = ["read", "vacuum", "checkpoint", "last", "after-last"];

const spaces: (() => void)[] = [];
afterAll(() => {
  for (const remove of spaces) remove();
});

/** A small seeded generator (mulberry32). */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  return {
    chance: (p: number) => next() < p,
    below: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

/** The child, serving purges; one line at a time from its output. */
function server() {
  const proc = spawn(process.execPath, ["--import", "tsx", childScript, "-", "-", "serve", "[]"], {
    cwd: resolve(here, ".."),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "";
  proc.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter === undefined) lines.push(line);
    else waiter(line);
  });
  return {
    send: (asked: object) => proc.stdin.write(`${JSON.stringify(asked)}\n`),
    line: () =>
      new Promise<string>((done, fail) => {
        const line = lines.shift();
        if (line !== undefined) return done(line);
        const timer = setTimeout(() => fail(new Error(`the child is silent: ${errors}`)), 30_000);
        waiting.push((text) => {
          clearTimeout(timer);
          done(text);
        });
      }),
    end: () => {
      proc.stdin.end();
      if (proc.exitCode === null) proc.kill("SIGKILL");
    },
  };
}

it.each(SEEDS)(
  "seeded model check, seed %i: a report that says absent, proven or removed is true at its last commit, with another process acting in each window",
  async (SEED) => {
    const random = generator(SEED);
    const child = server();
    const scans = scanner();
    const tally = {
      sequences: 0,
      purges: 0,
      windows: 0,
      checks: 0,
      absent: 0,
      proven: 0,
      refused: 0,
      unfinished: 0,
      inLog: 0,
    };
    const violations: string[] = [];
    try {
      for (let sequence = 0; sequence < SEQUENCES; sequence++) {
        tally.sequences++;
        const { dir, remove } = space("rhizomatic-sqlite-model");
        spaces.push(remove);
        const path = join(dir, "store.db");
        const store: SqliteStore = await openSqliteStore(path, { busyTimeoutMs: 100 });
        const names = Array.from({ length: 2 + random.below(2) }, (_, i) => `peer:${i}`);
        const peers = new Map<string, PeerStore>();
        for (const name of names)
          peers.set(
            name,
            await store.createPeer(name, { erasure: random.chance(0.6) ? "proven" : "unproven" }),
          );
        const writers = new Map(
          await Promise.all(names.map(async (n) => [n, await writerOf(peers.get(n)!)] as const)),
        );
        const bases = Array.from({ length: 1 + random.below(3) }, (_, i) =>
          marked(`Q${sequence}x`, i),
        );
        const appearances: Marked[] = [];
        let readerDb: Database.Database | undefined;
        const someIds = () => bases.filter(() => random.chance(0.6)).map((b) => b.delta.id);

        const check = (report: PurgeReport, found: string[], live: Set<string>, how: string) => {
          tally.checks++;
          const absent = report.surfaces.some((s) => s.state === "absent");
          if (absent) tally.absent++;
          if (report.claim === "proven") tally.proven++;
          if ((absent || report.claim === "proven") && found.length > 0)
            violations.push(`${sequence} ${how}: ${report.claim} with ${found.join(", ")}`);
          for (const t of report.targets)
            if (t.outcome === "removed" && live.has(t.id))
              violations.push(`${sequence} ${how}: removed ${t.id} while its row is in the file`);
        };
        const look = async () => {
          const dead = deadMarkers(path, appearances);
          const db = new Database(path, { readonly: true });
          const live = new Set(
            (db.prepare("SELECT id FROM delta").all() as { id: string }[]).map((r) => r.id),
          );
          db.close();
          return { found: await scans.scan(dir, dead), live };
        };
        const act = async () => {
          const roll = random.below(11);
          if (roll < 4) {
            const name = random.pick(names);
            const base = random.pick(bases);
            const now = await peers.get(name)!.read();
            const holds = (await now.get([base.delta.id])).length > 0;
            now.release();
            if (holds) return;
            const shown = appearance(`Q${sequence}a`, appearances.length, base);
            appearances.push(shown);
            await writers.get(name)!([shown]);
          } else if (roll < 8) {
            const report = await peers.get(random.pick(names))!.purge(someIds());
            tally.purges++;
            const { found, live } = await look();
            check(report, found, live, "local");
          } else if (roll < 9) {
            tally.unfinished++;
            const shown = marked(`Q${sequence}d`, appearances.length);
            appearances.push(shown);
            const bulk = "~".repeat(20_000);
            const db = new Database(path);
            db.pragma("cache_size = 2");
            db.exec("BEGIN IMMEDIATE");
            db.prepare("INSERT INTO delta (id, claims, author, timestamp) VALUES (?, ?, ?, 0)").run(
              shown.delta.id,
              Buffer.from(`${Object.values(shown.markers).join(" ")}${bulk}`),
              shown.markers.author,
            );
            db.prepare(
              "INSERT INTO holding (peer, delta, seq, arrival, sig, author) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
              random.pick(names),
              shown.delta.id,
              1_000_000 + appearances.length,
              JSON.stringify({ sender: shown.sender, bulk }),
              shown.delta.sig!,
              shown.markers.author,
            );
            db.exec("ROLLBACK");
            db.close();
            // The rolled-back pages are in the log: the action is not void.
            if ((await scans.scan(dir, [shown.markers.sender])).length > 0) tally.inLog++;
          } else if (readerDb === undefined) {
            readerDb = new Database(path);
            readerDb.exec("BEGIN");
            readerDb.prepare("SELECT count(*) FROM meta").get();
          } else {
            readerDb.exec("COMMIT");
            readerDb.close();
            readerDb = undefined;
          }
        };

        for (let step = 0, steps = 5 + random.below(10); step < steps; step++) {
          if (!random.chance(0.5)) {
            await act();
            continue;
          }
          const window = random.pick(WINDOWS);
          for (const point of POINTS) rmSync(`${path}.go-${point}`, { force: true });
          child.send({
            path,
            peer: random.pick(names),
            ids: someIds(),
            mode: `${window === "none" ? "" : `hold-${window},`}hold-after-last`,
          });
          tally.purges++;
          let seen: { found: string[]; live: Set<string> } | undefined;
          for (;;) {
            const line = await child.line();
            if (line === `held ${window}`) {
              tally.windows++;
              for (let n = random.below(3); n > 0; n--) await act();
              writeFileSync(`${path}.go-${window}`, "");
            } else if (line === "held after-last") {
              seen = await look();
              writeFileSync(`${path}.go-after-last`, "");
            } else if (line.startsWith("report ")) {
              check(
                JSON.parse(line.slice("report ".length)) as PurgeReport,
                seen!.found,
                seen!.live,
                `child at ${window}`,
              );
              break;
            } else if (line.startsWith("refused ")) {
              tally.refused++;
              break;
            } else throw new Error(`the child said ${line}`);
          }
        }
        if (readerDb !== undefined) {
          readerDb.exec("COMMIT");
          readerDb.close();
        }
        await store.close();
        remove();
      }
    } finally {
      child.end();
      scans.end();
    }
    console.log(`model check, seed ${SEED}: ${JSON.stringify(tally)}`);
    expect(violations).toEqual([]);
    expect(tally.absent).toBeGreaterThan(0);
    expect(tally.windows).toBeGreaterThan(0);
    expect(tally.inLog).toBe(tally.unfinished);
  },
  300_000,
);
