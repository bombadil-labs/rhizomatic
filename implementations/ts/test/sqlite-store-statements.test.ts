// Every SQL text the SQLite store hands the engine is in its one list (slice 4 plan §5), so the
// plan rail reads every statement the store runs. The rail watches `better-sqlite3` from the test
// side, while the shared store vectors run and while the store opens, reads its connection rules
// and closes. Transaction control and the connection pragmas are listed here by name.

import Database from "better-sqlite3";
import { makeDelta } from "../src/delta/set.js";
import { afterAll, describe, expect, it } from "vitest";
import { SQLITE_SCHEMA, SQLITE_STATEMENTS } from "../src/storage/sqlite-statements.js";
import { runStoreConformance } from "../src/storage/store-conformance.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

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
  "PRAGMA busy_timeout = 5000",
  "PRAGMA busy_timeout",
  ...RULES.map((rule) => `PRAGMA ${rule}`),
]);

type Method = (this: Database.Database, text: string, ...rest: unknown[]) => unknown;

describe("the statement list", () => {
  it("holds every SQL text the store prepares or runs", async () => {
    const proto = Database.prototype as unknown as Record<"prepare" | "exec" | "pragma", Method>;
    const originals = { prepare: proto.prepare, exec: proto.exec, pragma: proto.pragma };
    const seen = new Set<string>();
    for (const [name, original] of Object.entries(originals) as [keyof typeof originals, Method][])
      proto[name] = function (this: Database.Database, text, ...rest) {
        seen.add(name === "pragma" ? `PRAGMA ${text}` : text);
        return original.call(this, text, ...rest);
      };
    try {
      const report = await runStoreConformance(() => fixture.open());
      expect(report.skipped).toEqual([]);
      const store = await fixture.open();
      store.openAdmin().connection();
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
    // The watch saw the store at work, not nothing.
    for (const text of [
      SQLITE_SCHEMA,
      SQLITE_STATEMENTS.scope,
      ...(["linux", "darwin"].includes(process.platform)
        ? [SQLITE_STATEMENTS.vacuum, SQLITE_STATEMENTS.surfaceDebtSettle]
        : []),
      SQLITE_STATEMENTS.checkpoint,
      "BEGIN IMMEDIATE",
      "PRAGMA synchronous",
    ])
      expect(seen.has(text), text).toBe(true);
  });
});
