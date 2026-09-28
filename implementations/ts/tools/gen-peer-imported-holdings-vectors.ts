/** Refresh pinned closed holding inventory bytes and digests. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  encodeImportedHoldings,
  importedHoldingsDigest,
} from "../src/federation/imported-holdings.js";
import { emptySnapshot, importedCase } from "./peer-imported-holdings-fixture.js";

const file = fileURLToPath(
  new URL("../../../vectors/peer/imported-holdings.json", import.meta.url),
);
const vector = JSON.parse(readFileSync(file, "utf8")) as {
  cases: Array<{
    holdings: string[];
    cover: boolean;
    expectedHex: string;
    digest: string;
  }>;
};
for (const c of vector.cases) {
  const imported = importedCase(c.holdings, c.cover);
  c.expectedHex = Buffer.from(encodeImportedHoldings(emptySnapshot, imported)).toString("hex");
  c.digest = importedHoldingsDigest(emptySnapshot, imported);
}
writeFileSync(file, JSON.stringify(vector, null, 2) + "\n");
