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
  encodePermanentJournalRebase,
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
const unrelatedRow = evidence.deltas.find((row) => row.name === "operatorRootDeclaration")!;
const unrelated: Delta = {
  id: unrelatedRow.id,
  claims: parseClaims(unrelatedRow.claims),
  sig: unrelatedRow.sig!,
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
const conflictingOrder = signClaims(
  {
    timestamp: 103,
    validFrom: 103,
    author: peerId,
    pointers: [{ role: "erases", target: { kind: "delta", deltaRef: { delta: first.id } } }],
  },
  seed,
);
const orderTargetingOrder = signClaims(
  {
    timestamp: 105,
    validFrom: 105,
    author: peerId,
    pointers: [{ role: "erases", target: { kind: "delta", deltaRef: { delta: order.id } } }],
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
const afterIneligibleOrder = encodeOrdinaryPeerFrame({
  peerId,
  prior: erasureHead,
  at: 105,
  sender: "local",
  additions: [unrelated],
});
const falseHeld = encodePermanentPeerFrame({
  kind: "admission",
  peerId,
  prior: ordinaryHead,
  at: 101,
  sender: "local",
  additions: [order],
  erasures: [{ targetId: first.id, orderIds: [order.id], surfaceHoldsBytes: false }],
  quotaCharge: 0,
});
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
const mixed = encodePermanentPeerFrame({
  kind: "admission",
  peerId,
  prior: "",
  at: 102,
  sender: "unattributed",
  additions: [order, unrelated],
  erasures: [{ targetId: first.id, orderIds: [order.id], surfaceHoldsBytes: false }],
  quotaCharge: 1,
});
const mixedHead = contentAddress(mixed);
const mixedState = replayPermanentPeerFrames(peerId, [mixed], mixedHead);
const marker = "CONDEMNED-SECRET-MARKER";
const secret = signClaims(
  {
    timestamp: 110,
    validFrom: 110,
    author: peerId,
    pointers: [{ role: "value", target: { kind: "primitive", value: marker } }],
  },
  seed,
);
const secretOrder = signClaims(
  {
    timestamp: 111,
    validFrom: 111,
    author: peerId,
    pointers: [{ role: "erases", target: { kind: "delta", deltaRef: { delta: secret.id } } }],
  },
  seed,
);
const secretFrame = encodeOrdinaryPeerFrame({
  peerId,
  prior: "",
  at: 110,
  sender: "local",
  additions: [secret],
});
const secretFrameHead = contentAddress(secretFrame);
const secretErasureFrame = encodePermanentPeerFrame({
  kind: "admission",
  peerId,
  prior: secretFrameHead,
  at: 111,
  sender: "local",
  additions: [secretOrder],
  erasures: [{ targetId: secret.id, orderIds: [secretOrder.id], surfaceHoldsBytes: true }],
  quotaCharge: 0,
});
const secretErasureHead = contentAddress(secretErasureFrame);
const secretPending = replayPermanentPeerFrames(
  peerId,
  [secretFrame, secretErasureFrame],
  secretErasureHead,
);
const secretRebase = encodePermanentJournalRebase({
  peerId,
  prior: secretErasureHead,
  state: secretPending,
});
const pending = replayPermanentPeerFrames(peerId, [ordinary, erasure], erasureHead);
const rebase = encodePermanentJournalRebase({ peerId, prior: erasureHead, state: pending });
const rebaseHead = contentAddress(rebase);
const purgedAfterRebase = encodePermanentPeerFrame({
  kind: "purge",
  peerId,
  prior: rebaseHead,
  targetId: first.id,
  generation: 1,
  status: "removed",
});
const purgedAfterRebaseHead = contentAddress(purgedAfterRebase);
const settledAfterRebase = replayPermanentPeerFrames(
  peerId,
  [purgedAfterRebase],
  purgedAfterRebaseHead,
  rebase,
);
const settledRebase = encodePermanentJournalRebase({
  peerId,
  prior: purgedAfterRebaseHead,
  state: settledAfterRebase,
});
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
      conflictingOrder: {
        id: conflictingOrder.id,
        sig: conflictingOrder.sig,
        claims: claimsToJson(conflictingOrder.claims),
      },
      priorEffectiveOrderTarget: {
        order: {
          id: orderTargetingOrder.id,
          sig: orderTargetingOrder.sig,
          claims: claimsToJson(orderTargetingOrder.claims),
        },
        expectedStatuses: ["erasure-ineligible", "admitted"],
        reason: "erasure targets an effective order",
        frameHex: Buffer.from(afterIneligibleOrder).toString("hex"),
        head: contentAddress(afterIneligibleOrder),
      },
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
      mixed: {
        targetName: "userRootDeclaration",
        unrelatedName: "operatorRootDeclaration",
        hex: Buffer.from(mixed).toString("hex"),
        head: mixedHead,
        imageHex: Buffer.from(encodeDurablePeerState(mixedState)).toString("hex"),
        expectedStatuses: ["effective-erasure", "refused", "admitted"],
      },
      falseHeld: {
        hex: Buffer.from(falseHeld).toString("hex"),
        head: contentAddress(falseHeld),
        error: "permanent journal: held target cannot assert absence",
      },
      rebase: {
        hex: Buffer.from(rebase).toString("hex"),
        head: rebaseHead,
        purgedHex: Buffer.from(purgedAfterRebase).toString("hex"),
        purgedHead: purgedAfterRebaseHead,
        settledHex: Buffer.from(settledRebase).toString("hex"),
        settledHead: contentAddress(settledRebase),
      },
      payloadProbe: {
        marker,
        targetId: secret.id,
        secret: { id: secret.id, sig: secret.sig, claims: claimsToJson(secret.claims) },
        order: {
          id: secretOrder.id,
          sig: secretOrder.sig,
          claims: claimsToJson(secretOrder.claims),
        },
        preErasureRebase: {
          beforeSecondRebase: "absence-refuted",
          afterSecondRebase: "committed",
        },
        ordinaryHex: Buffer.from(secretFrame).toString("hex"),
        erasureHex: Buffer.from(secretErasureFrame).toString("hex"),
        rebaseHex: Buffer.from(secretRebase).toString("hex"),
        rebaseHead: contentAddress(secretRebase),
      },
      degraded: {
        unavailableId: first.id,
        availableId: unrelated.id,
        reason: "admitted row mismatch",
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
      conflictingSurfaceError: "permanent journal: inconsistent surface fact",
    },
    null,
    2,
  ) + "\n",
);
