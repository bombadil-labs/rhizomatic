import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Peer, syncBoth } from "../src/peer.js";
import { makeManifestClaims } from "../src/reactor.js";
import { makeDelta } from "../src/set.js";
import { parseTerm } from "../src/term-json.js";
import { parsePred } from "../src/term-json.js";
import type { Claims } from "../src/types.js";

const seedA = "0a".repeat(32);
const seedB = "0b".repeat(32);

const claim = (timestamp: number, entity: string, context: string, value: string | number) =>
  ({
    timestamp,
    pointers: [
      { role: "subject", target: { kind: "entity", entity: { id: entity, context } } },
      { role: "value", target: { kind: "primitive", value } },
    ],
  }) as Omit<Claims, "author">;

describe("federation (SPEC-6, ERRATA-6)", () => {
  it("random fork pairs converge to union (the conformance property, §8)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 999 }), fc.string({ maxLength: 5 })), {
          maxLength: 8,
        }),
        fc.array(fc.tuple(fc.integer({ min: 1000, max: 1999 }), fc.string({ maxLength: 5 })), {
          maxLength: 8,
        }),
        (asClaims, bsClaims) => {
          const a = new Peer(seedA);
          const b = new Peer(seedB);
          asClaims.forEach(([ts, v], i) => a.authorClaims(claim(ts, `e${i}`, "ca", v)));
          bsClaims.forEach(([ts, v], i) => b.authorClaims(claim(ts, `e${i}`, "cb", v)));
          syncBoth(a, b);
          return (
            a.reactor.digest() === b.reactor.digest() &&
            a.reactor.size === asClaims.length + bsClaims.length
          );
        },
      ),
      { numRuns: 30 },
    );
  });

  it("sync is idempotent: re-syncing changes nothing", () => {
    const a = new Peer(seedA);
    const b = new Peer(seedB);
    a.authorClaims(claim(1, "x", "c", "one"));
    b.authorClaims(claim(2, "y", "c", "two"));
    syncBoth(a, b);
    const da = a.reactor.digest();
    const report = a.pullFrom(b);
    expect(report.accepted).toBe(0);
    expect(a.reactor.digest()).toBe(da);
  });

  it("lens fidelity: only the lens-matching subset is offered (selective sharing)", () => {
    const a = new Peer(
      seedA,
      parseTerm({
        op: "select",
        pred: { hasPointer: { targetEntity: "public:doc" } },
        in: "input",
      }),
    );
    const b = new Peer(seedB);
    a.authorClaims(claim(1, "public:doc", "title", "shared"));
    a.authorClaims(claim(2, "secret:doc", "title", "private"));
    b.pullFrom(a);
    expect(b.reactor.size).toBe(1);
    expect(b.reactor.byTarget("public:doc")).toHaveLength(1);
    expect(b.reactor.byTarget("secret:doc")).toHaveLength(0);
  });

  it("unsigned uncovered deltas are withheld at the boundary (F3)", () => {
    const a = new Peer(seedA);
    const unsigned = makeDelta({
      timestamp: 5,
      author: "did:key:zLocalOnly",
      pointers: [{ role: "note", target: { kind: "primitive", value: "stays home" } }],
    });
    expect(a.reactor.ingest(unsigned).status).toBe("accepted"); // legal locally
    a.authorClaims(claim(6, "e", "c", "travels"));
    const b = new Peer(seedB);
    const report = b.pullFrom(a);
    expect(report.withheld).toBe(1);
    expect(b.reactor.has(unsigned.id)).toBe(false);
    expect(b.reactor.size).toBe(1);
  });

  it("a signed manifest carries unsigned members across as a bundle (Merkle coverage)", () => {
    const a = new Peer(seedA);
    const member = makeDelta({
      timestamp: 7,
      author: "did:key:zUnsignedAuthor",
      pointers: [{ role: "note", target: { kind: "primitive", value: "covered" } }],
    });
    a.reactor.ingest(member);
    a.authorClaims(makeManifestClaims(a.author, 8, [member.id], { intent: "cover" }));
    const b = new Peer(seedB);
    const report = b.pullFrom(a);
    expect(report.bundles).toBe(1);
    expect(b.reactor.has(member.id)).toBe(true); // the unsigned member crossed, covered
    expect(b.reactor.holdsAllMembers(a.reactor.arrivalLog().at(-1)!.id)).toBe(true);
  });

  it("admission policy: a peer declines authors it does not admit (§5)", () => {
    const a = new Peer(seedA);
    a.authorClaims(claim(1, "e", "c", "from A"));
    const b = new Peer(
      seedB,
      undefined,
      parsePred({ not: { match: { field: "author", cmp: "eq", const: a.author } } }),
    );
    const report = b.pullFrom(a);
    expect(report.rejected).toBe(1);
    expect(b.reactor.size).toBe(0);
    // rejection is local: A is unaffected and still offers
    expect(a.reactor.size).toBe(1);
  });

  it("partition and heal: three peers converge through a relay", () => {
    const a = new Peer(seedA);
    const b = new Peer(seedB);
    const relay = new Peer("0c".repeat(32));
    a.authorClaims(claim(1, "ea", "c", "alpha"));
    b.authorClaims(claim(2, "eb", "c", "beta"));
    // a and b never talk directly — the relay carries claims both ways
    syncBoth(a, relay);
    syncBoth(b, relay);
    syncBoth(a, relay);
    expect(a.reactor.digest()).toBe(relay.reactor.digest());
    expect(a.reactor.size).toBe(2);
    expect(b.reactor.size).toBe(2);
  });
});
