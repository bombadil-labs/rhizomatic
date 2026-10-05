// Measurement only: no CI wall-time threshold and no semantic golden updates.
import { performance } from "node:perf_hooks";
import { encodeHViewEnvelope, decodeHViewEnvelope } from "../src/algebra/hview-envelope.js";
import { contentAddress } from "../src/delta/hash.js";
import { signClaims, authorForSeed } from "../src/delta/sign.js";
import { parseClaims } from "../src/delta/json-profile.js";
const seed = "00".repeat(32);
const delta = signClaims(
  parseClaims({
    author: authorForSeed(seed),
    timestamp: 10,
    validFrom: 0,
    pointers: [
      { role: "subject", target: { id: "item:fern", context: "height" } },
      { role: "value", target: 42 },
    ],
  }),
  seed,
);
for (const count of process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [1000, 16384]) {
  if (!Number.isInteger(count) || count < 1 || count > 16384) throw Error("count");
  const view = {
    id: "item:fern",
    props: new Map([["height", Array.from({ length: count }, () => ({ delta, negated: false }))]]),
  };
  const before = performance.now();
  const bytes = encodeHViewEnvelope(view);
  const encoded = performance.now();
  const decoded = decodeHViewEnvelope(bytes);
  const done = performance.now();
  if (decoded.props.get("height")?.length !== count) throw Error("incomplete decode");
  console.log(
    JSON.stringify({
      witness: "ts",
      entries: count,
      distinctSignedAppearances: 1,
      artifactBytes: bytes.length,
      transportId: contentAddress(bytes),
      encodeMs: encoded - before,
      decodeMs: done - encoded,
    }),
  );
}
