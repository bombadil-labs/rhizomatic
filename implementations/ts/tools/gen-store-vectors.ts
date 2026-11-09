// Generates vectors/store/scripts.json and vectors/store/scope.json (SPEC-18 proposal §8) from
// the model in src/storage/store-vectors.ts. Before writing, the memory reference store must
// pass the documents: a vector the reference fails is a defect in the model or in the store.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { runStoreConformance } from "../src/storage/store-conformance.js";
import { storeVectors } from "../src/storage/store-vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../vectors/store");

const vectors = storeVectors();
const report = await runStoreConformance(async () => createMemoryStore(), vectors);
if (report.skipped.length > 0)
  throw new Error(`the reference store skipped ${report.skipped.map((s) => s.name).join(", ")}`);

writeFileSync(resolve(out, "scripts.json"), JSON.stringify(vectors.scripts, null, 2) + "\n");
writeFileSync(resolve(out, "scope.json"), JSON.stringify(vectors.scope, null, 2) + "\n");
console.log(
  `wrote ${vectors.scripts.scripts.length} scripts and ${vectors.scope.cases.length} scope cases to ${out}`,
);
