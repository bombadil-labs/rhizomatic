// Chorus trust dynamics (Phase 2): the adjudicator as a derived author with keyed emission,
// DECISION REPLAY, and RETROACTIVE DISTRUST — the three set pieces, scripted and deterministic.

import { describe, expect, it } from "vitest";
import { VOCAB_PREFIX } from "@bombadil/rhizomatic";
import {
  ChorusAdjudicator,
  ChorusAgent,
  decide,
  replayDecision,
  trustFirst,
  type Candidate,
} from "../src/index.js";

const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const SEED_A = "11".repeat(32);
const SEED_K = "22".repeat(32);
const SEED_J = "44".repeat(32);

const mkAgent = (name: string, seed: string, t0: number) =>
  new ChorusAgent({ name, seedHex: seed, clock: clockFrom(t0) });

// Majority vote; ties resolve pessimistically (false wins).
const majority = (candidates: readonly Candidate[]) => {
  if (candidates.length === 0) return undefined;
  const yes = candidates.filter((c) => c.value === true).length;
  return yes > candidates.length - yes;
};

describe("chorus: the adjudicator (derived author + keyed emission)", () => {
  it("emits one live verdict per subject; new testimony supersedes only that subject's", () => {
    const hub = mkAgent("hub", SEED_A, 1000);
    const adj = new ChorusAdjudicator(hub, {
      name: "health-adjudicator",
      seedHex: SEED_J,
      subjects: ["svc:api", "svc:db"],
      attribute: "healthy",
      verdictAttribute: "verdict",
      judge: majority,
    });

    // Two witnesses disagree about svc:api; one speaks about svc:db.
    const k = mkAgent("K", SEED_K, 2000);
    k.assert({ about: "svc:api", attribute: "healthy", value: false });
    k.assert({ about: "svc:db", attribute: "healthy", value: true });
    hub.importSet(k.snapshot()); // testimony arrives through the write-back loop
    hub.assert({ about: "svc:api", attribute: "healthy", value: true });

    // The adjudicator's verdicts are signed claims by ITS OWN author, filed at each subject.
    const trustAdj = trustFirst([adj.author]);
    // svc:api — 1 yes vs 1 no → pessimistic false.
    expect(hub.recall("svc:api", { attribute: "verdict", policy: trustAdj })).toEqual({
      verdict: false,
    });
    // svc:db — uncontested true; ITS verdict was untouched by svc:api traffic (keyed emission).
    expect(hub.recall("svc:db", { attribute: "verdict", policy: trustAdj })).toEqual({
      verdict: true,
    });

    // A second yes for svc:api flips the majority: the prior verdict is superseded by a
    // self-authored negation, never edited.
    const a2 = mkAgent("A2", "55".repeat(32), 3000);
    a2.assert({ about: "svc:api", attribute: "healthy", value: true });
    hub.importSet(a2.snapshot());
    expect(hub.recall("svc:api", { attribute: "verdict", policy: trustAdj })).toEqual({
      verdict: true,
    });
    // History intact: every superseded verdict is still in the log, negated — one per
    // adjudication round (the false verdict re-pinned to a new input hash, then the flip).
    const receipts = hub.explain("svc:api", "verdict");
    expect(receipts.filter((r) => r.negated)).toHaveLength(2);
    expect(receipts.filter((r) => !r.negated)).toHaveLength(1);
    // svc:db's verdict still stands — exactly one live verdict per subject.
    expect(hub.explain("svc:db", "verdict").filter((r) => !r.negated)).toHaveLength(1);
  });

  it("verdicts carry replay-verifiable provenance (by/from/under)", () => {
    const hub = mkAgent("hub", SEED_A, 1000);
    const adj = new ChorusAdjudicator(hub, {
      name: "verdict-bot",
      seedHex: SEED_J,
      subjects: ["svc:api"],
      attribute: "healthy",
      verdictAttribute: "verdict",
      judge: majority,
    });
    hub.assert({ about: "svc:api", attribute: "healthy", value: true });

    const verdictReceipt = hub.explain("svc:api", "verdict").find((r) => !r.negated)!;
    const verdict = hub.peer.reactor.get(verdictReceipt.deltaId)!;
    expect(verdict.claims.author).toBe(adj.author);
    const roles = verdict.claims.pointers.map((p) => p.role);
    expect(roles).toContain(`${VOCAB_PREFIX}.derived.by`);
    expect(roles).toContain(`${VOCAB_PREFIX}.derived.from`);
    expect(roles).toContain(`${VOCAB_PREFIX}.derived.under`);
    // Genuine: replay the judge over the pinned input view, recompute the content address.
    expect(adj.verifyVerdict(verdict, "svc:api")).toBe(true);
    // Tampered: a forged claim with the same shape but a different value must fail replay.
    const forged = {
      ...verdict,
      claims: {
        ...verdict.claims,
        pointers: verdict.claims.pointers.map((p) =>
          p.role === "chorus.belief.value"
            ? { ...p, target: { kind: "primitive" as const, value: false } }
            : p,
        ),
      },
    };
    expect(adj.verifyVerdict(forged, "svc:api")).toBe(false);
  });
});

describe("chorus: decision replay (the incident review as a query)", () => {
  it("replays the exact belief set and policy; the later retraction is visible, not erased", () => {
    const a = mkAgent("A", SEED_A, 1000);
    const k = mkAgent("K", SEED_K, 2000);
    k.assert({ about: "deploy:42", attribute: "approved", value: true, source: "CI green" });
    a.importSet(k.snapshot());

    // t=3000: A acts on K's approval (explicit instant — claimed time, SPEC-1 §6).
    const decision = decide(a, { about: "deploy:42", intent: "ship build 42", timestamp: 3000 });
    expect(decision.view).toEqual({ approved: true });

    // Later (t=4000), K's approval turns out to be wrong and is retracted (by K, synced to A).
    const approval = k.snapshot().ids()[0]!;
    k.retract(approval, "CI was green on a stale commit", 4000);
    a.importSet(k.snapshot());
    // Today's view: no approval survives.
    expect(a.recall("deploy:42")).toEqual({});

    // The replay: what did A know at the moment it acted?
    const replay = replayDecision(a, decision.delta.id);
    expect(replay.view).toEqual({ approved: true }); // the retracted claim WAS the truth then
    expect(replay.verified).toBe(true); // basis reproduced byte-for-byte
    expect(replay.intent).toBe("ship build 42");
    // The receipt marks what happened since: visible then, negated afterwards.
    expect(replay.retractedSince).toEqual([approval]);
    const r = replay.receipts.find((x) => x.deltaId === approval)!;
    expect(r.negated).toBe(true);
    expect(r.value).toBe(true);
  });

  it("replay re-resolves under the PINNED policy, not the agent's current one", () => {
    const a = mkAgent("A", SEED_A, 1000);
    const k = mkAgent("K", SEED_K, 2000);
    a.assert({ about: "host:db1", attribute: "status", value: "degraded" });
    a.importSet(k.snapshot());
    k.assert({ about: "host:db1", attribute: "status", value: "ok" });
    a.importSet(k.snapshot());

    // A trusted K first when it acted.
    a.setPolicy(trustFirst([k.author, a.author]));
    const d = decide(a, { about: "host:db1", intent: "skip failover", timestamp: 3000 });
    expect(d.view).toEqual({ status: "ok" });

    // A's policy changes afterwards (it now trusts itself first) — the replay must not drift.
    a.setPolicy(trustFirst([a.author, k.author]));
    expect(a.recall("host:db1")).toEqual({ status: "degraded" });
    const replay = replayDecision(a, d.delta.id);
    expect(replay.view).toEqual({ status: "ok" });
    expect(replay.verified).toBe(true);
  });
});

describe("chorus: retroactive distrust (first-class)", () => {
  it("one signed edit demotes an author; corroborated beliefs stand; history survives", () => {
    const a = mkAgent("A", SEED_A, 1000);
    const k = mkAgent("K", SEED_K, 2000);
    // K's solo testimony on one fact; corroborated agreement on another.
    k.assert({ about: "svc:api", attribute: "owner", value: "team-poison" });
    k.assert({ about: "svc:api", attribute: "region", value: "us-east" });
    a.assert({ about: "svc:api", attribute: "owner", value: "team-real" });
    a.assert({ about: "svc:api", attribute: "region", value: "us-east" });
    a.importSet(k.snapshot());

    // Before: last-claim-wins lets K's later claims through.
    expect(a.recall("svc:api", { attribute: "owner" })).toEqual({ owner: "team-poison" });

    // K turns out to have been poisoned since Tuesday. ONE edit, to A's own data:
    const edit = a.distrust(k.author, "poisoned model");
    expect(edit.sig).toBeDefined(); // the trust edit is itself a signed, auditable claim

    // Beliefs downstream of K re-resolve instantly; the corroborated one stands.
    expect(a.recall("svc:api", { attribute: "owner" })).toEqual({ owner: "team-real" });
    expect(a.recall("svc:api", { attribute: "region" })).toEqual({ region: "us-east" });

    // No deletion: K's full claim history remains queryable — what the postmortem needs.
    const receipts = a.explain("svc:api", "owner");
    expect(receipts.map((r) => r.author)).toContain(k.author);
    expect(receipts.every((r) => !r.negated)).toBe(true);
    expect(a.distrusts(k.author)).toBe(true);

    // Where ONLY the distrusted author ever spoke, its claim still surfaces (ranked last,
    // never erased): trust is a lens, not a delete button.
    k.assert({ about: "svc:cache", attribute: "owner", value: "team-k" });
    a.importSet(k.snapshot());
    expect(a.recall("svc:cache", { attribute: "owner" })).toEqual({ owner: "team-k" });
  });
});
