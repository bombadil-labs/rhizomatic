/** Pin canonical empty and admitted images for the typed single-peer host trial. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseClaims } from "../src/delta/json-profile.js";
import { authorForSeed } from "../src/delta/sign.js";
import type { Delta } from "../src/delta/types.js";
import { emptyDurablePeerState, encodeDurablePeerState } from "../src/federation/durable-state.js";
import { planSignedLooseOrdinaryTransfer } from "../src/federation/signed-loose-admission.js";

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
const peerId = authorForSeed("01".repeat(32));
const empty = emptyDurablePeerState(peerId);
const first = named.get("userRootDeclaration")!;
const second = named.get("operatorRootDeclaration")!;
const local = planSignedLooseOrdinaryTransfer(empty, {
  offered: [first],
  sendingPeerId: "local",
  arrivedAt: 100,
  capacity: Number.MAX_SAFE_INTEGER,
  policyState: {},
  guards: [],
  isErasureCandidate: () => false,
});
const individual = planSignedLooseOrdinaryTransfer(empty, {
  offered: [first, second],
  sendingPeerId: "unattributed",
  arrivedAt: 101,
  capacity: Number.MAX_SAFE_INTEGER,
  policyState: {},
  guards: [
    ({ candidate }) =>
      candidate.id === second.id ? { ok: false, reason: "no write grant" } : { ok: true },
  ],
  isErasureCandidate: () => false,
});
const file = fileURLToPath(new URL("../../../vectors/peer/single-peer-api.json", import.meta.url));
writeFileSync(
  file,
  JSON.stringify(
    {
      spec: "SPEC-6 vNext §2-3 typed single-peer admission",
      description:
        "No new image format: empty constructor, local atomic append, per-candidate receive, reason and origin markers over the canonical durable v2 image.",
      peerId,
      emptyHex: Buffer.from(encodeDurablePeerState(empty)).toString("hex"),
      firstName: "userRootDeclaration",
      secondName: "operatorRootDeclaration",
      local: {
        at: 100,
        expectedHex: Buffer.from(encodeDurablePeerState(local.state)).toString("hex"),
        outcomes: local.outcomes,
      },
      individual: {
        at: 101,
        reason: "no write grant",
        expectedHex: Buffer.from(encodeDurablePeerState(individual.state)).toString("hex"),
        outcomes: individual.outcomes,
      },
    },
    null,
    2,
  ) + "\n",
);
