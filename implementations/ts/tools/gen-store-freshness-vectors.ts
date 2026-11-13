// Generates vectors/store/freshness.json (SPEC-18 proposal §4.6, §8) from the model in
// src/storage/freshness-vectors.ts. The model proves each expectation by brute force as it
// builds it. Before writing, the memory reference store and the TypeScript freshness functions
// must pass the document: a vector they fail is a defect in the model or in the code.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureScope } from "../src/reactor/store-read.js";
import { runFreshnessConformance } from "../src/storage/freshness-conformance.js";
import { freshnessVectors } from "../src/storage/freshness-vectors.js";
import { checkFresh, touching } from "../src/storage/freshness.js";
import { createMemoryStore } from "../src/storage/memory-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../vectors/store/freshness.json");

const document = freshnessVectors();
const report = await runFreshnessConformance(
  async ({ changeRetention }) =>
    createMemoryStore(changeRetention === undefined ? {} : { changeRetention }),
  {
    capture: (snapshot, anchors, pushdown, now) =>
      captureScope(
        snapshot,
        anchors.map((anchor) => anchor.entity),
        now,
        { pushdown },
      ),
    touching,
    checkFresh,
  },
  document,
);
if (report.skipped.length > 0)
  throw new Error(`the reference skipped ${report.skipped.map((s) => s.name).join(", ")}`);

writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `wrote ${document.cases.length} freshness cases and ${document.touching.length} touching cases to ${out}`,
);
