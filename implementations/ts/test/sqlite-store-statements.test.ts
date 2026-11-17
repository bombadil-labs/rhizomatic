// Every SQL text the SQLite store hands the engine is in its one list (slice 4 plan §5), so the
// plan rail reads every statement the store runs. The rail watches `better-sqlite3` from the test
// side, while the shared store vectors run and while the store opens, reads its connection rules
// and closes. Transaction control and the connection pragmas are listed here by name.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { makeDelta } from "../src/delta/set.js";
import { afterAll, describe, expect, it } from "vitest";
import { SQLITE_SCHEMA, SQLITE_STATEMENTS } from "../src/storage/sqlite-statements.js";
import { runStoreConformance } from "../src/storage/store-conformance.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = sqliteFixture("rhizomatic-sqlite-statements");
afterAll(() => fixture.cleanup());

const RULES = ["foreign_keys", "secure_delete", "journal_mode", "synchronous", "temp_store"];
const ALLOWED = new Set<string>([
  ...Object.values(SQLITE_STATEMENTS),
  SQLITE_SCHEMA,
  "BEGIN",
  "BEGIN IMMEDIATE",
  "COMMIT",
  "ROLLBACK",
  ...["foreign_keys = ON", "secure_delete = ON", "journal_mode = WAL", "synchronous = FULL"].map(
    (rule) => `PRAGMA ${rule}`,
  ),
  "PRAGMA temp_store = FILE",
  "PRAGMA busy_timeout",
  ...RULES.map((rule) => `PRAGMA ${rule}`),
]);

type Method = (this: Database.Database, text: string, ...rest: unknown[]) => unknown;

describe("the statement list", () => {
  it("holds every SQL text the store prepares or runs", async () => {
    const proto = Database.prototype as unknown as Record<"prepare" | "exec" | "pragma", Method>;
    const originals = { prepare: proto.prepare, exec: proto.exec, pragma: proto.pragma };
    const seen = new Set<string>();
    const waits = { open: new Set<string>(), later: new Set<string>() };
    let opening = false;
    for (const [name, original] of Object.entries(originals) as [keyof typeof originals, Method][])
      proto[name] = function (this: Database.Database, text, ...rest) {
        const source = name === "pragma" ? `PRAGMA ${text}` : text;
        if (/^PRAGMA busy_timeout = \d+$/.test(source))
          (opening ? waits.open : waits.later).add(source);
        else seen.add(source);
        return original.call(this, text, ...rest);
      };
    // The open runs without an await up to its last statement, so the flag covers exactly it.
    const open = (): ReturnType<typeof fixture.open> => {
      opening = true;
      try {
        return fixture.open();
      } finally {
        opening = false;
      }
    };
    try {
      const report = await runStoreConformance(open);
      expect(report.skipped).toEqual([]);
      const store = await open();
      store.openAdmin().connection();
      expect((await store.openAdmin().fsck()).faults).toEqual([]);
      // A peer of posture proven runs the rebuild on a store of class proven.
      if (store.profile.capabilities.erasure === "proven") {
        const peer = await store.createPeer("peer:p", { erasure: "proven" });
        const delta = makeDelta({
          timestamp: 1,
          validFrom: 0,
          author: "a",
          pointers: [{ role: "about", target: { kind: "entity", entity: { id: "e" } } }],
        });
        const arrival = { id: delta.id, at: 1, sequence: 1, transfer: 1, sender: "s" };
        await peer.append({
          expectedHead: null,
          nextHead: "h",
          frame: null,
          added: [{ delta, arrival }],
        });
        expect((await peer.purge([delta.id])).claim).toBe("proven");
      }
      await store.close();
    } finally {
      Object.assign(proto, originals);
    }
    expect([...seen].filter((text) => !ALLOWED.has(text))).toEqual([]);
    // The open sets the wait to the time left before each statement, so its value varies. No
    // statement after the open sets the wait.
    expect(waits.open.size).toBeGreaterThan(0);
    expect([...waits.later]).toEqual([]);
    // The watch saw the store at work, not nothing.
    for (const text of [
      SQLITE_SCHEMA,
      SQLITE_STATEMENTS.scope,
      ...(process.platform === "linux"
        ? [
            SQLITE_STATEMENTS.vacuum,
            SQLITE_STATEMENTS.residueDirty,
            SQLITE_STATEMENTS.residueClean,
            SQLITE_STATEMENTS.surfaceDebtAdd,
          ]
        : []),
      SQLITE_STATEMENTS.checkpoint,
      SQLITE_STATEMENTS.residueRead,
      SQLITE_STATEMENTS.fsckHoldings,
      SQLITE_STATEMENTS.fsckForeignKeys,
      "BEGIN IMMEDIATE",
      "PRAGMA synchronous",
    ])
      expect(seen.has(text), text).toBe(true);
    // It runs the whole store conformance: 1 to 3 s alone, and 24 s once under a loaded full run.
  }, 120_000);
});

describe("the statements a snapshot runs", () => {
  // A snapshot answers after appends because each of its statements keeps the holdings with a
  // sequence of at most the snapshot's last sequence (§4.13 readings 130 and 131). A statement
  // over a per-peer table with no sequence cannot do that, so a snapshot call that runs one must
  // be strict: it refuses snapshot-moved when the peer's max_seq is not the snapshot's bound.
  // The digest's two statements are strict (§4.13 reading 140): `digest` has no sequence, and
  // the leaf read below a row answers the holdings now. store-digest.test.ts holds the refusal,
  // and the last rail here shows that the snapshot runs them only after that comparison.
  const BOUND = "holding.seq <= @bound";
  const STRICT: readonly string[] = ["digestHeld", "digestRows"];
  const source = readFileSync(resolve(here, "../src/storage/sqlite-store.ts"), "utf8");
  const body = source.slice(source.indexOf("  #snapshot("), source.indexOf("  #changes("));
  const used = [...new Set([...body.matchAll(/this\.#s\.(\w+)/g)].map((m) => m[1]!))].sort();

  it("are the five reads and the digest's two, each found in the snapshot's own code", () => {
    expect(body.length).toBeGreaterThan(0);
    expect(used).toEqual([
      "arrivals",
      "digestHeld",
      "digestRows",
      "get",
      "negators",
      "scope",
      "targets",
    ]);
  });

  it("each keeps the holdings at or below the bound, in every branch of the scope walk, or is strict", () => {
    const statements = SQLITE_STATEMENTS as Record<string, string>;
    for (const name of used) {
      if (STRICT.includes(name)) continue;
      const text = statements[name]!;
      const branches = name === "scope" ? 2 : 1;
      expect(text.split(BOUND).length - 1, name).toBe(branches);
    }
  });

  it("a strict statement runs only in a method that the snapshot calls in its digest call, after the call compares max_seq with the bound", () => {
    // The method of the class that holds each use of a strict statement.
    const methodAt = (at: number): string =>
      [...source.slice(0, at).matchAll(/^ {2}(#?\w+)\(/gm)].at(-1)![1]!;
    const helpers = new Set(
      STRICT.flatMap((name) =>
        [...source.matchAll(new RegExp(`this\\.#s\\.${name}\\b`, "g"))].map((m) =>
          methodAt(m.index),
        ),
      ),
    );
    expect([...helpers].sort()).toEqual(["#digestRows", "#held"]);
    // `#digestAt` calls both. The snapshot's own code calls it once, after the comparison.
    const start = source.indexOf("  #snapshot(");
    const snapshot = source.slice(start, source.indexOf("\n  }\n", start));
    const call = /this\.(#held|#digestRows|#digestAt)\(/g;
    const calls = [...snapshot.matchAll(call)].map((m) => [m[1], m.index]);
    const check = snapshot.indexOf("if (now.maxSeq !== bound)");
    const strict = snapshot.slice(check, snapshot.indexOf('"snapshot-moved"', check));
    expect(calls.map(([name]) => name)).toEqual(["#digestAt"]);
    expect(check).toBeGreaterThan(snapshot.indexOf("digest: async (prefix)"));
    expect(check).toBeLessThan(calls[0]![1] as number);
    expect(strict).toMatch(/^if \(now\.maxSeq !== bound\)\s+throw new StoreError\(\s*$/);
  });
});

describe("the index rows", () => {
  // An index row leaves only with its holding, by the cascade from `holding` (§4.13 reading 138).
  // So a holding whose claims name an entry that is missing is damage, which `fsck` reports, and
  // never the store's own work. No statement deletes or updates a `target` or `reference` row,
  // and an insert into either never updates or replaces a row.
  const texts = [SQLITE_SCHEMA, ...Object.values(SQLITE_STATEMENTS)];

  it("no statement deletes or updates a target or reference row directly", () => {
    const touching = texts.filter((sql) =>
      /\b(DELETE\s+FROM|UPDATE(\s+OR\s+\w+)?)\s+(target|reference)\b/i.test(sql),
    );
    expect(touching).toEqual([]);
  });

  it("an insert into target or reference does nothing on a conflict", () => {
    const inserts = texts.filter((sql) =>
      /INSERT\s+(OR\s+\w+\s+)?INTO\s+(target|reference)\b/i.test(sql),
    );
    expect(inserts.length).toBe(2);
    for (const sql of inserts) {
      expect(sql).toMatch(/ON CONFLICT \([^)]*\) DO NOTHING/);
      expect(sql).not.toMatch(/INSERT\s+OR|DO UPDATE/i);
    }
  });
});
