/** Refresh pinned portable refusal snapshot bytes and digests. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  encodeRefusalSnapshot,
  refusalSnapshotDigest,
  type RefusalSnapshot,
} from "../src/federation/refusal-snapshot.js";

const file = fileURLToPath(new URL("../../../vectors/peer/refusal-snapshot.json", import.meta.url));
const vector = JSON.parse(readFileSync(file, "utf8")) as {
  cases: Array<RefusalSnapshot & { name: string; expectedHex: string; digest: string }>;
};
for (const c of vector.cases) {
  c.expectedHex = Buffer.from(encodeRefusalSnapshot(c)).toString("hex");
  c.digest = refusalSnapshotDigest(c);
}
writeFileSync(file, JSON.stringify(vector, null, 2) + "\n");
