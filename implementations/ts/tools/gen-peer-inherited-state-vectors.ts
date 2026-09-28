/** Refresh pinned closed inherited-state image bytes and second-handoff digest. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contentAddress } from "../src/delta/hash.js";
import { decodeDurablePeerState } from "../src/federation/durable-state.js";
import {
  completeRefusalSnapshot,
  encodeClosedPeerState,
  type ClosedPeerState,
} from "../src/federation/inherited-state.js";
import {
  decodeRefusalSnapshot,
  encodeRefusalSnapshot,
  localRefusalSnapshot,
} from "../src/federation/refusal-snapshot.js";

const file = fileURLToPath(new URL("../../../vectors/peer/inherited-state.json", import.meta.url));
const durableFile = fileURLToPath(
  new URL("../../../vectors/peer/durable-state.json", import.meta.url),
);
const refusalFile = fileURLToPath(
  new URL("../../../vectors/peer/refusal-snapshot.json", import.meta.url),
);
const vector = JSON.parse(readFileSync(file, "utf8")) as {
  cases: Array<{
    name: string;
    localCase: number;
    inheritedCase?: number;
    inheritedDurableCase?: number;
    newPeerId: string;
    expectedHex: string;
    fullDigest: string;
    secondHopDigest?: string;
  }>;
};
const durable = JSON.parse(readFileSync(durableFile, "utf8")) as {
  cases: Array<{ expectedHex: string }>;
};
const refusal = JSON.parse(readFileSync(refusalFile, "utf8")) as {
  cases: Array<{ expectedHex: string }>;
};
function local(index: number, peerId: string) {
  const original = decodeDurablePeerState(
    Buffer.from(durable.cases[index]!.expectedHex, "hex"),
    "peer-A",
  );
  return {
    ...original,
    base: {
      ...original.base,
      peerId,
      arrivals: original.base.arrivals.map((row) => ({
        ...row,
        at: 999 + row.transfer,
        sender: row.transfer === 1 ? "peer-A" : peerId,
      })),
    },
  };
}
function state(c: (typeof vector.cases)[number]): ClosedPeerState {
  const inherited =
    c.inheritedCase === undefined
      ? localRefusalSnapshot(
          decodeDurablePeerState(
            Buffer.from(durable.cases[c.inheritedDurableCase!]!.expectedHex, "hex"),
            "peer-A",
          ),
        )
      : decodeRefusalSnapshot(Buffer.from(refusal.cases[c.inheritedCase]!.expectedHex, "hex"));
  return { local: local(c.localCase, c.newPeerId), inherited };
}
for (const c of vector.cases) {
  const staged = state(c);
  c.expectedHex = Buffer.from(encodeClosedPeerState(staged)).toString("hex");
  c.fullDigest = contentAddress(encodeRefusalSnapshot(completeRefusalSnapshot(staged)));
  if (c.secondHopDigest !== undefined) {
    c.secondHopDigest = contentAddress(
      encodeRefusalSnapshot(
        completeRefusalSnapshot({
          local: local(0, "peer-final"),
          inherited: completeRefusalSnapshot(staged),
        }),
      ),
    );
  }
}
writeFileSync(file, JSON.stringify(vector, null, 2) + "\n");
