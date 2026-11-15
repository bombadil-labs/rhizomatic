// Generates vectors/store/views.json (SPEC-18 proposal §4.6, "Held views") from the model in
// tools/store-views-vectors.ts. The model proves rules 1 and 4 of held views by brute force as it
// builds each case. Before writing, the memory reference store and the TypeScript `StoreViews`
// must pass the document: a vector they fail is a defect in the model or in the code.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StoreViews } from "../src/reactor/store-views.js";
import { runViewsConformance } from "../src/reactor/views-conformance.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { viewsVectors } from "./store-views-vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../vectors/store/views.json");

const document = viewsVectors();
const report = await runViewsConformance(
  async (request) => createMemoryStore({ ...request }),
  { create: (peer, options) => new StoreViews(peer, options) },
  document,
);
if (report.skipped.length > 0)
  throw new Error(`the reference skipped ${report.skipped.map((s) => s.name).join(", ")}`);

writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${document.cases.length} views cases to ${out}`);
