// The JSONL backend: many concurrent sessions, one world, no daemon. An append-only JSONL log
// (one delta per line) plus a lock directory. Correctness rides the CRDT: deltas are
// content-addressed and merge is union, so any interleaving of "read the new lines, append
// mine" converges — the lock only keeps appends from tearing, never arbitrates truth.
//
// This is the legible dev/audit/inspection tier: git-diffable, zero-dependency, one delta per
// line. It is the first witness to the `StoreBackend` interface (store-tier.ts); the SQLite backend
// (sqlite-store.ts) is the second, solving the concurrency + indexed-read problems a flat file
// cannot. Keep this one legible — it is a first-class tier, not a legacy path.

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
import { DeltaSet, claimsToJson, makeDelta, parseClaims, type Delta } from "@rhizomes/core";
import type { ChorusAgent } from "./agent.js";
import type { StoreBackend } from "./store-tier.js";

// One JSONL line for a delta: the canonical claims JSON plus the signature, when present.
function serialize(d: Delta): string {
  return JSON.stringify(
    d.sig === undefined
      ? { claims: claimsToJson(d.claims) }
      : { claims: claimsToJson(d.claims), sig: d.sig },
  );
}

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Every path through this loop re-checks the deadline FIRST: no retry — stale-steal races,
// transient Windows EPERM from antivirus/indexer touches, anything — can spin unbounded.
// (v1 of this loop had two `continue` paths that skipped the check; a desktop session hung
// on exactly that. A lock must be allowed to fail loudly; it must never be allowed to hang.)
function withLock<T>(path: string, fn: () => T): T {
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `could not acquire ${lockDir} within ${LOCK_TIMEOUT_MS}ms — ` +
          `if no other chorus session is mid-write, delete the directory and retry`,
      );
    }
    try {
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        // Held by someone. Steal only if stale (a crashed process), else wait.
        try {
          if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
            rmdirSync(lockDir);
            continue;
          }
        } catch {
          // raced with a release or another stealer — loop (deadline-bounded)
        }
      }
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

export class JsonlStore implements StoreBackend {
  private offset = 0; // bytes of the file already parsed
  private linesSeen = 0; // parsed lines (incl. duplicates and torn skips)
  // Ids known to be on disk (read from it, or appended by us). Set semantics make this the
  // watermark: order-free, so derived emissions triggered mid-refresh are never skipped.
  private readonly onDisk = new Set<string>();

  constructor(readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  // Read lines appended since we last looked, advancing the byte offset + onDisk watermark. A
  // trailing partial line (a concurrent append caught mid-flush) is left for the next read —
  // the offset never crosses an unparsed boundary. No agent: this is the durable-read half that
  // both refresh (ingest into an agent) and appendDeltas (union before writing) share.
  private readNew(): Delta[] {
    if (!existsSync(this.filePath)) return [];
    const buf = readFileSync(this.filePath);
    if (buf.length <= this.offset) return [];
    const chunk = buf.subarray(this.offset).toString("utf8");
    let consumed = 0;
    const arrived: Delta[] = [];
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
    return arrived;
  }

  // Append the given deltas under the lock, sealing a torn tail first; advance the watermarks.
  // Caller has already filtered out anything on disk. Returns the count written.
  private writeLines(mine: readonly Delta[]): number {
    if (mine.length === 0) return 0;
    // If a crashed writer left an unterminated tail, seal it so our first line stays whole.
    const size = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    const lead = size > this.offset ? "\n" : "";
    const lines = `${lead}${mine.map(serialize).join("\n")}\n`;
    appendFileSync(this.filePath, lines);
    this.offset = size + Buffer.byteLength(lines, "utf8");
    this.linesSeen += mine.length;
    for (const d of mine) this.onDisk.add(d.id);
    return mine.length;
  }

  // Read lines appended since we last looked and ingest them through the agent (host-aware,
  // so derived authors react to other sessions' writes too).
  refresh(agent: ChorusAgent): number {
    const arrived = this.readNew();
    if (arrived.length === 0) return 0;
    return agent.importSet(DeltaSet.from(arrived)).accepted;
  }

  // Persist everything this agent holds that disk does not: take the lock, pull in concurrent
  // appends first (union — order is irrelevant), then append the difference.
  persist(agent: ChorusAgent): number {
    return withLock(this.filePath, () => {
      this.refresh(agent);
      const mine = agent.peer.reactor.arrivalLog().filter((d) => !this.onDisk.has(d.id));
      return this.writeLines(mine);
    });
  }

  // --- the delta-level primitive (store-tier.ts) -------------------------------------------------

  // Durably append every supplied delta not already on disk. Under the lock: union concurrent
  // appends first (the onDisk watermark), then write the difference. Idempotent by id.
  appendDeltas(deltas: Iterable<Delta>): number {
    return withLock(this.filePath, () => {
      this.readNew(); // union concurrent writers into the watermark before diffing
      const mine: Delta[] = [];
      const seen = new Set<string>();
      for (const d of deltas) {
        if (this.onDisk.has(d.id) || seen.has(d.id)) continue;
        seen.add(d.id);
        mine.push(d);
      }
      return this.writeLines(mine);
    });
  }

  // Every durably-stored delta whose id is not yet known to the caller. A full, independent
  // parse of the log (deduped by id) — the watermark read, decoupled from refresh's offset.
  deltasSince(knownIds: ReadonlySet<string>): Delta[] {
    if (!existsSync(this.filePath)) return [];
    const text = readFileSync(this.filePath, "utf8");
    const out: Delta[] = [];
    const emitted = new Set<string>();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      try {
        const parsed = JSON.parse(line) as { claims: unknown; sig?: string };
        const delta = makeDelta(parseClaims(parsed.claims), parsed.sig);
        if (knownIds.has(delta.id) || emitted.has(delta.id)) continue;
        emitted.add(delta.id);
        out.push(delta);
      } catch {
        // torn / partial line from a crashed writer — skip it, keep the rest.
      }
    }
    return out;
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
      const body = deltas.map(serialize).join("\n");
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

// The JSONL backend was the original `SharedStore`; the name survives as an alias so existing
// callers and tests read unchanged. New code constructs via `createBackend` (store-tier.ts).
export { JsonlStore as SharedStore };
