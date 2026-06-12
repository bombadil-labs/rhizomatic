// Chorus core: scripted multi-agent memory, deterministic in CI. Two sovereign agents share a
// substrate by sync; each resolves its own truth; retraction appends; the past stays queryable.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ChorusAgent, latest, restore, savePack, trustFirst } from "../chorus/index.js";

// Deterministic clocks: each agent claims times from its own fixed sequence.
const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const SEED_A = "11".repeat(32);
const SEED_K = "22".repeat(32);
const SEED_H = "33".repeat(32);

const mkAgent = (name: string, seed: string, t0: number) =>
  new ChorusAgent({ name, seedHex: seed, clock: clockFrom(t0) });

describe("chorus: the agent handle (keypair + reactor + policy)", () => {
  it("read-your-writes: an asserted belief is immediately recallable", () => {
    const a = mkAgent("A", SEED_A, 1000);
    a.assert({ about: "service:api", attribute: "deploy_ok", value: true, kind: "fact" });
    expect(a.recall("service:api")).toEqual({ deploy_ok: true });
  });

  it("beliefs are signed claims by the agent's keypair", () => {
    const a = mkAgent("A", SEED_A, 1000);
    const d = a.assert({ about: "user:mike", attribute: "theme", value: "dark" });
    expect(d.sig).toBeDefined();
    expect(d.claims.author).toBe(a.author);
    expect(d.claims.author.startsWith("ed25519:")).toBe(true);
  });

  it("two agents disagree without corrupting each other (one substrate, two truths)", () => {
    const a = mkAgent("A", SEED_A, 1000);
    const k = mkAgent("K", SEED_K, 2000);
    a.assert({ about: "service:api", attribute: "deploy_ok", value: false, kind: "fact" });
    k.assert({ about: "service:api", attribute: "deploy_ok", value: true, kind: "fact" });
    a.sync(k);
    // Identical substrates…
    expect(a.digest()).toBe(k.digest());
    // …different sovereign truths, by policy (P5: pluralism above the read boundary).
    a.setPolicy(trustFirst([a.author, k.author]));
    k.setPolicy(trustFirst([k.author, a.author]));
    expect(a.recall("service:api")).toEqual({ deploy_ok: false });
    expect(k.recall("service:api")).toEqual({ deploy_ok: true });
    // The superposition is intact underneath both.
    expect(a.recallAll("service:api")).toEqual({ deploy_ok: [false, true] });
  });

  it("retraction appends — recall hides, explain keeps the receipt", () => {
    const a = mkAgent("A", SEED_A, 1000);
    const wrong = a.assert({ about: "user:mike", attribute: "city", value: "Boston" });
    a.assert({ about: "user:mike", attribute: "city", value: "Denver" });
    a.retract(wrong.id, "moved years ago");
    expect(a.recall("user:mike")).toEqual({ city: "Denver" });
    const receipts = a.explain("user:mike", "city");
    expect(receipts).toHaveLength(2);
    const retracted = receipts.find((r) => r.deltaId === wrong.id)!;
    expect(retracted.negated).toBe(true);
    expect(retracted.value).toBe("Boston");
    expect(retracted.signed).toBe(true);
    // The negation did not erase: the log grew (2 beliefs + 1 negation).
    expect([...a.snapshot()].length).toBe(3);
  });

  it("asOf resolves the past as it was — a later negation does not reach back", () => {
    const a = mkAgent("A", SEED_A, 1000);
    // t=1010 asserted; t=1020 second value; t=1030 negation of the first.
    const first = a.assert({ about: "task:42", attribute: "status", value: "in-progress" });
    a.assert({ about: "task:42", attribute: "status", value: "blocked" });
    a.retract(first.id, "stale");
    // Now: latest surviving value.
    expect(a.recall("task:42")).toEqual({ status: "blocked" });
    // At t=1010: the claim that was later retracted was THE truth, and must resolve again.
    expect(a.recall("task:42", { asOf: 1010 })).toEqual({ status: "in-progress" });
    // At t=1015 (before the negation, before the second claim): same.
    expect(a.recall("task:42", { asOf: 1015 })).toEqual({ status: "in-progress" });
  });

  it("attribute narrowing and entity-valued beliefs", () => {
    const a = mkAgent("A", SEED_A, 1000);
    a.assert({ about: "user:mike", attribute: "theme", value: "dark", kind: "preference" });
    a.assert({
      about: "user:mike",
      attribute: "employer",
      value: { entity: "org:acme", context: "staff" },
      kind: "fact",
    });
    expect(a.recall("user:mike", { attribute: "theme" })).toEqual({ theme: "dark" });
    // Entity values render as their id in a View (SPEC-5 §2.1).
    expect(a.recall("user:mike", { attribute: "employer" })).toEqual({ employer: "org:acme" });
    // …and the belief files at the VALUE entity too, under the granted context (SPEC-1 §2.3).
    expect(a.recall("org:acme")).toEqual({ staff: "user:mike" });
  });

  it("explain carries kind, confidence, and source receipts", () => {
    const a = mkAgent("A", SEED_A, 1000);
    a.assert({
      about: "paper:42",
      attribute: "verdict",
      value: "sound",
      kind: "observation",
      confidence: 0.85,
      source: "reviewed methods section",
    });
    const [r] = a.explain("paper:42", "verdict");
    expect(r).toMatchObject({
      kind: "observation",
      confidence: 0.85,
      source: "reviewed methods section",
      negated: false,
    });
  });

  it("policies are validated at the edge", () => {
    const a = mkAgent("A", SEED_A, 1000);
    expect(() => a.setPolicy({ default: { pick: "nope" } })).toThrow();
    expect(() => a.setPolicy(latest())).not.toThrow();
  });
});

describe("chorus: persistence (pack to disk)", () => {
  const dir = mkdtempSync(join(tmpdir(), "chorus-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("an agent's world round-trips through one self-verifying pack file", () => {
    const a = mkAgent("A", SEED_A, 1000);
    const k = mkAgent("K", SEED_K, 2000);
    a.assert({ about: "service:api", attribute: "deploy_ok", value: false });
    k.assert({ about: "service:api", attribute: "deploy_ok", value: true });
    a.sync(k);
    const wrong = a.assert({ about: "service:api", attribute: "owner", value: "team-x" });
    a.retract(wrong.id, "reorg");

    const file = join(dir, "a.rhizome.pack");
    const id1 = savePack(a, file);

    // A fresh agent (different keypair!) restores the same world: memory is portable.
    const h = mkAgent("H", SEED_H, 9000);
    const report = restore(h, file);
    expect(report.rejected).toBe(0);
    expect(h.digest()).toBe(a.digest());
    expect(h.recall("service:api", { attribute: "owner" })).toEqual({});

    // Determinism: saving the restored world reproduces the same packId.
    const id2 = savePack(h, join(dir, "h.rhizome.pack"));
    expect(id2).toBe(id1);
  });
});

describe("chorus: trust is an editable lens (retroactive distrust, the static half)", () => {
  it("demoting an author re-resolves the world; history stays intact", () => {
    const a = mkAgent("A", SEED_A, 1000);
    const k = mkAgent("K", SEED_K, 2000);
    a.assert({ about: "host:db1", attribute: "healthy", value: true, kind: "observation" });
    k.assert({ about: "host:db1", attribute: "healthy", value: false, kind: "observation" });
    a.sync(k);

    // A initially trusts K's fresher telemetry style: latest wins → K's claim (t=2010 > 1010).
    a.setPolicy(latest());
    expect(a.recall("host:db1")).toEqual({ healthy: false });

    // K turns out to be poisoned. One edit to A's OWN data — no deletion, no rebuild.
    a.setPolicy(trustFirst([a.author]));
    expect(a.recall("host:db1")).toEqual({ healthy: true });

    // K's full claim history remains queryable — precisely what the postmortem needs.
    const receipts = a.explain("host:db1", "healthy");
    expect(receipts.map((r) => r.author)).toContain(k.author);
    expect(receipts).toHaveLength(2);
  });
});
