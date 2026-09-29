/** Pin mixed ordinary/erasure/purge frame bytes and the reconstructed durable ledger. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contentAddress } from "../src/delta/hash.js";
import { parseClaims, claimsToJson } from "../src/delta/json-profile.js";
import { signClaims, authorForSeed } from "../src/delta/sign.js";
import type { Delta } from "../src/delta/types.js";
import { encodeDurablePeerState } from "../src/federation/durable-state.js";
import { encodeOrdinaryPeerFrame } from "../src/federation/ordinary-journal.js";
import {
  encodePermanentPeerFrame,
  replayPermanentPeerFrames,
} from "../src/federation/permanent-journal.js";

const evidence = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/principal/evidence.json", import.meta.url)),
    "utf8",
  ),
) as { deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }> };
const firstRow = evidence.deltas.find((row) => row.name === "userRootDeclaration")!;
const first: Delta = {
  id: firstRow.id,
  claims: parseClaims(firstRow.claims),
  sig: firstRow.sig!,
};
const seed = "01".repeat(32);
const peerId = authorForSeed(seed);
const order = signClaims(
  {
    timestamp: 101,
    validFrom: 101,
    author: peerId,
    pointers: [{ role: "erases", target: { kind: "delta", deltaRef: { delta: first.id } } }],
  },
  seed,
);
const ordinary = encodeOrdinaryPeerFrame({
  peerId,
  prior: "",
  at: 100,
  sender: "local",
  additions: [first],
});
const ordinaryHead = contentAddress(ordinary);
const erasure = encodePermanentPeerFrame({
  kind: "admission",
  peerId,
  prior: ordinaryHead,
  at: 101,
  sender: "local",
  additions: [order],
  erasures: [{ targetId: first.id, orderIds: [order.id], surfaceHoldsBytes: true }],
  quotaCharge: 0,
});
const erasureHead = contentAddress(erasure);
const purge = encodePermanentPeerFrame({
  kind: "purge",
  peerId,
  prior: erasureHead,
  targetId: first.id,
  generation: 1,
  status: "removed",
});
const purgeHead = contentAddress(purge);
const advance = encodePermanentPeerFrame({
  kind: "admission",
  peerId,
  prior: "",
  at: 101,
  sender: "local",
  additions: [order],
  erasures: [{ targetId: first.id, orderIds: [order.id], surfaceHoldsBytes: false }],
  quotaCharge: 0,
});
const advanceHead = contentAddress(advance);
const advanceState = replayPermanentPeerFrames(peerId, [advance], advanceHead);
const pending = replayPermanentPeerFrames(peerId, [ordinary, erasure], erasureHead);
const removed = replayPermanentPeerFrames(peerId, [ordinary, erasure, purge], purgeHead);
const file = fileURLToPath(
  new URL("../../../vectors/peer/permanent-journal.json", import.meta.url),
);
writeFileSync(
  file,
  JSON.stringify(
    {
      spec: "SPEC-6 vNext §2 permanent refusal and purge journal",
      description:
        "An ordinary holding, signed effective order, and physical-absence report form one mixed canonical chain. A purge report is only appended after the backend verifies absence.",
      peerId,
      targetName: "userRootDeclaration",
      order: { id: order.id, sig: order.sig, claims: claimsToJson(order.claims) },
      frames: [
        { kind: "ordinary", hex: Buffer.from(ordinary).toString("hex"), head: ordinaryHead },
        { kind: "admission", hex: Buffer.from(erasure).toString("hex"), head: erasureHead },
        { kind: "purge", hex: Buffer.from(purge).toString("hex"), head: purgeHead },
      ],
      pendingImageHex: Buffer.from(encodeDurablePeerState(pending)).toString("hex"),
      removedImageHex: Buffer.from(encodeDurablePeerState(removed)).toString("hex"),
      advance: {
        hex: Buffer.from(advance).toString("hex"),
        head: advanceHead,
        imageHex: Buffer.from(encodeDurablePeerState(advanceState)).toString("hex"),
        limitedStatus: "erasure-limit",
      },
      expected: {
        refusedTarget: first.id,
        orderId: order.id,
        priorEpoch: 1,
        obligationSequence: 1,
        generation: 1,
      },
      brokenChainError: "permanent journal: broken frame chain",
      missingObligationError: "permanent journal: no live purge obligation",
      signedTargetError: "permanent journal: effective order target is not signed",
    },
    null,
    2,
  ) + "\n",
);
