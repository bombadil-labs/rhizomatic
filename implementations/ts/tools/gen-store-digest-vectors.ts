// Generates vectors/store/digest.json (SPEC-18 proposal §4.7.6, §8) from the model in
// src/storage/digest-vectors.ts. Before writing, the memory reference store must pass the
// document: a vector it fails is a defect in the model or in the store.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDigestConformance } from "../src/storage/digest-conformance.js";
import { digestVectors } from "../src/storage/digest-vectors.js";
import { createMemoryStore } from "../src/storage/memory-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../vectors/store/digest.json");

const document = digestVectors();
const report = await runDigestConformance(async () => createMemoryStore(), document);
if (report.skipped.length > 0)
  throw new Error(`the reference skipped ${report.skipped.map((s) => s.name).join(", ")}`);

writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `wrote ${document.trees.length} trees and ${document.cases.length} digest cases to ${out}`,
);
