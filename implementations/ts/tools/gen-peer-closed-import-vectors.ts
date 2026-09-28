/** Refresh pinned v4 closed import images and their two handoff digests. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  closedImportCarriedDigest,
  closedImportPolicyDigest,
  encodeClosedImportState,
} from "../src/federation/closed-import.js";
import { closedImportCase, type ClosedImportCase } from "./peer-closed-import-fixture.js";

const file = fileURLToPath(new URL("../../../vectors/peer/closed-import.json", import.meta.url));
const vector = JSON.parse(readFileSync(file, "utf8")) as { cases: ClosedImportCase[] };
for (const c of vector.cases) {
  const state = closedImportCase(c);
  c.expectedHex = Buffer.from(encodeClosedImportState(state)).toString("hex");
  c.carriedDigest = closedImportCarriedDigest(state);
  c.policyDigest = closedImportPolicyDigest(state);
}
writeFileSync(file, JSON.stringify(vector, null, 2) + "\n");
