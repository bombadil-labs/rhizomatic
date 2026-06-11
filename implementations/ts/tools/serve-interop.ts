// Cross-implementation interop server: a TS peer with seeded claims, served over the blessed
// HTTP binding (F5). Prints its own digest so the Rust client (examples/http_sync.rs) can be
// checked against it byte-for-byte. Run: npx tsx tools/serve-interop.ts [port]
import { servePeer } from "../src/http.js";
import { Peer } from "../src/peer.js";
import { makeManifestClaims } from "../src/reactor.js";
import { makeDelta } from "../src/set.js";
import type { Claims } from "../src/types.js";

const port = Number(process.argv[2] ?? 47390);
const peer = new Peer("11".repeat(32));

const claim = (timestamp: number, entity: string, context: string, value: string | number) =>
  ({
    timestamp,
    pointers: [
      { role: "subject", target: { kind: "entity", entity: { id: entity, context } } },
      { role: "value", target: { kind: "primitive", value } },
    ],
  }) as Omit<Claims, "author">;

peer.authorClaims(claim(1, "movie:blade_runner", "title", "Blade Runner"));
peer.authorClaims(claim(2, "movie:blade_runner", "year", 1982));
peer.authorClaims(claim(3, "movie:blade_runner", "rating", 8.7));
// a signed manifest covering an unsigned member: exercises the bundle path cross-impl
const member = makeDelta({
  timestamp: 4,
  author: "did:key:zUnsignedLocal",
  pointers: [{ role: "note", target: { kind: "primitive", value: "covered across impls" } }],
});
peer.reactor.ingest(member);
peer.authorClaims(makeManifestClaims(peer.author, 5, [member.id], { intent: "interop bundle" }));

await servePeer(peer, port);
console.log(`serving on http://127.0.0.1:${port}`);
console.log(`count=${peer.reactor.size}`);
console.log(`digest=${peer.reactor.digest()}`);
