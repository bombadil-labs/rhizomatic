// The rebuild measurement of slice 4 step 4b (plan §7), on the real schema through the store's own
// API. It is not a rail: at 100,000 deltas it takes minutes. Run it from implementations/ts:
//
//   timeout 900 npx tsx tools/measure-sqlite-rebuild.ts [rounds]
//
// 1. A peer of posture `unproven` appends `rounds` batches of 1,000 marked deltas. After each batch
//    it purges 500 random deltas it holds, so that half is purged and pages split and merge. Then
//    it purges the targets (1 delta in 97). An `unproven` purge runs no rebuild.
// 2. The store closes, which truncates the log. The scan counts the targets' markers in every file
//    of the directory: the residue that `secure_delete` alone leaves.
// 3. A child process opens the store, creates a peer of posture `proven` and purges nothing. The
//    file-level mark is set, so the purge rebuilds. The parent samples the child's memory, its open
//    files and the size of the log while it runs.
// 4. The scan runs again.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSqliteStore } from "../src/storage/sqlite-store.js";
import {
  marked,
  markersOf,
  scan,
  space,
  writerOf,
  type Marked,
} from "../test/support/sqlite-erasure.js";

const status = (pid: number | "self"): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const line of readFileSync(`/proc/${pid}/status`, "utf8").split("\n")) {
    const m = /^(VmRSS|VmHWM):\s+(\d+) kB/.exec(line);
    if (m !== null) out[m[1]!] = Number(m[2]) / 1024;
  }
  return out;
};

async function child(path: string): Promise<void> {
  const store = await openSqliteStore(path);
  const peer = await store.createPeer("peer:prover", { erasure: "proven" });
  const before = status("self");
  process.stdout.write(`start\n`);
  const t = performance.now();
  const report = await peer.purge([]);
  const ms = performance.now() - t;
  const after = status("self");
  process.stdout.write(`${JSON.stringify({ ms, before, after, surfaces: report.surfaces })}\n`);
  await store.close();
}

async function main(rounds: number): Promise<void> {
  const { dir, remove } = space("rhizomatic-measure-rebuild");
  const path = join(dir, "store.db");
  try {
    const store = await openSqliteStore(path);
    const peer = await store.createPeer("peer:churn", { erasure: "unproven" });
    const write = await writerOf(peer);
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const live: Marked[] = [];
    const targets: Marked[] = [];
    let n = 0;
    const t0 = performance.now();
    for (let r = 0; r < rounds; r++) {
      const batch = Array.from({ length: 1000 }, () => marked("M", n++));
      await write(batch);
      for (const d of batch) (d.delta.claims.timestamp % 97 === 5 ? targets : live).push(d);
      const gone: string[] = [];
      for (let i = 0; i < 500; i++)
        gone.push(live.splice(Math.floor(random() * live.length), 1)[0]!.delta.id);
      await peer.purge(gone);
    }
    const purged = await peer.purge(targets.map((d) => d.delta.id));
    console.log(
      `built: ${n} deltas appended, ${rounds * 500 + targets.length} purged, ${live.length} live, ${targets.length} targets, ${((performance.now() - t0) / 1000).toFixed(1)} s; target purge claims ${purged.claim}`,
    );
    await store.close();
    const markers = markersOf(targets);
    console.log(`files before the rebuild: ${files(dir)}`);
    console.log(
      `residue before the rebuild: ${scan(dir, markers).length} markers of ${markers.length}`,
    );

    const proc = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), "child", path],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    let started = false;
    let peakRss = 0;
    let peakLog = 0;
    const temp = new Set<string>();
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("start\n")) started = true;
    });
    const sampler = setInterval(() => {
      if (!started || proc.pid === undefined) return;
      try {
        peakRss = Math.max(peakRss, status(proc.pid).VmRSS ?? 0);
        for (const fd of readdirSync(`/proc/${proc.pid}/fd`)) {
          const target = readlinkSync(`/proc/${proc.pid}/fd/${fd}`);
          if (target.startsWith("/") && !target.startsWith(dir) && !target.startsWith("/dev"))
            temp.add(target);
        }
        peakLog = Math.max(peakLog, statSync(`${path}-wal`).size);
      } catch {
        // The child ended between two reads.
      }
    }, 5);
    await new Promise((done) => proc.on("exit", done));
    clearInterval(sampler);
    const result = JSON.parse(out.split("\n").filter((l) => l.startsWith("{"))[0]!) as {
      ms: number;
      before: Record<string, number>;
      after: Record<string, number>;
      surfaces: unknown;
    };
    console.log(
      `rebuild: ${(result.ms / 1000).toFixed(2)} s; surfaces ${JSON.stringify(result.surfaces)}`,
    );
    console.log(
      `memory of the child: RSS ${result.before.VmRSS!.toFixed(1)} MB before the purge; peak sampled RSS during it ${peakRss.toFixed(1)} MB; high-water mark ${result.before.VmHWM!.toFixed(1)} MB before and ${result.after.VmHWM!.toFixed(1)} MB after`,
    );
    console.log(
      `files the child held open outside the store's directory: ${[...temp].join(", ") || "none seen"}`,
    );
    console.log(`largest log seen during the rebuild: ${(peakLog / 2 ** 20).toFixed(1)} MB`);
    console.log(`files after the rebuild: ${files(dir)}`);
    console.log(
      `residue after the rebuild: ${scan(dir, markers).length} markers of ${markers.length}`,
    );
  } finally {
    remove();
  }
}

const files = (dir: string): string =>
  readdirSync(dir)
    .map((name) => `${name} ${(statSync(join(dir, name)).size / 2 ** 20).toFixed(1)} MB`)
    .join(", ");

if (process.argv[2] === "child") await child(process.argv[3]!);
else await main(Number(process.argv[2] ?? 100));
