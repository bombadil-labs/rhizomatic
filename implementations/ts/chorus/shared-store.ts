// The shared store: many concurrent sessions, one world, no daemon. An append-only JSONL log
// (one delta per line) plus a lock directory. Correctness rides the CRDT: deltas are
// content-addressed and merge is union, so any interleaving of "read the new lines, append
// mine" converges — the lock only keeps appends from tearing, never arbitrates truth.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { DeltaSet, claimsToJson, makeDelta, parseClaims } from "../src/index.js";
import type { ChorusAgent } from "./agent.js";

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(path: string, fn: () => T): T {
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      // Held by someone. Steal only if stale (a crashed process), else wait.
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockDir);
          continue;
        }
      } catch {
        continue; // raced with a release; retry immediately
      }
      if (Date.now() > deadline) throw new Error(`could not acquire lock: ${lockDir}`);
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lockDir);
    } catch {
      // already stolen as stale — nothing to release
    }
  }
}

export class SharedStore {
  private offset = 0; // bytes of the file already parsed
  private linesSeen = 0; // parsed lines (incl. duplicates and torn skips)
  // Ids known to be on disk (read from it, or appended by us). Set semantics make this the
  // watermark: order-free, so derived emissions triggered mid-refresh are never skipped.
  private readonly onDisk = new Set<string>();

  constructor(readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  // Read lines appended since we last looked and ingest them through the agent (host-aware,
  // so derived authors react to other sessions' writes too). A trailing partial line (a
  // concurrent append caught mid-flush) is left for the next refresh — the offset never
  // crosses an unparsed boundary.
  refresh(agent: ChorusAgent): number {
    if (!existsSync(this.filePath)) return 0;
    const buf = readFileSync(this.filePath);
    if (buf.length <= this.offset) return 0;
    const chunk = buf.subarray(this.offset).toString("utf8");
    let consumed = 0;
    const arrived = [];
    for (;;) {
      const nl = chunk.indexOf("\n", consumed);
      if (nl === -1) break;
      const line = chunk.slice(consumed, nl).trim();
      consumed = nl + 1;
      if (line === "") continue;
      this.linesSeen += 1;
      try {
        const parsed = JSON.parse(line) as { claims: unknown; sig?: string };
        const delta = makeDelta(parseClaims(parsed.claims), parsed.sig);
        this.onDisk.add(delta.id);
        arrived.push(delta);
      } catch {
        // A torn line from a crashed writer: unrecoverable garbage; skip it, keep the log.
      }
    }
    this.offset += Buffer.byteLength(chunk.slice(0, consumed), "utf8");
    if (arrived.length === 0) return 0;
    return agent.importSet(DeltaSet.from(arrived)).accepted;
  }

  // Persist everything this agent holds that disk does not: take the lock, pull in concurrent
  // appends first (union — order is irrelevant), then append the difference.
  persist(agent: ChorusAgent): number {
    return withLock(this.filePath, () => {
      this.refresh(agent);
      const mine = agent.peer.reactor.arrivalLog().filter((d) => !this.onDisk.has(d.id));
      if (mine.length === 0) return 0;
      // If a crashed writer left an unterminated tail, seal it so our first line stays whole.
      const size = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
      const lead = size > this.offset ? "\n" : "";
      const lines = `${lead}${mine
        .map((d) =>
          JSON.stringify(
            d.sig === undefined
              ? { claims: claimsToJson(d.claims) }
              : { claims: claimsToJson(d.claims), sig: d.sig },
          ),
        )
        .join("\n")}\n`;
      appendFileSync(this.filePath, lines);
      this.offset = size + Buffer.byteLength(lines, "utf8");
      this.linesSeen += mine.length;
      for (const d of mine) this.onDisk.add(d.id);
      return mine.length;
    });
  }

  // The log accumulates duplicates only through crash-garbage and racing writers; once the
  // parsed-line count meaningfully exceeds the distinct-delta count, a rewrite pays.
  wasteful(agent: ChorusAgent, slack = 64): boolean {
    return this.linesSeen - agent.peer.reactor.arrivalLog().length > slack;
  }

  // Rewrite the log from the agent's full world: duplicates and torn lines vanish; bytes and
  // truth both shrink to one line per delta. Atomic via tmp-then-rename, under the lock.
  compact(agent: ChorusAgent): number {
    return withLock(this.filePath, () => {
      this.refresh(agent);
      const deltas = agent.peer.reactor.arrivalLog();
      const body = deltas
        .map((d) =>
          JSON.stringify(
            d.sig === undefined
              ? { claims: claimsToJson(d.claims) }
              : { claims: claimsToJson(d.claims), sig: d.sig },
          ),
        )
        .join("\n");
      const content = body === "" ? "" : `${body}\n`;
      const tmp = `${this.filePath}.compact.tmp`;
      writeFileSync(tmp, content);
      if (existsSync(this.filePath)) unlinkSync(this.filePath);
      renameSync(tmp, this.filePath);
      this.offset = Buffer.byteLength(content, "utf8");
      this.linesSeen = deltas.length;
      this.onDisk.clear();
      for (const d of deltas) this.onDisk.add(d.id);
      return deltas.length;
    });
  }
}
