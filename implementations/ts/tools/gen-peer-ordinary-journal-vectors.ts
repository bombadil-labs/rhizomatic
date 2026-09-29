/** Pin canonical ordinary journal frames, their digest chain, and reconstructed image. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bstr, encode, float, map, tstr } from "../src/delta/cbor.js";
import { parseClaims } from "../src/delta/json-profile.js";
import type { Delta } from "../src/delta/types.js";
import { encodeDurablePeerState } from "../src/federation/durable-state.js";
import {
  encodeOrdinaryJournalCheckpoint,
  encodeOrdinaryPeerFrame,
  ordinaryPeerFrameId,
  replayOrdinaryPeerFrames,
} from "../src/federation/ordinary-journal.js";

const evidence = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/principal/evidence.json", import.meta.url)),
    "utf8",
  ),
) as { deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }> };
const named = new Map<string, Delta>(
  evidence.deltas.map((row) => [
    row.name,
    {
      id: row.id,
      claims: parseClaims(row.claims),
      ...(row.sig === undefined ? {} : { sig: row.sig }),
    },
  ]),
);
const peerId = "ed25519:8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";
const first = named.get("userRootDeclaration")!;
const second = named.get("operatorRootDeclaration")!;
const firstBytes = encodeOrdinaryPeerFrame({
  peerId,
  prior: "",
  at: 100,
  sender: "local",
  additions: [first],
});
const firstHead = ordinaryPeerFrameId(firstBytes);
const secondBytes = encodeOrdinaryPeerFrame({
  peerId,
  prior: firstHead,
  at: 100,
  sender: "unattributed",
  additions: [second],
});
const secondHead = ordinaryPeerFrameId(secondBytes);
const firstState = replayOrdinaryPeerFrames(peerId, [firstBytes], firstHead);
const checkpoint = encodeOrdinaryJournalCheckpoint({ peerId, head: firstHead, state: firstState });
const forgedState = {
  ...firstState,
  base: {
    ...firstState.base,
    arrivals: firstState.base.arrivals.map((row) => ({ ...row, sender: "unattributed" })),
  },
};
const forgedCheckpoint = encode(
  map([
    ["version", float(1)],
    ["peer", tstr(peerId)],
    ["head", tstr(firstHead)],
    ["image", bstr(encodeDurablePeerState(forgedState))],
  ]),
);
const state = replayOrdinaryPeerFrames(peerId, [firstBytes, secondBytes], secondHead);
const file = fileURLToPath(new URL("../../../vectors/peer/ordinary-journal.json", import.meta.url));
writeFileSync(
  file,
  JSON.stringify(
    {
      spec: "SPEC-6 vNext §2-3 ordinary append journal",
      description:
        "Two separate transfers at equal trusted time produce a digest chain, distinct transfer ordinals, and the same canonical durable state as image admission.",
      peerId,
      firstName: "userRootDeclaration",
      secondName: "operatorRootDeclaration",
      frames: [
        {
          at: 100,
          sender: "local",
          prior: "",
          hex: Buffer.from(firstBytes).toString("hex"),
          head: firstHead,
        },
        {
          at: 100,
          sender: "unattributed",
          prior: firstHead,
          hex: Buffer.from(secondBytes).toString("hex"),
          head: secondHead,
        },
      ],
      expectedImageHex: Buffer.from(encodeDurablePeerState(state)).toString("hex"),
      checkpoint: {
        head: firstHead,
        hex: Buffer.from(checkpoint).toString("hex"),
        retainedFrameHex: Buffer.from(secondBytes).toString("hex"),
        expectedImageHex: Buffer.from(
          encodeDurablePeerState(
            replayOrdinaryPeerFrames(peerId, [secondBytes], secondHead, checkpoint),
          ),
        ).toString("hex"),
        brokenBoundaryError: "ordinary journal: broken frame chain",
        forgedSenderHex: Buffer.from(forgedCheckpoint).toString("hex"),
        forgedHeadError: "ordinary journal: checkpoint head mismatch",
      },
      expectedArrivals: state.base.arrivals,
      api: {
        emptyHead: "",
        noOpWrites: 0,
        rowsWithoutJournal: "rows-without-journal",
        guardReason: "no write grant",
        rowMismatchError: "ordinary journal: admitted row mismatch",
      },
      brokenChainError: "ordinary journal: broken frame chain",
      headMismatchError: "ordinary journal: head mismatch",
      repeatedIdError: "ordinary journal: repeated admitted id",
      emptyFrameError: "ordinary journal: empty transfer",
    },
    null,
    2,
  ) + "\n",
);
