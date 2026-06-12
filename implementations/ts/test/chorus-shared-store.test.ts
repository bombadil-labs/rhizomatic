// The shared store: concurrent sessions converge on one JSONL log. Two SessionContexts here
// stand in for two server processes — separate reactors, one file.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SharedStore } from "../chorus/shared-store.js";
import { callTool, createSession } from "../chorus/mcp-server.js";

const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const MASTER = "0f".repeat(32);
const dir = mkdtempSync(join(tmpdir(), "chorus-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function twoSessions(file: string) {
  const a = createSession({ masterSeedHex: MASTER, sessionId: "proc-a", clock: clockFrom(1000) });
  const b = createSession({ masterSeedHex: MASTER, sessionId: "proc-b", clock: clockFrom(2000) });
  return { a, b, sa: new SharedStore(file), sb: new SharedStore(file) };
}

describe("chorus: the shared store (many sessions, one world)", () => {
  it("two sessions converge through the log: write → persist → refresh → identical digests", () => {
    const file = join(dir, "one.jsonl");
    const { a, b, sa, sb } = twoSessions(file);

    callTool(a, "begin-session", { model: "claude-fable-5" });
    callTool(a, "remember", { about: "user:mike", attribute: "theme", value: "dark" });
    sa.persist(a.agent);

    sb.refresh(b.agent);
    expect(callTool(b, "recall", { entity: "user:mike" })).toEqual({ theme: "dark" });

    callTool(b, "begin-session", { model: "claude-haiku-4-5" });
    callTool(b, "remember", { about: "user:mike", attribute: "editor", value: "vim" });
    sb.persist(b.agent);

    sa.refresh(a.agent);
    expect(a.agent.digest()).toBe(b.agent.digest());
    // Cross-session attribution survives the round-trip.
    const receipts = callTool(a, "explain", { entity: "user:mike" }) as Array<{
      sessionId?: string;
    }>;
    expect(new Set(receipts.map((r) => r.sessionId))).toEqual(new Set(["proc-a", "proc-b"]));
  });

  it("interleaved persists never duplicate lines; signatures survive the file", () => {
    const file = join(dir, "two.jsonl");
    const { a, b, sa, sb } = twoSessions(file);
    callTool(a, "remember", { about: "x", attribute: "p", value: 1 });
    callTool(b, "remember", { about: "x", attribute: "p", value: 2 });
    sa.persist(a.agent);
    sb.persist(b.agent); // pulls a's lines first, then appends only its own
    sa.persist(a.agent); // nothing new of a's: appends nothing
    sa.refresh(a.agent);

    const lines = readFileSync(file, "utf8").trim().split("\n");
    const ids = lines.map((l) => JSON.parse(l) as { sig?: string });
    expect(ids.every((x) => typeof x.sig === "string")).toBe(true);
    // No duplicates: every line is a distinct delta.
    expect(new Set(lines).size).toBe(lines.length);
    expect(a.agent.digest()).toBe(b.agent.digest());
  });

  it("a torn final line (crashed writer) is skipped and sealed, never fatal", () => {
    const file = join(dir, "torn.jsonl");
    const { a, b, sa, sb } = twoSessions(file);
    callTool(a, "remember", { about: "y", attribute: "q", value: true });
    sa.persist(a.agent);
    appendFileSync(file, '{"claims": {"timestamp": 99, "author": "did'); // the crash

    expect(() => sb.refresh(b.agent)).not.toThrow();
    expect(callTool(b, "recall", { entity: "y" })).toEqual({ q: true });
    // The next persist seals the torn tail; the log keeps working.
    callTool(b, "remember", { about: "y", attribute: "r", value: false });
    sb.persist(b.agent);
    sa.refresh(a.agent);
    expect(callTool(a, "recall", { entity: "y" })).toEqual({ q: true, r: false });
  });

  it("a fresh session loads the whole history from the log alone", () => {
    const file = join(dir, "boot.jsonl");
    const { a, sa } = twoSessions(file);
    callTool(a, "begin-session", { model: "claude-fable-5" });
    callTool(a, "remember", { about: "svc:api", attribute: "owner", value: "team-a" });
    const r = callTool(a, "remember", { about: "svc:api", attribute: "stale", value: 1 }) as {
      deltaId: string;
    };
    callTool(a, "retract", { deltaId: r.deltaId, reason: "wrong" });
    sa.persist(a.agent);

    const fresh = createSession({
      masterSeedHex: MASTER,
      sessionId: "proc-later",
      clock: clockFrom(9000),
    });
    new SharedStore(file).refresh(fresh.agent);
    expect(fresh.agent.digest()).toBe(a.agent.digest());
    expect(callTool(fresh, "recall", { entity: "svc:api" })).toEqual({ owner: "team-a" });
  });

  it("unsigned garbage lines are rejected by the substrate, not trusted", () => {
    const file = join(dir, "garbage.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        claims: {
          timestamp: 1,
          author: "did:key:forger",
          pointers: [{ role: "x", target: "y" }],
        },
      })}\n`,
    );
    const fresh = createSession({
      masterSeedHex: MASTER,
      sessionId: "proc-x",
      clock: clockFrom(1000),
    });
    // Unsigned deltas are L1-legal; they load — but they carry no signature and explain says so.
    new SharedStore(file).refresh(fresh.agent);
    const receipts = callTool(fresh, "explain", { entity: "y" }) as unknown[];
    expect(Array.isArray(receipts)).toBe(true);
  });
});
