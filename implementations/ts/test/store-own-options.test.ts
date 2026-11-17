// A store, a read and a held view read a caller's options and requests as own fields only, and a
// refused `openStore` changes nothing in the file (SPEC-18 proposal §4.13 reading 126). Each
// polluting rail sets one field on `Object.prototype`, makes its calls, removes the field in
// `finally`, and only then asserts. Every store file lives in this file's own `mkdtempSync`
// directory.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { makeDelta, parseTerm } from "../src/index.js";
import type { Delta } from "../src/delta/types.js";
import {
  OrdinaryJournalPeer,
  type DurableOrdinaryJournalStore,
  type OrdinaryJournalHead,
  type OrdinaryJournalRead,
} from "../src/federation/ordinary-journal-peer.js";
import type { PeerImageWrite } from "../src/federation/single-peer.js";
import { readAnchored } from "../src/reactor/store-read.js";
import { StoreViews } from "../src/reactor/store-views.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { openStore } from "../src/storage/open-store.js";
import { SQLITE_STORE_FORMAT, openSqliteStore } from "../src/storage/sqlite-store.js";
import { StoreError, type PeerStore } from "../src/storage/store.js";
import { space } from "./support/sqlite-erasure.js";

const { dir, remove } = space("rhizomatic-own-options");
afterAll(remove);
let files = 0;
const newPath = (): string => join(dir, `store-${++files}.db`);
const urlOf = (path: string): string => pathToFileURL(path).href.replace(/^file:/, "sqlite:");

/** Runs `body` while `Object.prototype[key]` is `value`, and removes the field afterwards. */
async function polluted<T>(key: string, value: unknown, body: () => Promise<T>): Promise<T> {
  const proto = Object.prototype as Record<string, unknown>;
  proto[key] = value;
  try {
    return await body();
  } finally {
    delete proto[key];
  }
}

/** The answer of a call: its value, or the code of its `StoreError`. */
const outcome = async <T>(call: () => Promise<T>): Promise<T | string> => {
  try {
    return await call();
  } catch (error) {
    if (error instanceof StoreError) return error.code;
    if (error instanceof Error) return error.message;
    throw error;
  }
};

async function sqliteWithPeer(): Promise<{ path: string; history: string }> {
  const path = newPath();
  const store = await openSqliteStore(path);
  const { history } = await store.createPeer("peer:a", { erasure: "unproven" });
  await store.close();
  return { path, history };
}

async function historyAt(
  open: () => Promise<{ peer(id: string): Promise<PeerStore>; close(): Promise<void> }>,
) {
  const store = await open();
  try {
    return (await store.peer("peer:a")).history;
  } finally {
    await store.close();
  }
}

describe("options set only on Object.prototype read as absent", () => {
  it("restored: openSqliteStore(path), openStore(url) and openStore(url, {}) give no peer a new history", async () => {
    const { path, history } = await sqliteWithPeer();
    const seen = await polluted("restored", true, async () => [
      await historyAt(() => openSqliteStore(path)),
      await historyAt(() => openStore(urlOf(path))),
      await historyAt(() => openStore(urlOf(path), {})),
    ]);
    expect(seen).toEqual([history, history, history]);
  });

  it("changeRetention: each store keeps its default", async () => {
    const path = newPath();
    const kept = await polluted("changeRetention", { revisions: 3 }, async () => {
      const sqlite = await openSqliteStore(path);
      const retention = sqlite.profile.changeRetention;
      await sqlite.close();
      return [retention, createMemoryStore().profile.changeRetention];
    });
    expect(kept).toEqual([{ revisions: 1024 }, "unbounded"]);
  });

  it("busyTimeoutMs: the SQLite store waits its default 5000 ms", async () => {
    const path = newPath();
    const wait = await polluted("busyTimeoutMs", 7, async () => {
      const store = await openSqliteStore(path);
      const ms = store.openAdmin().connection().busy_timeout;
      await store.close();
      return ms;
    });
    expect(wait).toBe(5000);
  });

  it("mintHistory: each store mints with its own source", async () => {
    const path = newPath();
    const minted = await polluted(
      "mintHistory",
      () => "polluted:history",
      async () => {
        const sqlite = await openSqliteStore(path);
        const a = (await sqlite.createPeer("peer:a", { erasure: "unproven" })).history;
        await sqlite.close();
        const b = (await createMemoryStore().createPeer("peer:b", { erasure: "unproven" })).history;
        return [a, b];
      },
    );
    expect(minted.map((history) => history === "polluted:history")).toEqual([false, false]);
    expect(minted[0]).toMatch(/^sqlite:[0-9a-f]{32}$/);
  });

  it("requires: openStore(url, {}) opens a store that lacks the named capability", async () => {
    const path = newPath();
    const opened = await polluted("requires", ["journal"], async () => [
      await outcome(async () => {
        const store = await openStore("memory:", {});
        await store.close();
        return "opened";
      }),
      await outcome(async () => {
        const store = await openStore(urlOf(path), {});
        await store.close();
        return "opened";
      }),
    ]);
    expect(opened).toEqual(["opened", "opened"]);
  });

  it("erasure: createPeer without a posture refuses on each store", async () => {
    const path = newPath();
    const refused = await polluted("erasure", "unproven", async () => {
      const sqlite = await openSqliteStore(path);
      const a = await outcome(() => sqlite.createPeer("peer:a", {} as never));
      await sqlite.close();
      const b = await outcome(() => createMemoryStore().createPeer("peer:b", {} as never));
      return [a, b];
    });
    expect(refused).toEqual(["invalid-request", "invalid-request"]);
  });

  it("allowDegraded and requireExisting: OrdinaryJournalPeer.open opens as with no option", async () => {
    const created = await polluted("requireExisting", true, async () =>
      outcome(async () => (await OrdinaryJournalPeer.open(new JournalStore(), PEER)).status),
    );
    const store = new JournalStore();
    const first = (await OrdinaryJournalPeer.open(store, PEER)).status;
    const reopened = await polluted("allowDegraded", true, () =>
      outcome(async () => (await OrdinaryJournalPeer.open(store, PEER)).status),
    );
    expect({ created, first, reopened }).toEqual({
      created: "open",
      first: "open",
      reopened: "open",
    });
  });
});

describe("read and view options set only on Object.prototype read as absent", () => {
  it("timestampAtMost: a scope with no pushdown trims nothing", async () => {
    const peer = await peerWith([fact("target", 1, "one"), fact("target", 2, "two")]);
    const snapshot = await peer.read();
    const answer = await polluted("timestampAtMost", 0, () =>
      snapshot.scope({ anchors: [{ kind: "entity", entity: "target" }] }),
    );
    expect([answer.deltas.length, answer.applied]).toEqual([
      2,
      { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
    ]);
  });

  it("capture, admits and pushdown: readAnchored answers every member and no capture", async () => {
    const peer = await peerWith([fact("target", 1, "one"), fact("target", 2, "two")]);
    const snapshot = await peer.read();
    const request = { term: LEAF, root: "target", now: 10 };
    const plain = await readAnchored(snapshot, request);
    const withCapture = await polluted("capture", true, () => readAnchored(snapshot, request));
    const withAdmits = await polluted(
      "admits",
      () => false,
      () => readAnchored(snapshot, request),
    );
    const withPushdown = await polluted("pushdown", { timestampAtMost: 0 }, () =>
      readAnchored(snapshot, request),
    );
    expect(plain.members).toHaveLength(2);
    expect(["capture" in withCapture, withAdmits.members, withPushdown.members]).toEqual([
      false,
      plain.members,
      plain.members,
    ]);
  });

  it("maxViews and epoch: a holder keeps its default size and the empty epoch", async () => {
    const peer = await peerWith([fact("target", 1, "one")]);
    const made = await polluted("maxViews", 0, async () =>
      outcome(async () => {
        new StoreViews(peer);
        return "made";
      }),
    );
    const views = new StoreViews(peer);
    await polluted("epoch", "polluted", async () => views.register("leaf", { term: LEAF }));
    await views.hold("leaf", "target", 10);
    await views.setEpoch("leaf", "");
    const { reread } = await views.refresh(10);
    expect({ made, reread }).toEqual({ made: "made", reread: [] });
  });
});

describe("a refused openStore changes nothing (reading 126)", () => {
  it("openStore(url, {requires: [journal], restored: true}) refuses capability-absent, and the file's rows and every history are as before", async () => {
    const { path, history } = await sqliteWithPeer();
    const rows = (): unknown => {
      const db = new Database(path, { readonly: true });
      try {
        return ["meta", "peer", "history"].map((table) =>
          db.prepare(`SELECT * FROM ${table} ORDER BY 1`).raw().all(),
        );
      } finally {
        db.close();
      }
    };
    const before = rows();
    const refused = await outcome(() =>
      openStore(urlOf(path), { requires: ["journal"], restored: true }),
    );
    expect(refused).toBe("capability-absent");
    expect(rows()).toEqual(before);
    expect(await historyAt(() => openSqliteStore(path))).toBe(history);
  });

  it("openStore of a new file with a requirement the store lacks refuses and creates no file", async () => {
    const { dir: empty, remove: drop } = space("rhizomatic-own-options-new");
    try {
      const refused = await outcome(() =>
        openStore(urlOf(join(empty, "new.db")), { requires: ["journal"] }),
      );
      expect([refused, readdirSync(empty)]).toEqual(["capability-absent", []]);
    } finally {
      drop();
    }
  });
});

describe("a refused open of a file that is not a store leaves the file as it was (reading 126)", () => {
  const foreign = {
    "a SQLite file with one unrelated table": (path: string) => {
      const db = new Database(path);
      db.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('kept');");
      db.close();
    },
    "a SQLite file whose meta table holds only the store's format row": (path: string) => {
      const db = new Database(path);
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
      db.prepare("INSERT INTO meta VALUES ('format', ?)").run(SQLITE_STORE_FORMAT);
      db.close();
    },
    "a file that is not SQLite": (path: string) =>
      writeFileSync(path, "not a database\n".repeat(400)),
  };
  for (const [what, make] of Object.entries(foreign))
    it(`${what}: openSqliteStore and openStore refuse open-failed, the bytes are the same and no -wal or -shm file is left`, async () => {
      const { dir: own, remove: drop } = space("rhizomatic-foreign-file");
      try {
        const path = join(own, "other.db");
        make(path);
        const before = readFileSync(path);
        const refused = [
          await outcome(() => openSqliteStore(path)),
          await outcome(() => openStore(urlOf(path))),
        ];
        expect({
          refused,
          same: readFileSync(path).equals(before),
          files: readdirSync(own),
        }).toEqual({ refused: ["open-failed", "open-failed"], same: true, files: ["other.db"] });
      } finally {
        drop();
      }
    });
});

const PEER = `ed25519:${"7e".repeat(32)}`;
const LEAF = parseTerm({
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
});
const fact = (entity: string, t: number, value: string): Delta =>
  makeDelta({
    timestamp: t,
    validFrom: t,
    author: "did:key:zA",
    pointers: [
      { role: "subject", target: { kind: "entity", entity: { id: entity, context: "subject" } } },
      { role: "value", target: { kind: "primitive", value } },
    ],
  });

async function peerWith(deltas: readonly Delta[]): Promise<PeerStore> {
  const peer = await createMemoryStore().createPeer(PEER, { erasure: "unproven" });
  const added = deltas.map((delta, i) => ({
    delta,
    arrival: { id: delta.id, at: 1, sequence: i + 1, transfer: 1, sender: "local" },
  }));
  const result = await peer.append({ expectedHead: null, nextHead: "h1", frame: null, added });
  if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
  return peer;
}

/** A journal store in memory with no degraded read. */
class JournalStore implements DurableOrdinaryJournalStore {
  head: string | null = null;
  async readJournal(): Promise<OrdinaryJournalRead> {
    return this.head === null
      ? { status: "empty" }
      : { status: "journal", head: this.head, frames: [] };
  }
  async readAdmittedRows(): Promise<readonly Delta[]> {
    return [];
  }
  async readHead(): Promise<OrdinaryJournalHead> {
    return this.head === null ? { status: "missing" } : { status: "head", head: this.head };
  }
  async compareAndAppend(
    _peer: string,
    expected: string | null,
    next: string,
  ): Promise<PeerImageWrite> {
    if (this.head !== expected) return { status: "conflict" };
    this.head = next;
    return { status: "durable" };
  }
}
