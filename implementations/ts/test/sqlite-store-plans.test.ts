// The query-plan rail of the SQLite store (slice 4 plan §5), parts 1 and 2. Part 1: the full plan
// of every statement the store prepares equals the plan committed in sqlite-store-plans.json, so
// a changed plan fails until a person reads it. Part 2: no plan scans a base table, builds an
// automatic index, or searches `holding`, `target`, `reference` or `digest` by the peer alone. A plan does
// not show what a foreign-key action costs; the timing rail (part 3) covers that. `VACUUM` has an
// empty plan and reads every page by definition: it is the rebuild of plan §7, whose cost is
// O(store) per purge of a peer that asks for proof.
//
// The body of each trigger is planned too, under the name `trigger <name>`: the engine runs it
// inside the delete that fires it, and no prepared statement shows its plan.
//
// To accept a changed plan after reading it, run this file with RHIZOMATIC_WRITE_PLANS=1, then
// format the JSON file with Prettier.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { SQLITE_SCHEMA, SQLITE_STATEMENTS } from "../src/storage/sqlite-statements.js";
import { openSqliteStore } from "../src/storage/sqlite-store.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const committedPath = resolve(here, "sqlite-store-plans.json");

const fixture = sqliteFixture("rhizomatic-sqlite-plans");
afterAll(() => fixture.cleanup());

/** Statements that may read without an index, each with its reason. */
const EXEMPT: Readonly<Record<string, string>> = {
  schemaNames:
    "open reads the catalog once to tell an empty file from a store; its size is the schema's, not the data's",
  fsckEngine:
    "fsck is O(store) by definition (an admin call of the Exporter, plan §5): the engine reads every page once, in one read transaction",
  fsckForeignKeys:
    "fsck is O(store) by definition: the engine checks every foreign key of every row once, in one read transaction",
  fsckCount:
    "fsck counts one peer's holdings to compare them with the peer's count, in the transaction that reads the count; it reads each holding once per scan",
};
const BASE_TABLES = [
  "sqlite_master",
  "meta",
  "history",
  "peer",
  "delta",
  "holding",
  "target",
  "reference",
  "change",
  "digest",
  "debt",
  "surface_debt",
  "residue",
];
/**
 * The body of every trigger of the schema that reads a table, by name. A body that only raises an
 * error reads nothing, and the engine plans `RAISE` only inside a trigger.
 */
const TRIGGERS = Object.fromEntries(
  [...SQLITE_SCHEMA.matchAll(/CREATE TRIGGER (\w+)[^]*?BEGIN ([^]*?); END;/g)]
    .filter((m) => !m[2]!.startsWith("SELECT RAISE("))
    .map((m) => [`trigger ${m[1]!}`, m[2]!]),
);
const PER_PEER = ["holding", "target", "reference", "digest"];

/** The plan of one statement, as lines indented by depth. */
function planOf(db: Database.Database, sql: string): string[] {
  const statement = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  const names = [...new Set([...sql.matchAll(/@(\w+)/g)].map((m) => m[1]!))];
  const rows = (
    names.length > 0
      ? statement.all(Object.fromEntries(names.map((name) => [name, null])))
      : statement.all(...Array<null>(sql.split("?").length - 1).fill(null))
  ) as { id: number; parent: number; detail: string }[];
  const depth = new Map<number, number>([[0, 0]]);
  return rows.map(({ id, parent, detail }) => {
    const level = (depth.get(parent) ?? 0) + 1;
    depth.set(id, level);
    return `${"  ".repeat(level - 1)}${detail}`;
  });
}

/** Every rule a plan line breaks. */
function broken(line: string): string[] {
  const found: string[] = [];
  const text = line.trim();
  const scan = /^SCAN (\S+)/.exec(text);
  if (scan !== null && BASE_TABLES.includes(scan[1]!)) found.push(`scans ${scan[1]}`);
  if (text.includes("AUTOMATIC")) found.push("builds an automatic index");
  const search = /^SEARCH (\S+) .*\((.*)\)$/.exec(text);
  if (search !== null && PER_PEER.includes(search[1]!) && search[2] === "peer=?")
    found.push(`searches ${search[1]} by the peer alone`);
  return found;
}

describe("the query-plan rail", () => {
  let plans: Record<string, string[]> = {};

  it("reads the plan of every statement", async () => {
    const store = fixture.path();
    await (await openSqliteStore(store)).close();
    const db = new Database(store, { readonly: true });
    plans = Object.fromEntries(
      Object.entries({ ...SQLITE_STATEMENTS, ...TRIGGERS }).map(([name, sql]) => [
        name,
        planOf(db, sql),
      ]),
    );
    expect(Object.keys(TRIGGERS)).toEqual(
      ["holding", "delta", "target", "reference"].flatMap((table) =>
        ["delete", "update"].map((event) => `trigger ${table}_${event}_residue`),
      ),
    );
    db.close();
    if (process.env["RHIZOMATIC_WRITE_PLANS"] === "1")
      writeFileSync(committedPath, `${JSON.stringify(plans, null, 2)}\n`);
  });

  it("part 1: every plan is the committed plan", () => {
    const committed = JSON.parse(readFileSync(committedPath, "utf8")) as Record<string, string[]>;
    expect(plans).toEqual(committed);
  });

  it("part 2: no plan scans a base table, builds an automatic index, or searches per peer by the peer alone", () => {
    const found = Object.entries(plans).flatMap(([name, lines]) =>
      name in EXEMPT ? [] : lines.flatMap((line) => broken(line).map((rule) => `${name}: ${rule}`)),
    );
    expect(found).toEqual([]);
    for (const name of Object.keys(EXEMPT)) expect(Object.keys(plans)).toContain(name);
  });

  it("part 2 sees each rule broken", () => {
    expect(broken("SCAN holding")).toEqual(["scans holding"]);
    expect(broken("  SCAN delta USING INDEX x")).toEqual(["scans delta"]);
    expect(broken("SEARCH target USING AUTOMATIC COVERING INDEX (entity=?)")).toEqual([
      "builds an automatic index",
    ]);
    expect(broken("SEARCH reference USING PRIMARY KEY (peer=?)")).toEqual([
      "searches reference by the peer alone",
    ]);
    expect(broken("SCAN asked VIRTUAL TABLE INDEX 1:")).toEqual([]);
    expect(broken("SCAN member")).toEqual([]);
    expect(broken("SEARCH holding USING PRIMARY KEY (peer=? AND delta>?)")).toEqual([]);
  });
});
