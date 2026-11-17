// The holdings digest on both stores (SPEC-18 proposal §4.7.6; §4.13 readings 139 to 142): the
// shared vectors `digest.json`; the root and every node against the model `digestOf` at every
// size from 0 to 40 and back, at several depths; one root for one set in any order; the strict
// call; a reopen; `fsck` on a damaged digest and on a stray row; two writing processes; and the
// two-sided erasure rails on a real file: a sound digest, a damaged one, a merge and a second
// holder. Each SQLite rail runs in its own `mkdtempSync` directory.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { parseClaims } from "../src/delta/json-profile.js";
import { makeDelta } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { admissionOf } from "../src/storage/admission.js";
import { runDigestConformance } from "../src/storage/digest-conformance.js";
import { runStoreConformance } from "../src/storage/store-conformance.js";
import { digestVectors, type StoreDigestDocument } from "../src/storage/digest-vectors.js";
import { EMPTY_DIGEST, digestOf, digestRows, leafHash } from "../src/storage/digest.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { openSqliteStore } from "../src/storage/sqlite-store.js";
import { StoreError, type FsckReport, type PeerStore, type Store } from "../src/storage/store.js";
import { scan, space } from "./support/sqlite-erasure.js";
import { audit } from "./support/sqlite-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const committed = readFileSync(resolve(here, "../../../vectors/store/digest.json"), "utf8");
const document = JSON.parse(committed) as StoreDigestDocument;

const removals: (() => void)[] = [];
const opened: Store[] = [];
const children: ChildProcess[] = [];
afterAll(async () => {
  for (const proc of children) if (proc.exitCode === null) proc.kill("SIGKILL");
  for (const store of opened) await store.close();
  for (const remove of removals) remove();
});

/** A store file in a new `mkdtempSync` directory, and the directory. */
function place(): { dir: string; path: string } {
  const { dir, remove } = space("rhizomatic-store-digest");
  removals.push(remove);
  return { dir, path: join(dir, "store.db") };
}

async function sqlite(path = place().path): Promise<Store> {
  const store = await openSqliteStore(path);
  opened.push(store);
  return store;
}

/** The 38 deltas of the vectors (20 share `1e20c0d`, 12 more `1e20c0`), and 2 more of `1e20c0`. */
const FORTY: Delta[] = (() => {
  const named = document.deltas.map((d) => ({ id: d.id, claims: parseClaims(d.claims) }));
  const extra: Delta[] = [];
  for (let t = 5_000_000; extra.length < 2; t++) {
    const delta = makeDelta({
      timestamp: t,
      validFrom: 0,
      author: "did:key:zDigestExtra",
      pointers: [{ role: "about", target: { kind: "entity", entity: { id: `x:${t}` } } }],
    });
    if (delta.id.startsWith("1e20c0") && !delta.id.startsWith("1e20c0d")) extra.push(delta);
  }
  return [...named, ...extra];
})();

let heads = 0;
async function add(peer: PeerStore, deltas: readonly Delta[]): Promise<void> {
  const now = await peer.read();
  now.release();
  const result = await peer.append(
    admissionOf(now, deltas, { at: 1, sender: "digest", nextHead: `h-${++heads}` }),
  );
  if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
}

const refusal = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "answered",
    (error: unknown) => (error instanceof StoreError ? error.code : String(error)),
  );

/**
 * The root, the node of every prefix a store keeps, and two prefixes below each leaf, on a new
 * snapshot, against the model over `held`.
 */
async function agrees(peer: PeerStore, held: ReadonlySet<string>): Promise<void> {
  const snapshot = await peer.read();
  const want = digestOf(held);
  expect([snapshot.root, snapshot.count]).toEqual([want.hash, held.size]);
  const prefixes = new Set(digestRows(held).keys());
  for (const id of held) {
    prefixes.add(id.slice(0, 9));
    prefixes.add(id);
  }
  prefixes.add("1e20c0d0");
  prefixes.add("ff");
  for (const prefix of prefixes)
    expect([prefix, await snapshot.digest(prefix)]).toEqual([prefix, digestOf(held, prefix)]);
  snapshot.release();
}

describe("the shared digest vectors", () => {
  it("the committed file is the model's output", () => {
    expect(committed).toBe(`${JSON.stringify(digestVectors(), null, 2)}\n`);
  }, 60_000);

  it.each([
    ["memory", async () => createMemoryStore()],
    ["SQLite", () => sqlite()],
  ])("every tree and every case passes on the %s store, and none is skipped", async (_, make) => {
    const report = await runDigestConformance(make, document);
    expect(report.skipped).toEqual([]);
    expect(report.passed).toEqual([
      ...document.trees.map((t) => `trees/${t.name}`),
      ...document.cases.map((c) => `digest/${c.name}`),
    ]);
  });

  it("a store whose profile has no digest skips every case, with the requirement digest", async () => {
    const lacking = async (): Promise<Store> => {
      const store = createMemoryStore();
      const { capabilities } = store.profile;
      return {
        profile: { ...store.profile, capabilities: { ...capabilities, digest: false } },
        createPeer: (id, options) => store.createPeer(id, options),
        peer: (id) => store.peer(id),
        openAdmin: () => store.openAdmin(),
        close: () => store.close(),
      };
    };
    const report = await runDigestConformance(lacking, document);
    expect(report.skipped).toEqual(
      document.cases.map((c) => ({ name: `digest/${c.name}`, missing: "digest" })),
    );
  });
});

/**
 * The store, with the root and the node of the root checked against the model over the peer's
 * holdings after every append and purge that answers.
 */
function rooted(store: Store): Store {
  const check = async (p: PeerStore): Promise<void> => {
    const ids: string[] = [];
    for await (const id of store.openAdmin().peer(p.id).ids()) ids.push(id);
    const snapshot = await p.read();
    const want = digestOf(ids);
    const top = await snapshot.digest("");
    snapshot.release();
    if (snapshot.root !== want.hash || top.hash !== want.hash || top.count !== want.count)
      throw new Error(`peer ${p.id}: the root is not the model's over its ${ids.length} ids`);
  };
  const peer = (p: PeerStore): PeerStore => ({
    id: p.id,
    get history() {
      return p.history;
    },
    get appFormat() {
      return p.appFormat;
    },
    erasure: p.erasure,
    read: () => p.read(),
    append: async (batch) => {
      const result = await p.append(batch);
      await check(p);
      return result;
    },
    purge: async (ids) => {
      const report = await p.purge(ids);
      await check(p);
      return report;
    },
    changes: (from, to) => p.changes(from, to),
  });
  return {
    profile: store.profile,
    createPeer: async (id, options) => peer(await store.createPeer(id, options)),
    peer: async (id) => peer(await store.peer(id)),
    openAdmin: () => store.openAdmin(),
    close: () => store.close(),
  };
}

describe("the root after every step of the shared store scripts", () => {
  it.each([
    ["memory", async () => rooted(createMemoryStore())],
    ["SQLite", async () => rooted(await sqlite())],
  ])(
    "on the %s store, the root is the model's after every append and purge",
    async (_, make) => {
      const report = await runStoreConformance(make);
      expect(report.skipped).toEqual([]);
    },
    120_000,
  );
});

const STORES: readonly [string, () => Promise<{ store: Store; check: () => void }>][] = [
  ["memory", async () => ({ store: createMemoryStore(), check: () => undefined })],
  [
    "SQLite",
    async () => {
      const { path } = place();
      return { store: await sqlite(path), check: () => audit(path) };
    },
  ],
];

describe.each(STORES)("the digest on the %s store", (_, make) => {
  it("the root and every node equal the model's at every size from 0 to 40 and back to 0, one id at a time, while another peer holds every id", async () => {
    const { store, check } = await make();
    await add(await store.createPeer("peer:b", { erasure: "unproven" }), FORTY);
    const peer = await store.createPeer("peer:a", { erasure: "unproven" });
    const held = new Set<string>();
    await agrees(peer, held);
    for (const delta of FORTY) {
      await add(peer, [delta]);
      held.add(delta.id);
      check();
      await agrees(peer, held);
    }
    for (const delta of [...FORTY].reverse()) {
      await peer.purge([delta.id]);
      held.delete(delta.id);
      check();
      await agrees(peer, held);
    }
    expect((await peer.read()).root).toBe(EMPTY_DIGEST.hash);
  }, 60_000);

  it("one set gives one root in any order of arrival, and after a purge and an append of the same ids", async () => {
    const { store } = await make();
    const want = digestOf(FORTY.map((d) => d.id)).hash;
    let seed = 7;
    const shuffled = (): Delta[] =>
      FORTY.map((d) => ({ d, k: (seed = (seed * 48271) % 2147483647) }))
        .sort((x, y) => x.k - y.k)
        .map(({ d }) => d);
    const roots: string[] = [];
    for (let n = 0; n < 4; n++) {
      const peer = await store.createPeer(`peer:${n}`, { erasure: "unproven" });
      const order = shuffled();
      for (let i = 0; i < order.length; i += 7) await add(peer, order.slice(i, i + 7));
      roots.push((await peer.read()).root!);
    }
    expect(roots).toEqual([want, want, want, want]);
    const peer = await store.peer("peer:0");
    const some = [FORTY[2]!, FORTY[19]!, FORTY[30]!];
    await peer.purge(some.map((d) => d.id));
    expect((await peer.read()).root).toBe(
      digestOf(FORTY.filter((d) => !some.includes(d)).map((d) => d.id)).hash,
    );
    await add(peer, [...some].reverse());
    expect((await peer.read()).root).toBe(want);
  }, 60_000);

  it("root is fixed at read; digest answers after a head-only append and a purge that releases nothing, and refuses snapshot-moved after an append or a purge that changes the held set", async () => {
    const { store } = await make();
    const peer = await store.createPeer("peer:a", { erasure: "unproven" });
    const first = FORTY.slice(0, 18);
    await add(peer, first);
    const old = await peer.read();
    const before = digestOf(first.map((d) => d.id));
    expect(old.root).toBe(before.hash);
    await add(peer, []);
    await peer.purge([FORTY[39]!.id]);
    expect(await old.digest("")).toEqual(before);
    await add(peer, [FORTY[39]!]);
    expect(old.root).toBe(before.hash);
    expect(await refusal(old.digest(""))).toBe("snapshot-moved");
    expect(await refusal(old.digest("1e2011"))).toBe("snapshot-moved");
    // The other calls of the snapshot still answer as at its revision.
    expect(await old.get([FORTY[39]!.id])).toEqual([]);
    const now = await peer.read();
    await peer.purge([FORTY[0]!.id]);
    expect(now.root).toBe(digestOf([...first, FORTY[39]!].map((d) => d.id)).hash);
    expect(await refusal(now.digest(""))).toBe("snapshot-moved");
    expect(await refusal(now.digest("1E20"))).toBe("invalid-request");
    expect(await refusal((await peer.read()).digest("1e20 "))).toBe("invalid-request");
  });
});

describe("the digest on the SQLite store alone", () => {
  it("a store reopens with the same root and the same nodes", async () => {
    const { path } = place();
    const store = await openSqliteStore(path);
    const peer = await store.createPeer("peer:a", { erasure: "unproven" });
    await add(peer, FORTY);
    await peer.purge([FORTY[5]!.id]);
    const held = new Set(FORTY.filter((_, i) => i !== 5).map((d) => d.id));
    await store.close();
    const again = await sqlite(path);
    await agrees(await again.peer("peer:a"), held);
    expect((await again.openAdmin().fsck()).faults).toEqual([]);
  });

  const places = (report: FsckReport) =>
    report.faults.map(({ kind, peer, id, key }) => ({ kind, peer, id, key }));

  it("fsck reports digest-mismatch for a damaged node, a damaged root and a lost node, and nothing else; another peer's digest has no fault", async () => {
    for (const damage of [
      "UPDATE digest SET hash = ? WHERE peer = 'peer:a' AND prefix = '1e20c0d'",
      "UPDATE peer SET root = ? WHERE id = 'peer:a'",
      "UPDATE digest SET count = count + 1, hash = ? WHERE peer = 'peer:a' AND prefix = '1e20c0d0'",
    ]) {
      const { path } = place();
      const store = await sqlite(path);
      await add(await store.createPeer("peer:a", { erasure: "unproven" }), FORTY);
      await add(await store.createPeer("peer:b", { erasure: "unproven" }), FORTY.slice(0, 20));
      expect((await store.openAdmin().fsck()).faults).toEqual([]);
      const db = new Database(path);
      const changed = db.prepare(damage).run(leafHash(["1e20" + "0".repeat(64)])).changes;
      db.close();
      expect(changed).toBe(1);
      const report = await store.openAdmin().fsck();
      const key = damage.includes("root")
        ? "peer.root"
        : damage.includes("'1e20c0d0'")
          ? "digest:1e20c0d0"
          : "digest:1e20c0d";
      expect(places(report)).toContainEqual({
        kind: "digest-mismatch",
        peer: "peer:a",
        id: undefined,
        key,
      });
      expect(report.faults.every((f) => f.kind === "digest-mismatch" && f.peer === "peer:a")).toBe(
        true,
      );
    }
    const { path } = place();
    const store = await sqlite(path);
    await add(await store.createPeer("peer:a", { erasure: "unproven" }), FORTY);
    const db = new Database(path);
    expect(
      db.prepare("DELETE FROM digest WHERE peer = 'peer:a' AND prefix = '1e20c0d0'").run().changes,
    ).toBe(1);
    db.close();
    expect(places(await store.openAdmin().fsck())).toEqual([
      { kind: "digest-mismatch", peer: "peer:a", id: undefined, key: "digest:1e20c0d" },
    ]);
  });

  it("a damaged count in the digest does not stop a purge: the purge removes the ids, and fsck then reports digest-mismatch", async () => {
    const { path } = place();
    const store = await sqlite(path);
    const peer = await store.createPeer("peer:a", { erasure: "unproven" });
    await add(peer, FORTY);
    const db = new Database(path);
    db.prepare("UPDATE digest SET count = 1 WHERE peer = 'peer:a' AND prefix = ''").run();
    db.close();
    const report = await peer.purge([FORTY[0]!.id, FORTY[1]!.id]);
    expect(report.targets.map((t) => t.outcome)).toEqual(["removed", "removed"]);
    expect((await (await peer.read()).get([FORTY[0]!.id, FORTY[1]!.id])).length).toBe(0);
    expect((await store.openAdmin().fsck()).faults.map((f) => f.kind)).toContain("digest-mismatch");
  });

  it("fsck reports a stray digest row that no parent accounts for: a copy of x's leaf where no held id starts, at the top and under an internal node", async () => {
    const x = FORTY[0]!.id;
    const used = new Set(FORTY.map((d) => d.id.slice(0, 8)));
    const empty = [..."0123456789abcdef"].map((d) => `1e20c0d${d}`).find((p) => !used.has(p));
    expect(empty).toBeDefined();
    for (const [stray, keys] of [
      ["ff", ["digest:ff"]],
      [empty!, ["digest:1e20c0d", `digest:${empty}`]],
    ] as const) {
      const { path } = place();
      const store = await sqlite(path);
      await add(await store.createPeer("peer:a", { erasure: "unproven" }), FORTY);
      const db = new Database(path);
      const copied = db
        .prepare(
          `INSERT INTO digest (peer, prefix, count, hash)
          SELECT peer, ?, count, hash FROM digest WHERE peer = 'peer:a' AND prefix = ?`,
        )
        .run(stray, x.slice(0, 8)).changes;
      db.close();
      expect(copied).toBe(1);
      expect(places(await store.openAdmin().fsck())).toEqual(
        keys.map((key) => ({ kind: "digest-mismatch", peer: "peer:a", id: undefined, key })),
      );
    }
  });

  it("a snapshot's digest of a prefix that has no row and more than 16 held ids throws StoreIntegrityError digest-mismatch", async () => {
    const { path } = place();
    const store = await sqlite(path);
    const peer = await store.createPeer("peer:a", { erasure: "unproven" });
    await add(peer, FORTY);
    const db = new Database(path);
    db.prepare("DELETE FROM digest WHERE peer = 'peer:a' AND prefix = '1e20c0d'").run();
    db.close();
    const thrown = await (await peer.read()).digest("1e20c0d").catch((e: unknown) => e);
    expect((thrown as { fault?: unknown }).fault).toMatchObject({
      kind: "digest-mismatch",
      peer: "peer:a",
      key: "digest:1e20c0d",
    });
  });
});

describe("the digest on the memory store: fsck", () => {
  it.each([
    ["a stored node's hash changed", "1e20c0d", "1e20c0d"],
    ["a copy of x's leaf at a prefix no held id starts with", "ff", FORTY[0]!.id.slice(0, 8)],
  ])("%s in the store's own map gives one digest-mismatch with its key", async (_, key, from) => {
    const store = createMemoryStore();
    const peer = await store.createPeer("peer:a", { erasure: "unproven" });
    await add(peer, FORTY);
    expect((await store.openAdmin().fsck()).faults).toEqual([]);
    const snapshot = await peer.read();
    const real = Map.prototype.get;
    let rows: Map<string, unknown> | undefined;
    Map.prototype.get = function (this: Map<unknown, unknown>, asked: unknown) {
      if (asked === "1e20c0d") rows = this as Map<string, unknown>;
      return real.call(this, asked) as unknown;
    };
    let pending: Promise<unknown>;
    try {
      pending = snapshot.digest("1e20c0d");
    } finally {
      Map.prototype.get = real;
    }
    await pending;
    const row = rows!.get(from) as object;
    rows!.set(key, key === from ? { ...row, hash: EMPTY_DIGEST.hash } : row);
    expect(
      (await store.openAdmin().fsck()).faults.map(({ kind, peer: p, key: k }) => ({ kind, p, k })),
    ).toEqual([{ kind: "digest-mismatch", p: "peer:a", k: `digest:${key}` }]);
  });
});

/** A child that appends to and purges from `peer` until `<path>.stop` exists. */
function churn(path: string, peer: string) {
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", resolve(here, "support/sqlite-fsck-child.ts"), path, peer],
    { cwd: pkg, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(proc);
  let out = "";
  proc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  proc.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const ended = new Promise<number | null>((done) => proc.on("exit", (code) => done(code)));
  const started = async (): Promise<void> => {
    for (const start = Date.now(); Date.now() - start < 60_000; ) {
      if (out.includes("started 1")) return;
      if (proc.exitCode !== null) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`the child did not start: ${out}`);
  };
  return { ended, started, output: () => out };
}

describe("the digest under writing processes (SQLite)", () => {
  it("three processes that append and purge on two peers, with shared ids, leave each peer's root equal to the model over its holdings; fsck finds no fault while they write", async () => {
    const { path } = place();
    const store = await sqlite(path);
    await store.createPeer("peer:a", { erasure: "unproven" });
    await store.createPeer("peer:b", { erasure: "unproven" });
    const writers = [churn(path, "peer:a"), churn(path, "peer:a"), churn(path, "peer:b")];
    for (const w of writers) await w.started();
    const reports: FsckReport[] = [];
    for (const start = Date.now(); Date.now() - start < 3_000; )
      reports.push(await store.openAdmin().fsck());
    writeFileSync(`${path}.stop`, "");
    expect(
      await Promise.all(writers.map((w) => w.ended)),
      writers.map((w) => w.output()).join("\n"),
    ).toEqual([0, 0, 0]);
    expect(reports.flatMap((r) => r.faults)).toEqual([]);
    audit(path);
    for (const id of ["peer:a", "peer:b"]) {
      const ids: string[] = [];
      for await (const held of store.openAdmin().peer(id).ids()) ids.push(held);
      expect(ids.length).toBeGreaterThan(0);
      expect((await (await store.peer(id)).read()).root).toBe(digestOf(ids).hash);
    }
    expect((await store.openAdmin().fsck()).faults).toEqual([]);
  }, 120_000);
});

describe.skipIf(process.platform !== "linux")(
  "erasure: a proven purge leaves no digest hash that existed only because of the purged id",
  () => {
    it("after a proven purge of x, no file holds an old hash of x's path, the root is the remaining set's, and the bystander's nodes are unchanged", async () => {
      const { dir, path } = place();
      const store = await sqlite(path);
      const peer = await store.createPeer("peer:p", { erasure: "proven" });
      // x and its neighbours share `1e20c0d`; the bystander y lies under `1e20c0` beside them.
      const deep = FORTY.slice(0, 20);
      const [x] = deep;
      const y = FORTY[25]!;
      await add(peer, [x!]);
      // Each later append under x's path rewrites the nodes that hash x, so old cells that hash
      // x lie in the free space of the pages before the purge.
      for (const d of deep.slice(1)) await add(peer, [d]);
      await add(peer, [y, ...FORTY.slice(20, 25)]);
      const hashes = (): Set<string> => {
        const db = new Database(path, { readonly: true });
        try {
          return new Set([
            ...(db.prepare("SELECT hash FROM digest").pluck().all() as string[]),
            ...(db.prepare("SELECT root FROM peer").pluck().all() as string[]),
          ]);
        } finally {
          db.close();
        }
      };
      // Every hash a node on x's path ever had, from the first append of x to the purge.
      const ofX = new Set<string>();
      const held: string[] = [];
      for (const d of [...deep, y, ...FORTY.slice(20, 25)]) {
        held.push(d.id);
        for (let k = 0; k <= 7; k++) ofX.add(digestOf(held, x!.id.slice(0, k)).hash);
        ofX.add(digestOf(held, x!.id.slice(0, 9)).hash);
      }
      const bystander = y.id.slice(0, 7);
      const yBefore = await (await peer.read()).digest(bystander);
      const seen = scan(dir, [...ofX]).map((found) => found.slice(found.indexOf(": ") + 2));
      const report = await peer.purge([x!.id]);
      expect(report.claim).toBe("proven");
      const remaining = held.filter((id) => id !== x!.id);
      const after = await peer.read();
      expect(after.root).toBe(digestOf(remaining).hash);
      // The markers: hashes that held x and are not live now.
      const live = hashes();
      const markers = [...ofX].filter((h) => !live.has(h));
      expect(markers.length).toBeGreaterThan(8);
      // The control: before the purge, the scan found markers in a file.
      expect(markers.filter((m) => seen.includes(m)).length).toBeGreaterThan(0);
      expect(scan(dir, markers)).toEqual([]);
      // The bystander: its subtree did not change, so its node is the same, and it reads.
      expect(await after.digest(bystander)).toEqual(yBefore);
      expect((await after.get([y.id])).map((d) => d.id)).toEqual([y.id]);
      audit(path);
    }, 60_000);

    /** Every live digest hash and root of the file, or of one peer. */
    const liveHashes = (path: string, peer?: string): Set<string> => {
      const db = new Database(path, { readonly: true });
      try {
        const one = peer === undefined ? [] : [peer];
        return new Set([
          ...(db
            .prepare(`SELECT hash FROM digest${peer === undefined ? "" : " WHERE peer = ?"}`)
            .pluck()
            .all(...one) as string[]),
          ...(db
            .prepare(`SELECT root FROM peer${peer === undefined ? "" : " WHERE id = ?"}`)
            .pluck()
            .all(...one) as string[]),
        ]);
      } finally {
        db.close();
      }
    };
    /** The peer's digest rows, ascending by prefix. */
    const rowsOf = (
      path: string,
      peer: string,
    ): { prefix: string; count: number; hash: string }[] => {
      const db = new Database(path, { readonly: true });
      try {
        return db
          .prepare("SELECT prefix, count, hash FROM digest WHERE peer = ? ORDER BY prefix")
          .all(peer) as { prefix: string; count: number; hash: string }[];
      } finally {
        db.close();
      }
    };
    /** The stored hash of every node on the path of `id` in the peer's digest, and its root. */
    const pathHashes = (path: string, peer: string, id: string): string[] => [
      ...new Set([
        rootOf(path, peer),
        ...rowsOf(path, peer)
          .filter((r) => id.startsWith(r.prefix))
          .map((r) => r.hash),
      ]),
    ];
    const rootOf = (path: string, peer: string): string => {
      const db = new Database(path, { readonly: true });
      try {
        return db.prepare("SELECT root FROM peer WHERE id = ?").pluck().get(peer) as string;
      } finally {
        db.close();
      }
    };
    const raw = (path: string, statement: string): number => {
      const db = new Database(path);
      try {
        return db.prepare(statement).run().changes;
      } finally {
        db.close();
      }
    };

    // x lies under `1e20c0d`, an internal node below the internal `1e20c0`; y lies under
    // `1e20c0` beside it. Each damage is made after the hashes of x's path are read.
    const THIRTY_EIGHT = FORTY.slice(0, 38);
    const x = FORTY[0]!.id;
    const y = FORTY[25]!.id;
    it.each([
      {
        damage: "the root's count set to 1",
        statement: "UPDATE digest SET count = 1 WHERE peer = 'peer:p' AND prefix = ''",
        // The update reads every held id for the root and writes the root as one leaf.
        rootIsLeaf: true,
        rewritten: "",
        faults: ["digest:"],
      },
      {
        damage: "the internal row 1e20c0 on x's path lost",
        statement: "DELETE FROM digest WHERE peer = 'peer:p' AND prefix = '1e20c0'",
        // The update writes `1e20c0` as one leaf over its held ids.
        rootIsLeaf: false,
        rewritten: "1e20c0",
        faults: ["digest:1e20c0"],
      },
      {
        damage: "the count of x's leaf set to 20",
        statement: `UPDATE digest SET count = 20 WHERE peer = 'peer:p' AND prefix = '${x.slice(0, 8)}'`,
        // The update takes the leaf for a node of 20 ids whose children it does not find.
        rootIsLeaf: false,
        rewritten: x.slice(0, 8),
        faults: ["digest:1e20c0d", `digest:${x.slice(0, 8)}`],
      },
    ])(
      "a proven purge of x on a damaged digest ($damage): no file and no live row holds a hash of x's path, y reads back, and fsck names what the purge leaves",
      async ({ statement, rootIsLeaf, rewritten, faults }) => {
        const { dir, path } = place();
        const store = await sqlite(path);
        const peer = await store.createPeer("peer:p", { erasure: "proven" });
        await add(peer, THIRTY_EIGHT);
        const old = pathHashes(path, "peer:p", x);
        expect(old.length).toBe(9);
        const yBefore = await (await peer.read()).digest(y.slice(0, 7));
        expect(raw(path, statement)).toBe(1);
        // The control: the scan finds the hashes of x's path before the purge.
        expect(scan(dir, old).length).toBeGreaterThan(0);
        const report = await peer.purge([x]);
        expect(report.claim).toBe("proven");
        expect(scan(dir, old)).toEqual([]);
        const live = liveHashes(path);
        expect(old.filter((h) => live.has(h))).toEqual([]);
        const rest = THIRTY_EIGHT.map((d) => d.id).filter((id) => id !== x);
        const after = await peer.read();
        expect((await after.get([y])).map((d) => d.id)).toEqual([y]);
        expect(await after.digest(y.slice(0, 7))).toEqual(yBefore);
        // The purge does not repair the digest. It leaves the rewritten node with no row below
        // it, and fsck names the damage.
        expect(after.root).not.toBe(digestOf(rest).hash);
        if (rootIsLeaf) expect(after.root).toBe(leafHash(rest.sort()));
        const under = rowsOf(path, "peer:p").filter((r) => r.prefix.startsWith(rewritten));
        expect(under.map((r) => r.prefix)).toEqual([rewritten]);
        const found = (await store.openAdmin().fsck()).faults;
        expect(found.map((f) => [f.kind, f.peer, f.key])).toEqual(
          faults.map((key) => ["digest-mismatch", "peer:p", key]),
        );
      },
      60_000,
    );

    it("a proven purge that merges 1e20c0d from 17 ids back into a leaf of 16 leaves no file or live row with a hash of x's path or of a dropped child; the root is the remaining set's, and y reads back", async () => {
      const { dir, path } = place();
      const store = await sqlite(path);
      const peer = await store.createPeer("peer:p", { erasure: "proven" });
      await add(peer, THIRTY_EIGHT);
      const first = FORTY.slice(1, 4).map((d) => d.id);
      expect((await peer.purge(first)).claim).toBe("proven");
      const node = rowsOf(path, "peer:p").filter((r) => r.prefix.startsWith("1e20c0d"));
      expect(node[0]).toMatchObject({ prefix: "1e20c0d", count: 17 });
      expect(node.length).toBeGreaterThan(1);
      const old = [...new Set([...pathHashes(path, "peer:p", x), ...node.map((r) => r.hash)])];
      const yBefore = await (await peer.read()).digest(y.slice(0, 7));
      expect(scan(dir, old).length).toBeGreaterThan(0);
      expect((await peer.purge([x])).claim).toBe("proven");
      expect(rowsOf(path, "peer:p").filter((r) => r.prefix.startsWith("1e20c0d"))).toEqual([
        { prefix: "1e20c0d", count: 16, hash: expect.any(String) as unknown },
      ]);
      const live = liveHashes(path);
      expect(old.filter((h) => live.has(h))).toEqual([]);
      expect(scan(dir, old)).toEqual([]);
      const rest = THIRTY_EIGHT.map((d) => d.id).filter((id) => id !== x && !first.includes(id));
      const after = await peer.read();
      expect(after.root).toBe(digestOf(rest).hash);
      expect((await after.get([y])).map((d) => d.id)).toEqual([y]);
      expect(await after.digest(y.slice(0, 7))).toEqual(yBefore);
      expect((await store.openAdmin().fsck()).faults).toEqual([]);
      audit(path);
    }, 60_000);

    it("x held by two peers: a purge from a leaves b's digest rows, root and x intact; a purge from b then leaves no file or live row with a hash of x's path from either peer", async () => {
      const { dir, path } = place();
      const store = await sqlite(path);
      const a = await store.createPeer("peer:a", { erasure: "proven" });
      const b = await store.createPeer("peer:b", { erasure: "proven" });
      // a holds 17 ids under `1e20c0d`, so its purge of x merges that node and drops the rows
      // below it; b holds 20 there, and keeps its rows.
      const held = THIRTY_EIGHT.filter((_, i) => i === 0 || i > 3);
      await add(a, held);
      await add(b, FORTY.slice(0, 30));
      const oldA = pathHashes(path, "peer:a", x);
      const oldB = pathHashes(path, "peer:b", x);
      const old = [...new Set([...oldA, ...oldB])];
      expect(scan(dir, old).length).toBeGreaterThan(0);
      const bRows = rowsOf(path, "peer:b");
      const bRoot = rootOf(path, "peer:b");
      await a.purge([x]);
      expect(rowsOf(path, "peer:a").filter((r) => r.prefix.startsWith("1e20c0d"))).toHaveLength(1);
      // b still holds x, so its hashes over x stay; a keeps none of its own.
      expect(rowsOf(path, "peer:b")).toEqual(bRows);
      expect(rootOf(path, "peer:b")).toBe(bRoot);
      expect((await (await b.read()).get([x])).map((d) => d.id)).toEqual([x]);
      expect((await b.read()).root).toBe(digestOf(FORTY.slice(0, 30).map((d) => d.id)).hash);
      const liveA = liveHashes(path, "peer:a");
      expect(oldA.filter((h) => liveA.has(h))).toEqual([]);
      expect((await b.purge([x])).claim).toBe("proven");
      const live = liveHashes(path);
      expect(old.filter((h) => live.has(h))).toEqual([]);
      expect(scan(dir, old)).toEqual([]);
      expect((await a.read()).root).toBe(
        digestOf(held.map((d) => d.id).filter((id) => id !== x)).hash,
      );
      expect((await b.read()).root).toBe(digestOf(FORTY.slice(1, 30).map((d) => d.id)).hash);
      expect((await (await a.read()).get([y])).map((d) => d.id)).toEqual([y]);
      expect((await store.openAdmin().fsck()).faults).toEqual([]);
      audit(path);
    }, 60_000);
  },
);
