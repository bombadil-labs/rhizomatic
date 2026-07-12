// The Rhizomatic reference demo: one continuous story exercising every layer of the stack.
// Run with `npm run demo` from implementations/ts. Every act prints what happened and which
// load-bearing principle (SPEC-0 §2) it demonstrates.

import {
  DerivationHost,
  Peer,
  Reactor,
  VOCAB_PREFIX,
  makeDelta,
  makeNegationClaims,
  packId,
  packSet,
  parseSchema,
  parseTerm,
  resolveView,
  syncBoth,
  unpackSet,
  type BindingSpec,
  type Claims,
  type DerivedFn,
  type HView,
  type Pointer,
  type Schema,
  type View,
} from "../src/index.js";

const out: string[] = [];
function say(line = ""): void {
  out.push(line);
}
function act(n: number, title: string, principle: string): void {
  say();
  say(`${"=".repeat(72)}`);
  say(`ACT ${n} — ${title}`);
  say(`  (${principle})`);
  say(`${"=".repeat(72)}`);
}

const MOVIE = "movie:blade_runner";

// The canonical schema body (amended idiom, ERRATA-3 S5): mask first, then select, then group.
const movieBody = parseTerm({
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
});
const auditBody = parseTerm({
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "annotate", in: "input" },
  },
});

const claim = (
  timestamp: number,
  entity: string,
  context: string,
  value: string | number,
): Omit<Claims, "author"> => ({
  timestamp,
  pointers: [
    { role: "movie", target: { kind: "entity", entity: { id: entity, context } } },
    { role: context, target: { kind: "primitive", value } },
  ],
});

function show(view: View): string {
  return JSON.stringify(view);
}

function resolveAt(reactor: Reactor, schema: Schema, root: string): View {
  const result = reactor.eval(movieBody, root);
  if (result.sort !== "hview") throw new Error("expected hview");
  return resolveView(schema, result.hview);
}

export function main(): string {
  // --- the cast -----------------------------------------------------------------------------
  const alice = new Peer("a1".repeat(32));
  const bob = new Peer("b2".repeat(32));
  const carol = new Peer("c3".repeat(32));

  say("RHIZOMATIC — the reference demo");
  say("Three sovereigns (Alice, Bob, Carol), one movie, zero central authority.");

  // === ACT 1 =================================================================================
  act(1, "Sovereign claims, held in superposition", "P1/P2: claims, not instructions; append-only");
  alice.authorClaims(claim(100, MOVIE, "title", "Blade Runner"));
  alice.authorClaims(claim(110, MOVIE, "director", "Ridley Scott"));
  const bobsDirector = bob.authorClaims(claim(200, MOVIE, "director", "Denis Villeneuve"));
  bob.authorClaims(claim(210, MOVIE, "year", 1982));
  syncBoth(alice, bob);
  say(`Alice claims director = "Ridley Scott"; Bob claims "Denis Villeneuve".`);
  say(`After sync both hold ${alice.reactor.size} deltas. Contradiction is not an error:`);
  say(`both claims coexist in superposition until a READER chooses how to collapse them.`);

  // === ACT 2 =================================================================================
  act(2, "Schemas are lenses: same data, different truths", "P5: pluralism is parameterized");
  const latest = parseSchema({ default: { pick: { order: { byTimestamp: "desc" } } } });
  const trustAlice = parseSchema({
    default: { pick: { order: { byAuthorRank: [alice.author, bob.author] } } },
  });
  const conflicts = parseSchema({
    props: { director: { conflicts: { order: { byTimestamp: "desc" } } } },
    default: { pick: { order: { byTimestamp: "desc" } } },
  });
  say(`latest-wins   -> ${show(resolveAt(alice.reactor, latest, MOVIE))}`);
  say(`trust-Alice   -> ${show(resolveAt(alice.reactor, trustAlice, MOVIE))}`);
  say(`conflicts-only-> ${show(resolveAt(alice.reactor, conflicts, MOVIE))}`);
  say(`Same HyperView, three deterministic truths. The machine never wobbles;`);
  say(`only the declared schema differs.`);

  // === ACT 3 =================================================================================
  act(3, "Retraction is a claim about a claim", "P2: negation suppresses, never erases");
  bob.authorClaims(makeNegationClaims(bob.author, 300, bobsDirector.id, "I was wrong"));
  syncBoth(alice, bob);
  say(`Bob negates his own director claim (reason: "I was wrong").`);
  say(`default view  -> ${show(resolveAt(alice.reactor, latest, MOVIE))}`);
  const audit = alice.reactor.eval(auditBody, MOVIE);
  if (audit.sort !== "hview") throw new Error("expected hview");
  const auditDirectors = (audit.hview.props.get("director") ?? []).map(
    (e) => `${e.negated ? "[retracted] " : ""}${JSON.stringify(valueOf(e.delta.claims))}`,
  );
  say(`audit view    -> director: ${auditDirectors.join(", ")}`);
  say(`The negated claim is suppressed from resolution but never erased — the audit`);
  say(`lens (mask annotate) shows the retraction with full provenance.`);

  // === ACT 4 =================================================================================
  act(4, "Time travel is a filter, not a feature", "P2: history is first-class");
  const asOf250 = parseTerm({
    op: "group",
    key: "byTargetContext",
    in: {
      op: "select",
      pred: { hasPointer: { targetEntity: { var: "root" } } },
      in: {
        op: "mask",
        policy: "drop",
        in: {
          op: "select",
          pred: { match: { field: "timestamp", cmp: "lte", const: 250 } },
          in: "input",
        },
      },
    },
  });
  const past = alice.reactor.eval(asOf250, MOVIE);
  if (past.sort !== "hview") throw new Error("expected hview");
  say(`The world as of t=250 (before Bob's retraction at t=300):`);
  say(`  -> ${show(resolveView(latest, past.hview))}`);
  say(`Claimed-time filtering reconstructs any past state from the same log.`);

  // === ACT 5 =================================================================================
  act(5, "Federation is union; sharing is a lens", "P1: merge = set union, sovereignty intact");
  carol.authorClaims(claim(400, MOVIE, "rating", 9));
  carol.authorClaims(claim(410, MOVIE, "rating", 8));
  carol.authorClaims(claim(420, "carol:diary", "note", "private thoughts"));
  carol.offeredLens = parseTerm({
    op: "select",
    pred: { hasPointer: { targetEntity: MOVIE } },
    in: "input",
  });
  const before = alice.reactor.size;
  syncBoth(alice, carol);
  syncBoth(bob, alice);
  say(`Carol was offline, authored 2 ratings + 1 private diary note, then federated`);
  say(`through a lens that shares only movie claims.`);
  say(`Alice gained ${alice.reactor.size - before} deltas; Carol's diary stayed home.`);
  say(`Alice digest == Bob digest: ${alice.reactor.digest() === bob.reactor.digest()}`);

  // === ACT 6 =================================================================================
  act(6, "Everything that computes is an author", "P4/L7: the write-back loop");
  const host = new DerivationHost(alice.reactor);
  alice.reactor.register("movie", movieBody, [MOVIE]);
  const avgFn: DerivedFn = (view: HView, root: string): Pointer[][] => {
    const nums = (view.props.get("rating") ?? [])
      .flatMap((e) => e.delta.claims.pointers)
      .filter((p) => p.target.kind === "primitive")
      .map((p) => (p.target as { value: unknown }).value)
      .filter((v): v is number => typeof v === "number");
    if (nums.length === 0) return [];
    return [
      [
        {
          role: "movie",
          target: { kind: "entity", entity: { id: root, context: "avgRating" } },
        },
        {
          role: "avgRating",
          target: { kind: "primitive", value: nums.reduce((a, b) => a + b, 0) / nums.length },
        },
      ],
    ];
  };
  const spec: BindingSpec = {
    name: "binding:avg",
    fnId: "fn:avgRating",
    materialization: "movie",
    pure: true,
    budget: 100,
    emit: "supersede",
  };
  const botAuthor = host.install(spec, avgFn, "d4".repeat(32));
  // a new rating arrives; the bot reacts, computes, signs, writes back
  host.ingest(makeDelta({ ...claim(500, MOVIE, "rating", 10), author: "did:key:zVisitor" }));
  const trustBot = parseSchema({
    props: { avgRating: { pick: { order: { byAuthorRank: [botAuthor] } } } },
    default: { pick: { order: { byTimestamp: "desc" } } },
  });
  const withBot = resolveAt(alice.reactor, trustBot, MOVIE) as Record<string, View>;
  const avgCandidate = withBot["avgRating"] as Record<string, View> | undefined;
  say(`A ratings bot (a derived author with its own keypair) watches the movie`);
  say(`materialization. A visitor rates 10; the bot recomputes the average, signs it,`);
  say(`and writes it back as an ordinary delta with provenance (by/from/under).`);
  say(
    `  title=${show(withBot["title"]!)} director=${show(withBot["director"]!)} avgRating=${show(avgCandidate?.["avgRating"] ?? "?")}`,
  );
  const derived = alice.reactor.eval(movieBody, MOVIE) as { sort: "hview"; hview: HView };
  const derivedEntry = (derived.hview.props.get("avgRating") ?? [])[0];
  const fromHex = derivedEntry?.delta.claims.pointers.find(
    (p) => p.role === `${VOCAB_PREFIX}.derived.from`,
  );
  say(`Provenance receipt: the bot's claim pins its exact input snapshot:`);
  say(
    `  ${VOCAB_PREFIX}.derived.from = ${String((fromHex?.target as { value?: unknown })?.value).slice(0, 24)}…`,
  );

  // === ACT 7 =================================================================================
  act(7, "The physical form is free; the logical form is sacred", "L0: packs");
  const snapshot = alice.reactor.snapshot();
  const bytes = packSet(snapshot);
  const restored = unpackSet(bytes);
  say(`Alice's entire world (${snapshot.size} deltas) packs to ${bytes.length} bytes.`);
  say(`packId = ${packId(bytes).slice(0, 24)}…`);
  say(`unpack -> digest match: ${restored.digest() === snapshot.digest()}`);
  say(`Burying this on a USB stick is a valid backup strategy — and, eventually,`);
  say(`a valid federation event.`);

  say();
  say(`${"=".repeat(72)}`);
  say(`Mushrooms versus towers, all the way down. It compiles.`);
  say(`${"=".repeat(72)}`);
  return out.join("\n");
}

function valueOf(claims: Claims): unknown {
  const p = claims.pointers.find((x) => x.target.kind === "primitive");
  return p?.target.kind === "primitive" ? p.target.value : undefined;
}

// Run directly (npm run demo); import { main } for the smoke test.
if (process.argv[1]?.endsWith("demo.ts")) {
  console.log(main());
}
