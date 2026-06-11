import type { Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { pullFromUrl, servePeer } from "../src/http.js";
import { Peer } from "../src/peer.js";
import { makeManifestClaims } from "../src/reactor.js";
import { makeDelta } from "../src/set.js";
import { parseTerm } from "../src/term-json.js";
import type { Claims } from "../src/types.js";

const claim = (timestamp: number, entity: string, context: string, value: string | number) =>
  ({
    timestamp,
    pointers: [
      { role: "subject", target: { kind: "entity", entity: { id: entity, context } } },
      { role: "value", target: { kind: "primitive", value } },
    ],
  }) as Omit<Claims, "author">;

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

describe("the blessed HTTP binding (ERRATA-6 F5)", () => {
  it("two peers converge over real localhost HTTP", async () => {
    const alice = new Peer("a1".repeat(32));
    const bob = new Peer("b2".repeat(32));
    alice.authorClaims(claim(1, "doc:x", "title", "from Alice"));
    alice.authorClaims(claim(2, "doc:x", "tag", "alpha"));
    bob.authorClaims(claim(3, "doc:x", "tag", "beta"));

    servers.push(await servePeer(alice, 47361));
    servers.push(await servePeer(bob, 47362));

    // anti-entropy: each pulls from the other
    await pullFromUrl(bob, "http://127.0.0.1:47361");
    await pullFromUrl(alice, "http://127.0.0.1:47362");

    expect(alice.reactor.digest()).toBe(bob.reactor.digest());
    expect(alice.reactor.size).toBe(3);
    // pulling again is a no-op (idempotent by id)
    const again = await pullFromUrl(bob, "http://127.0.0.1:47361");
    expect(again.accepted).toBe(0);
  });

  it("bundles cross HTTP: a signed manifest carries an unsigned member", async () => {
    const a = new Peer("c3".repeat(32));
    const member = makeDelta({
      timestamp: 7,
      author: "did:key:zUnsigned",
      pointers: [{ role: "note", target: { kind: "primitive", value: "covered" } }],
    });
    a.reactor.ingest(member);
    a.authorClaims(makeManifestClaims(a.author, 8, [member.id], { intent: "cover" }));

    servers.push(await servePeer(a, 47363));
    const b = new Peer("d4".repeat(32));
    const report = await pullFromUrl(b, "http://127.0.0.1:47363");
    expect(report.accepted).toBeGreaterThan(0);
    expect(b.reactor.has(member.id)).toBe(true); // the unsigned member crossed, Merkle-covered
  });

  it("the lens applies on the wire and admission applies on receipt", async () => {
    const a = new Peer(
      "e5".repeat(32),
      parseTerm({
        op: "select",
        pred: { hasPointer: { targetEntity: "public:doc" } },
        in: "input",
      }),
    );
    a.authorClaims(claim(1, "public:doc", "title", "shared"));
    a.authorClaims(claim(2, "secret:doc", "title", "private"));
    servers.push(await servePeer(a, 47364));

    const b = new Peer("f6".repeat(32));
    await pullFromUrl(b, "http://127.0.0.1:47364");
    expect(b.reactor.size).toBe(1); // lens fidelity over HTTP
    expect(b.reactor.byTarget("secret:doc")).toHaveLength(0);
  });
});
