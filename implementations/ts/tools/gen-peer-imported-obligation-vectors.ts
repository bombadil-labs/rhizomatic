/** Refresh pinned active-obligation carry bytes and digests. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  encodeImportedObligations,
  importedObligationsDigest,
  type ImportedObligationCarry,
} from "../src/federation/imported-obligations.js";
import { decodeRefusalSnapshot } from "../src/federation/refusal-snapshot.js";

const file = fileURLToPath(
  new URL("../../../vectors/peer/imported-obligations.json", import.meta.url),
);
const snapshotFile = fileURLToPath(
  new URL("../../../vectors/peer/refusal-snapshot.json", import.meta.url),
);
const vector = JSON.parse(readFileSync(file, "utf8")) as {
  cases: Array<
    ImportedObligationCarry & { snapshotCase: number; expectedHex: string; digest: string }
  >;
};
const snapshots = JSON.parse(readFileSync(snapshotFile, "utf8")) as {
  cases: Array<{ expectedHex: string }>;
};
for (const c of vector.cases) {
  const snapshot = decodeRefusalSnapshot(
    Buffer.from(snapshots.cases[c.snapshotCase]!.expectedHex, "hex"),
  );
  c.expectedHex = Buffer.from(encodeImportedObligations(snapshot, c)).toString("hex");
  c.digest = importedObligationsDigest(snapshot, c);
}
writeFileSync(file, JSON.stringify(vector, null, 2) + "\n");
