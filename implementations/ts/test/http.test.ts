import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { claimsToJson } from "../src/json-profile.js";
import { authorForSeed, signClaims } from "../src/sign.js";
import { pullFromUrl, servePeer } from "../src/http.js";
import { Peer } from "../src/peer.js";
import { makeManifestClaims } from "../src/reactor.js";
import { makeDelta } from "../src/set.js";
import { parseTerm } from "../src/term-json.js";
import type { Claims } from "../src/types.js";

const claim = (timestamp: number, entity: string, context: string, value: string | number) =>
  ({
    timestamp,
    validFrom: timestamp,
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
      validFrom: 7,
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

// One wire offer, served from 127.0.0.1 on a free port. Mirrors `serve_offer` of
// ../rust/tests/http.rs: the same offers and the same expected counts.
async function pullOffer(body: unknown): Promise<{ accepted: number; rejected: number }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await pullFromUrl(new Peer("b2".repeat(32)), `http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const SEED_A = "a1".repeat(32);
const REF = `1e20${"ab".repeat(32)}`;
const AUTHOR_A = authorForSeed(SEED_A);
const note = (timestamp: number, value: string): Claims => ({
  timestamp,
  validFrom: timestamp,
  author: AUTHOR_A,
  pointers: [{ role: "note", target: { kind: "primitive", value } }],
});
const signedEntry = (value: string, timestamp: number) => {
  const delta = signClaims(note(timestamp, value), SEED_A);
  return { claims: claimsToJson(delta.claims), sig: delta.sig };
};

describe("a malformed wire entry is one rejection, and the pull goes on (as Rust)", () => {
  it("each malformed loose entry between two good ones gives accepted 2, rejected 1", async () => {
    const [one, two, three] = [
      signedEntry("one", 1),
      signedEntry("two", 2),
      signedEntry("three", 3),
    ];
    const bad = [
      { claims: three.claims, sig: null },
      { claims: three.claims, sig: 5 },
      { claims: three.claims, sig: three.sig, extra: 1 },
      { claims: {}, sig: three.sig },
      "not an entry",
    ];
    const counts = [];
    for (const entry of bad)
      counts.push(await pullOffer({ bundles: [], loose: [one, entry, two] }));
    expect(counts).toEqual(bad.map(() => ({ accepted: 2, rejected: 1 })));
  });

  it("a bundle member whose wire sig is null is one rejection, not an unsigned member", async () => {
    const member = makeDelta(note(4, "member"));
    const manifest = signClaims(makeManifestClaims(AUTHOR_A, 5, [member.id]), SEED_A);
    const offer = (wireMember: unknown) => ({
      bundles: [
        {
          manifest: { claims: claimsToJson(manifest.claims), sig: manifest.sig },
          members: [wireMember],
        },
      ],
      loose: [signedEntry("one", 1), signedEntry("two", 2)],
    });
    const memberClaims = claimsToJson(member.claims);
    expect([
      await pullOffer(offer({ claims: memberClaims, sig: null })),
      await pullOffer(offer({ claims: memberClaims })),
    ]).toEqual([
      { accepted: 2, rejected: 1 },
      { accepted: 3, rejected: 0 },
    ]);
  });

  it("a bundle whose members is not a list is one rejection, and the pull goes on", async () => {
    const manifest = signClaims(makeManifestClaims(AUTHOR_A, 5, [REF]), SEED_A);
    const wireManifest = { claims: claimsToJson(manifest.claims), sig: manifest.sig };
    const offer = (bundle: object) => ({
      bundles: [bundle],
      loose: [signedEntry("one", 1), signedEntry("two", 2)],
    });
    const counts = [];
    for (const members of ["bad", 5, null, {}])
      counts.push(await pullOffer(offer({ manifest: wireManifest, members })));
    counts.push(await pullOffer(offer({ manifest: wireManifest })));
    expect(counts).toEqual([1, 2, 3, 4, 5].map(() => ({ accepted: 2, rejected: 1 })));
  });
});
