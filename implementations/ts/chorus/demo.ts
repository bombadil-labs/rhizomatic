// The Chorus demo: agent memory where every belief is a signed claim. One continuous story,
// scripted and deterministic — run with `npm run chorus:demo` from implementations/ts.
// Receipts (authors, delta ids, input hashes) print at every step: nothing here is asserted
// without something you could verify.

import {
  ChorusAdjudicator,
  ChorusAgent,
  Librarian,
  MockEmbeddingModel,
  declareConcept,
  decide,
  everything,
  replayDecision,
  trustFirst,
  type Candidate,
} from "./index.js";

const out: string[] = [];
function say(line = ""): void {
  out.push(line);
}
const short = (id: string): string => `${id.slice(0, 14)}…`;

const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

export function main(): string {
  out.length = 0;
  say("CHORUS — memory for agents, built on Rhizomatic");
  say("════════════════════════════════════════════════");

  // ── ACT 1 · Voices ────────────────────────────────────────────────────────────────────────
  say();
  say("ACT 1 · Three voices, one substrate, no corruption");
  const hub = new ChorusAgent({ name: "hub", seedHex: "11".repeat(32), clock: clockFrom(1000) });
  const scoutA = new ChorusAgent({
    name: "scout-a",
    seedHex: "22".repeat(32),
    clock: clockFrom(2000),
  });
  const scoutK = new ChorusAgent({
    name: "scout-k",
    seedHex: "33".repeat(32),
    clock: clockFrom(3000),
  });
  say(`  hub     ${short(hub.author)}`);
  say(`  scout-a ${short(scoutA.author)}`);
  say(`  scout-k ${short(scoutK.author)}`);

  const adj = new ChorusAdjudicator(hub, {
    name: "health-adjudicator",
    seedHex: "44".repeat(32),
    subjects: ["svc:api", "svc:db"],
    attribute: "healthy",
    verdictAttribute: "verdict",
    judge: (cs: readonly Candidate[]) => {
      if (cs.length === 0) return undefined;
      const yes = cs.filter((c) => c.value === true).length;
      return yes > cs.length - yes; // majority; ties pessimistic
    },
  });

  scoutA.assert({ about: "svc:api", attribute: "healthy", value: true, source: "probe 200 OK" });
  const kClaim = scoutK.assert({
    about: "svc:api",
    attribute: "healthy",
    value: false,
    source: "probe timeout",
  });
  hub.importSet(scoutA.snapshot());
  hub.importSet(scoutK.snapshot());
  say(`  scout-a claims healthy=true   (${short(scoutA.snapshot().ids()[0]!)})`);
  say(`  scout-k claims healthy=false  (${short(kClaim.id)})`);
  say(
    `  superposition at hub: ${JSON.stringify(hub.recall("svc:api", { attribute: "healthy", policy: everything() }))}`,
  );
  say("  contradiction is data — neither voice overwrote the other.");

  // ── ACT 2 · The adjudicator ───────────────────────────────────────────────────────────────
  say();
  say("ACT 2 · Judgment is an author (keyed emission: one live verdict per subject)");
  const verdictReceipt = hub.explain("svc:api", "verdict").find((r) => !r.negated)!;
  const verdictDelta = hub.peer.reactor.get(verdictReceipt.deltaId)!;
  const fromHex = verdictDelta.claims.pointers.find((p) => p.role === "rhizomatic.derived.from");
  say(`  verdict: healthy=${String(verdictReceipt.value)} — tie broke pessimistic`);
  say(`    by     ${short(adj.author)} (the adjudicator's OWN keypair)`);
  say(`    id     ${short(verdictDelta.id)}`);
  say(
    `    from   ${short(fromHex?.target.kind === "primitive" ? String(fromHex.target.value) : "?")} (content address of the exact input view)`,
  );
  say(`    replay-verified: ${adj.verifyVerdict(verdictDelta, "svc:api")}`);

  // ── ACT 3 · The decision ─────────────────────────────────────────────────────────────────
  say();
  say("ACT 3 · A decision pins exactly what was known");
  hub.setPolicy(trustFirst([adj.author, hub.author]));
  const decision = decide(hub, {
    about: "svc:api",
    intent: "hold the deploy until the verdict flips",
    timestamp: 5000,
  });
  say(`  acted on view ${JSON.stringify(decision.view)} at t=${decision.asOf}`);
  say(
    `  decision ${short(decision.delta.id)} pins basis ${short(decision.basis)} + the policy held`,
  );

  // ── ACT 4 · Retraction, then replay ──────────────────────────────────────────────────────
  say();
  say("ACT 4 · Decision replay (the retraction is visible NOW, absent THEN)");
  scoutK.retract(kClaim.id, "timeout was our own misconfigured probe", 6000);
  hub.importSet(scoutK.snapshot());
  say(`  t=6000 scout-k retracts its claim (${short(kClaim.id)}) — retraction APPENDS`);
  const replay = replayDecision(hub, decision.delta.id);
  say(
    `  replay at t=${replay.asOf}: view ${JSON.stringify(replay.view)} — the now-retracted claim still counts THEN`,
  );
  say(`  basis verified byte-for-byte: ${replay.verified}`);
  say(`  retracted since the decision: ${replay.retractedSince.map(short).join(", ")}`);

  // ── ACT 5 · Retroactive distrust ─────────────────────────────────────────────────────────
  say();
  say("ACT 5 · Retroactive distrust (one edit, no deletion, no rebuild)");
  scoutK.assert({ about: "svc:db", attribute: "healthy", value: false, timestamp: 6100 });
  hub.importSet(scoutK.snapshot());
  say(
    `  before: svc:db ${JSON.stringify(hub.recall("svc:db", { attribute: "healthy" }))} (scout-k's word, latest wins)`,
  );
  const edit = hub.distrust(scoutK.author, "probe fleet compromised since Tuesday");
  hub.assert({ about: "svc:db", attribute: "healthy", value: true, timestamp: 6050 });
  say(`  hub demotes scout-k — the edit is itself a signed claim ${short(edit.id)}`);
  say(
    `  after:  svc:db ${JSON.stringify(hub.recall("svc:db", { attribute: "healthy" }))} (corroborable voices outrank)`,
  );
  const kHistory = hub
    .explain("svc:db", "healthy")
    .filter((r) => r.author === scoutK.author).length;
  say(`  scout-k's history: ${kHistory} claim(s) still queryable — what the postmortem needs`);

  // ── ACT 6 · The librarian ────────────────────────────────────────────────────────────────
  say();
  say("ACT 6 · Meaning under dispute (the librarian + the alias closure)");
  declareConcept(hub, "concept:employment", ["worker", "organization"]);
  const librarian = new Librarian(hub, {
    name: "librarian-v1",
    seedHex: "66".repeat(32),
    model: new MockEmbeddingModel("mock-embed-v1", {
      organization: [1, 0],
      worker: [0, 1],
      employer: [0.97, 0.05],
      job: [0.9, 0.1],
      staff: [0.08, 0.97],
      employees: [0.03, 0.99],
    }),
  });
  const appA = new ChorusAgent({ name: "app-a", seedHex: "77".repeat(32), clock: clockFrom(7000) });
  appA.assert({
    about: "person:ada",
    attribute: "employer",
    value: { entity: "company:acme", context: "employees" },
  });
  const appB = new ChorusAgent({ name: "app-b", seedHex: "88".repeat(32), clock: clockFrom(8000) });
  appB.assert({
    about: "person:bob",
    attribute: "job",
    value: { entity: "company:initech", context: "staff" },
  });
  hub.importSet(appA.snapshot());
  hub.importSet(appB.snapshot());
  const mappings = [...hub.snapshot()].filter((d) =>
    d.claims.pointers.some((p) => p.role === "rhizomatic.alias.fragment"),
  );
  say(
    `  two dialects arrive; the librarian (${short(librarian.author)}) emits ${mappings.length} signed mapping claims`,
  );
  for (const m of mappings) {
    const frag = m.claims.pointers.find((p) => p.role === "rhizomatic.alias.fragment");
    const conf = m.claims.pointers.find((p) => p.role === "rhizomatic.alias.confidence");
    say(
      `    "${frag?.target.kind === "primitive" ? String(frag.target.value) : "?"}" → slot, conf ${conf?.target.kind === "primitive" ? String(conf.target.value) : "?"} (${short(m.id)})`,
    );
  }
  const bobAnswer = hub.recall("person:bob", {
    attribute: "employer",
    aliasedVia: "concept:employment",
  });
  say(`  ask in A's dialect about bob (B's data): ${JSON.stringify(bobAnswer)}`);
  say(
    "  recall crossed the dialect; the answer kept bob's own vocabulary. No migration, no meeting.",
  );

  say();
  say("════════════════════════════════════════════════");
  say("Every belief attributable. Every revision additive. Every decision replayable.");
  say("Trust is a lens. Meaning is negotiable. History is not.");
  return out.join("\n");
}

// Direct run: print the transcript.
if (
  process.argv[1] !== undefined &&
  process.argv[1].replace(/\\/g, "/").endsWith("chorus/demo.ts")
) {
  console.log(main());
}
