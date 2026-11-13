// Generates vectors/store/follow.json (SPEC-18 proposal §4.6, §8) from the model in
// src/storage/follow-vectors.ts. The model proves the follower's guarantee by brute force as it
// builds each case. Before writing, the memory reference store and the TypeScript cursor must
// pass the document: a vector they fail is a defect in the model or in the code.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFollowConformance } from "../src/storage/follow-conformance.js";
import { followVectors } from "../src/storage/follow-vectors.js";
import { followFeed, positionOf } from "../src/storage/follow.js";
import { createMemoryStore } from "../src/storage/memory-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../vectors/store/follow.json");

const document = followVectors();
const report = await runFollowConformance(
  async (request) => createMemoryStore({ ...request }),
  { positionOf, follow: followFeed },
  document,
);
if (report.skipped.length > 0)
  throw new Error(`the reference skipped ${report.skipped.map((s) => s.name).join(", ")}`);

writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${document.cases.length} follow cases to ${out}`);
