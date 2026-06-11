// Federation (SPEC-6, ERRATA-6): a peer is a reactor + keypair + offered lens + admission
// predicate. Merge is union; this layer is selection and trust. Coordination without conscription.

import { evalTerm, type Term } from "./eval.js";
import { evalPred, type Pred } from "./pred.js";
import { Reactor, manifestMemberIds, type IngestResult } from "./reactor.js";
import { authorForSeed, signClaims, verifyDelta } from "./sign.js";
import type { Claims, Delta } from "./types.js";

export interface SyncReport {
  readonly offered: number;
  readonly bundles: number;
  readonly loose: number;
  readonly withheld: number; // unsigned, uncovered: they stay local (F3)
  readonly accepted: number;
  readonly rejected: number;
}

const ALL: Term = { kind: "input" };

export class Peer {
  readonly reactor = new Reactor();
  readonly author: string;

  constructor(
    private readonly seedHex: string,
    // What this peer offers to others (F4). Default: everything.
    public offeredLens: Term = ALL,
    // What this peer accepts (SPEC-6 §5 step 3). Default: everything that verifies.
    public admission: Pred | undefined = undefined,
  ) {
    this.author = authorForSeed(seedHex);
  }

  // Author a claim as this peer: sign and ingest (read-your-writes).
  authorClaims(claims: Omit<Claims, "author">): Delta {
    const signed = signClaims({ ...claims, author: this.author }, this.seedHex);
    const result = this.reactor.ingest(signed);
    if (result.status === "rejected") throw new Error(`own claim rejected: ${result.reason}`);
    return signed;
  }

  // The admission judgment (SPEC-6 §5 step 3), exposed for transport bindings (F5).
  admits(d: Delta): boolean {
    return this.admission === undefined || evalPred(this.admission, d);
  }

  // The offered set: eval(lens, log) — lens fidelity is a tested invariant (F4).
  offeredSet(): Delta[] {
    const result = evalTerm(this.offeredLens, this.reactor.snapshot());
    if (result.sort !== "dset") throw new Error("a lens must be a DSet-sort term (F4)");
    return [...result.set];
  }

  // Pull from another peer: WANT(my ids) -> OFFER/BUNDLE -> verify -> admission -> ingest (§5).
  pullFrom(other: Peer): SyncReport {
    const have = new Set<string>();
    for (const d of this.reactor.arrivalLog()) have.add(d.id);

    const offered = other.offeredSet().filter((d) => !have.has(d.id));
    const offeredIds = new Set(offered.map((d) => d.id));

    // Partition per the signature boundary (F3): signed manifests carry their present members
    // as bundles; remaining signed deltas travel loose; unsigned uncovered are withheld.
    const isSignedManifest = (d: Delta) =>
      d.sig !== undefined && verifyDelta(d) === "verified" && manifestMemberIds(d).length > 0;
    const bundles: Array<{ manifest: Delta; members: Delta[] }> = [];
    const covered = new Set<string>();
    for (const m of offered.filter(isSignedManifest)) {
      const members = manifestMemberIds(m)
        .filter((id) => offeredIds.has(id))
        .map((id) => offered.find((d) => d.id === id)!)
        .filter((d) => !isSignedManifest(d));
      bundles.push({ manifest: m, members });
      for (const mem of members) covered.add(mem.id);
      covered.add(m.id);
    }
    const loose = offered.filter(
      (d) => !covered.has(d.id) && d.sig !== undefined && verifyDelta(d) === "verified",
    );
    const withheld = offered.length - covered.size - loose.length;

    let accepted = 0;
    let rejected = 0;
    const admit = (d: Delta): boolean => this.admits(d);
    const count = (r: IngestResult) => {
      if (r.status === "accepted") accepted += 1;
      else if (r.status === "rejected") rejected += 1;
    };

    for (const { manifest, members } of bundles) {
      // Admission applies to the act: if the manifest or any member fails, decline the bundle.
      if (![manifest, ...members].every(admit)) {
        rejected += 1 + members.length;
        continue;
      }
      count(this.reactor.ingestBundle(manifest, members));
    }
    for (const d of loose) {
      if (!admit(d)) {
        rejected += 1;
        continue;
      }
      count(this.reactor.ingest(d));
    }

    return {
      offered: offered.length,
      bundles: bundles.length,
      loose: loose.length,
      withheld,
      accepted,
      rejected,
    };
  }
}

// Anti-entropy both ways; repeat until quiescent (bounded — union is monotone).
export function syncBoth(a: Peer, b: Peer): void {
  for (let i = 0; i < 4; i++) {
    const before = a.reactor.digest() + b.reactor.digest();
    a.pullFrom(b);
    b.pullFrom(a);
    if (a.reactor.digest() + b.reactor.digest() === before) return;
  }
}
