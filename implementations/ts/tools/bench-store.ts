// A by-hand benchmark of the SQLite store at real size (issue #140, point 7). It is not a rail: no
// test and no CI job runs it. It imports only the sources of the package's public entries, `.`
// and `./store/sqlite`. Run it from implementations/ts:
//
//   npm run bench:store -- [--deltas N] [--peers P] [--batch B] [--dir PATH] [--keep] [--json FILE]
//
// Batches go to the peers in turn. Reads, the feed and the purges use the first peer. The proven
// purge needs a peer of posture `proven` that holds the deltas, and a posture is fixed at
// `createPeer`, so a second store is built with the same deltas.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  admissionOf,
  makeDelta,
  makeNegationClaims,
  type Claims,
  type Delta,
  type Pointer,
  type PeerStore,
} from "../src/index.js";
import { openSqliteStore } from "../src/storage/sqlite-store.js";

type Args = {
  deltas: number;
  peers: number;
  batch: number;
  dir: string | null;
  keep: boolean;
  json: string | null;
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    deltas: 1_000_000,
    peers: 1,
    batch: 1000,
    dir: null,
    keep: false,
    json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    const count = (): number => {
      const n = Number(value());
      if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} takes a positive integer`);
      return n;
    };
    if (flag === "--deltas") args.deltas = count();
    else if (flag === "--peers") args.peers = count();
    else if (flag === "--batch") args.batch = count();
    else if (flag === "--dir") args.dir = value();
    else if (flag === "--json") args.json = value();
    else if (flag === "--keep") args.keep = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const ENTITIES = 100_000;
const AUTHORS = 8;
const ROLES = ["name", "status", "parent", "tag", "member", "count"] as const;
const NEGATION_RATE = 0.02;

function generator(seed: number) {
  const random = prng(seed);
  const pick = (n: number): number => Math.floor(random() * n);
  const ids: string[] = [];
  const touched: number[] = [];
  const entity = (): string => {
    const e = pick(ENTITIES);
    touched.push(e);
    return `ent:${e}`;
  };
  return {
    ids,
    touched,
    next(n: number): Delta {
      touched.length = 0;
      const author = `author:${pick(AUTHORS)}`;
      const timestamp = 1_700_000_000_000 + n;
      let claims: Claims;
      if (ids.length > 0 && random() < NEGATION_RATE) {
        claims = makeNegationClaims(author, timestamp, ids[pick(ids.length)]!);
      } else {
        const pointers: Pointer[] = [
          { role: "subject", target: { kind: "entity", entity: { id: entity() } } },
        ];
        const extra = 1 + pick(3);
        for (let k = 0; k < extra; k++) {
          const role = ROLES[pick(ROLES.length)]!;
          const r = random();
          pointers.push(
            r < 0.4
              ? { role, target: { kind: "entity", entity: { id: entity() } } }
              : r < 0.7
                ? { role, target: { kind: "primitive", value: `v${pick(10_000)}` } }
                : r < 0.9
                  ? { role, target: { kind: "primitive", value: pick(1000) } }
                  : { role, target: { kind: "primitive", value: random() < 0.5 } },
          );
        }
        claims = { timestamp, validFrom: timestamp, author, pointers };
      }
      const delta = makeDelta(claims);
      ids.push(delta.id);
      return delta;
    },
  };
}

type Writer = { peer: PeerStore; head: string | null; lastSequence: number; lastTransfer: number };

async function appendTo(w: Writer, deltas: readonly Delta[], n: number): Promise<number> {
  const nextHead = `bench-head-${n}`;
  const admission = admissionOf(w, deltas, { at: n, sender: "local", nextHead });
  const t = performance.now();
  const result = await w.peer.append(admission);
  const ms = performance.now() - t;
  if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
  w.head = nextHead;
  w.lastSequence += admission.added.length;
  w.lastTransfer += 1;
  return ms;
}

const pct = (sorted: readonly number[], p: number): number =>
  sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
const stats = (samples: readonly number[]) => {
  const s = [...samples].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 0.5), p99: pct(s, 0.99), max: s[s.length - 1] ?? NaN };
};
const fileBytes = (path: string): Record<string, number> => {
  const size = (p: string): number => (existsSync(p) ? statSync(p).size : 0);
  return { db: size(path), wal: size(`${path}-wal`), shm: size(`${path}-shm`) };
};
const rssMiB = (): number => process.resourceUsage().maxRSS / 1024;
const loadavg = (): string => {
  try {
    return readFileSync("/proc/loadavg", "utf8").trim();
  } catch {
    return "unknown";
  }
};

async function timed<T>(f: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const value = await f();
  return [value, performance.now() - t];
}

async function build(path: string, args: Args, posture: "proven" | "unproven") {
  const store = await openSqliteStore(path);
  const writers: Writer[] = [];
  for (let p = 0; p < args.peers; p++)
    writers.push({
      peer: await store.createPeer(`peer:bench-${p}`, { erasure: posture }),
      head: null,
      lastSequence: 0,
      lastTransfer: 0,
    });
  const gen = generator(20261119);
  const held = new Uint8Array(ENTITIES);
  const heldIds: string[] = [];
  const batchMs: number[] = [];
  const batchSizes: number[] = [];
  let genMs = 0;
  const t0 = performance.now();
  for (let n = 0, b = 0; n < args.deltas; b++) {
    const size = Math.min(args.batch, args.deltas - n);
    const tg = performance.now();
    const deltas: Delta[] = [];
    for (let i = 0; i < size; i++) {
      const delta = gen.next(n + i);
      deltas.push(delta);
      if (b % args.peers !== 0) continue;
      heldIds.push(delta.id);
      for (const e of gen.touched) held[e] = 1;
    }
    genMs += performance.now() - tg;
    batchMs.push(await appendTo(writers[b % args.peers]!, deltas, b + 1));
    batchSizes.push(size);
    n += size;
  }
  const wallMs = performance.now() - t0;
  const appendMs = batchMs.reduce((a, b) => a + b, 0);
  const decile = (from: number, to: number) => {
    let d = 0;
    let ms = 0;
    for (let i = from; i < to; i++) {
      d += batchSizes[i]!;
      ms += batchMs[i]!;
    }
    return (d / ms) * 1000;
  };
  const tenth = Math.max(1, Math.floor(batchMs.length / 10));
  return {
    store,
    writers,
    ids: heldIds,
    entities: [...held.keys()].filter((e) => held[e] === 1),
    append: {
      wallSeconds: wallMs / 1000,
      appendSeconds: appendMs / 1000,
      generateSeconds: genMs / 1000,
      deltasPerSecond: (args.deltas / appendMs) * 1000,
      firstTenthDeltasPerSecond: decile(0, tenth),
      lastTenthDeltasPerSecond: decile(batchMs.length - tenth, batchMs.length),
      batchMs: stats(batchMs),
    },
  };
}

type Row = readonly [string, unknown];
function table(out: Record<string, unknown>): string {
  const get = (path: string): unknown =>
    path
      .split(".")
      .reduce<unknown>(
        (o, k) =>
          o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined,
        out,
      );
  const f = (v: unknown): string =>
    typeof v === "number"
      ? Number.isInteger(v)
        ? String(v)
        : v.toFixed(v < 10 ? 3 : 1)
      : String(v);
  const rows: Row[] = [
    ["append wall s", get("append.wallSeconds")],
    ["append s (calls only)", get("append.appendSeconds")],
    ["append deltas/s, whole run", get("append.deltasPerSecond")],
    ["append deltas/s, first 10%", get("append.firstTenthDeltasPerSecond")],
    ["append deltas/s, last 10%", get("append.lastTenthDeltasPerSecond")],
    ["append ms per batch, p50", get("append.batchMs.p50")],
    ["append ms per batch, p99", get("append.batchMs.p99")],
    ["db bytes after close", get("size.closed.db")],
    ["wal bytes before close", get("size.open.wal")],
    ["bytes per delta", get("size.bytesPerDelta")],
    ["open + first read ms", get("openMs")],
    ["read() ms", get("snapshot.readMs")],
    ["scope 1 anchor ms, p50", get("read.scopeOneAnchorMs.p50")],
    ["scope 1 anchor ms, p99", get("read.scopeOneAnchorMs.p99")],
    ["scope 1 anchor, mean deltas", get("read.scopeOneAnchorMs.meanDeltas")],
    ["scope 10 anchors ms, p50", get("read.scopeTenAnchorsMs.p50")],
    ["scope 10 anchors ms, p99", get("read.scopeTenAnchorsMs.p99")],
    ["scope 10 anchors, mean deltas", get("read.scopeTenAnchorsMs.meanDeltas")],
    ["get 1 id ms, p50", get("read.getOneMs.p50")],
    ["get 1 id ms, p99", get("read.getOneMs.p99")],
    ["digest root node ms", get("digest.rootNodeMs")],
    ["digest 2-digit prefix ms", get("digest.prefix2Ms")],
    ["feed from 0: ms", get("changes.fullFeedMs")],
    ["feed from 0: pages / records", `${f(get("changes.pages"))} / ${f(get("changes.records"))}`],
    ["feed latest page ms", get("changes.latestPageMs")],
    ["prove() clean ms", get("prove.cleanMs")],
    ["purge 1 id (unproven) ms, p50", get("purgeUnproven.perCallMs.p50")],
    ["purge 1 id (unproven) ms, p99", get("purgeUnproven.perCallMs.p99")],
    ["prove() dirty ms", get("prove.dirtyMs")],
    ["append deltas/s, proven store", get("appendProven.deltasPerSecond")],
    ["purge 100 ids (proven) ms", get("purgeProven.batchOf100Ms")],
    ["purge 100 ids (proven) claim", get("purgeProven.claim")],
    ["peak RSS MiB", get("peakRssMiB")],
  ];
  return [
    "| measure | value |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${k} | ${f(v)} |`),
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const made = args.dir === null;
  const dir = made ? mkdtempSync(join(tmpdir(), "rhizomatic-bench-")) : args.dir!;
  if (!made) mkdirSync(dir, { recursive: true });
  const path = join(dir, "bench.db");
  const provenPath = join(dir, "bench-proven.db");
  if (existsSync(path) || existsSync(provenPath)) throw new Error(`${dir} already holds a bench`);
  const out: Record<string, unknown> = { args: { ...args, dir }, loadStart: loadavg() };
  const log = (line: string) => process.stdout.write(`${line}\n`);
  const random = prng(7);
  try {
    log(`building ${args.deltas} deltas in ${path}`);
    const built = await build(path, args, "unproven");
    out.append = built.append;
    out.heldEntities = built.entities.length;
    out.rssAfterBuildMiB = rssMiB();
    log(`append done: ${JSON.stringify(built.append)}`);
    const live = fileBytes(path);
    await built.store.close();
    const closed = fileBytes(path);
    const total = closed.db! + closed.wal! + closed.shm!;
    out.size = { open: live, closed, bytesPerDelta: total / args.deltas };

    const ids = built.ids;
    const peerId = "peer:bench-0";
    const [reopened, openMs] = await timed(async () => {
      const store = await openSqliteStore(path);
      const peer = await store.peer(peerId);
      const snap = await peer.read();
      await snap.get([ids[0]!]);
      snap.release();
      return { store, peer };
    });
    const { store, peer } = reopened;
    out.openMs = openMs;

    const [snap, readMs] = await timed(() => peer.read());
    out.snapshot = { readMs, count: snap.count, revision: snap.revision, root: snap.root };
    const entity = () => ({
      kind: "entity" as const,
      entity: `ent:${built.entities[Math.floor(random() * built.entities.length)]!}`,
    });
    const one: number[] = [];
    const oneSizes: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const [r, ms] = await timed(() => snap.scope({ anchors: [entity()] }));
      one.push(ms);
      oneSizes.push(r.deltas.length);
    }
    const ten: number[] = [];
    const tenSizes: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const anchors = Array.from({ length: 10 }, entity);
      const [r, ms] = await timed(() => snap.scope({ anchors }));
      ten.push(ms);
      tenSizes.push(r.deltas.length);
    }
    const gets: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = ids[Math.floor(random() * ids.length)]!;
      gets.push((await timed(() => snap.get([id])))[1]);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    out.read = {
      scopeOneAnchorMs: { ...stats(one), meanDeltas: avg(oneSizes) },
      scopeTenAnchorsMs: { ...stats(ten), meanDeltas: avg(tenSizes) },
      getOneMs: stats(gets),
    };
    log(`read: ${JSON.stringify(out.read)}`);

    if (snap.root !== null) {
      const [node, rootMs] = await timed(() => snap.digest(""));
      const [, prefixMs] = await timed(() => snap.digest("a7"));
      out.digest = {
        root: snap.root,
        rootNodeMs: rootMs,
        rootCount: node.count,
        prefix2Ms: prefixMs,
      };
    } else out.digest = "the profile has no digest capability";
    snap.release();

    const current = snap.revision;
    let from = 0;
    let pages = 0;
    let records = 0;
    let feedStatus = "ok";
    const tf = performance.now();
    while (from < current) {
      const page = await peer.changes(from, current);
      if (page.status !== "ok") {
        feedStatus = `resync-required at ${from}, current ${page.current}`;
        break;
      }
      pages++;
      records += page.records.length;
      from = page.through;
    }
    const fullMs = performance.now() - tf;
    const [, latestMs] = await timed(() => peer.changes(current - 1));
    out.changes = {
      status: feedStatus,
      fullFeedMs: fullMs,
      pages,
      records,
      latestPageMs: latestMs,
    };
    log(`changes: ${JSON.stringify(out.changes)}`);

    const [cleanProof, cleanProveMs] = await timed(() => store.prove());
    const targets = Array.from({ length: 100 }, (_, i) => ids[(i * 9973 + 17) % ids.length]!);
    const purges: number[] = [];
    const outcomes: Record<string, number> = {};
    for (const id of targets) {
      const [report, ms] = await timed(() => peer.purge([id]));
      purges.push(ms);
      for (const t of report.targets) outcomes[t.outcome] = (outcomes[t.outcome] ?? 0) + 1;
    }
    const [dirtyProof, dirtyProveMs] = await timed(() => store.prove());
    out.purgeUnproven = { perCallMs: stats(purges), outcomes };
    out.prove = {
      cleanMs: cleanProveMs,
      cleanClaim: cleanProof.claim,
      dirtyMs: dirtyProveMs,
      dirtyClaim: dirtyProof.claim,
    };
    log(`purge (unproven): ${JSON.stringify(out.purgeUnproven)}`);
    log(`prove: ${JSON.stringify(out.prove)}`);
    await store.close();

    if (store.profile.capabilities.erasure === "proven") {
      log(`building the proven store in ${provenPath}`);
      const proven = await build(provenPath, args, "proven");
      out.appendProven = proven.append;
      const p0 = proven.writers[0]!.peer;
      const [report, purgeMs] = await timed(() => p0.purge(targets));
      out.purgeProven = {
        batchOf100Ms: purgeMs,
        claim: report.claim,
        removed: report.targets.filter((t) => t.outcome === "removed").length,
      };
      log(`purge (proven): ${JSON.stringify(out.purgeProven)}`);
      await proven.store.close();
    } else out.purgeProven = `the store's erasure class is ${store.profile.capabilities.erasure}`;
  } finally {
    out.peakRssMiB = rssMiB();
    out.loadEnd = loadavg();
    if (made && !args.keep) rmSync(dir, { recursive: true, force: true });
  }
  const text = JSON.stringify(out, null, 2);
  log(text);
  log(table(out));
  if (args.json !== null) writeFileSync(args.json, `${text}\n`);
}

await main();
