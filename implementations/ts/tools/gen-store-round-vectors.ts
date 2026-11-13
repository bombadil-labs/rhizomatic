// Generates vectors/store/rounds.json (SPEC-18 proposal §4.4, §8) from the list-scanning model
// in tools/store-round-vectors.ts. Before writing, each case is read a second way, by the
// in-memory anchored evaluation over a Reactor that holds the whole fixture: it must give the
// model's bytes, scope and members.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaims } from "../src/delta/json-profile.js";
import { Reactor } from "../src/reactor/reactor.js";
import { resultCanonicalHex } from "../src/resolve/eval.js";
import { SchemaRegistry } from "../src/schema/schema.js";
import { parseTerm } from "../src/syntax/term-json.js";
import { roundVectors } from "./store-round-vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../vectors/store/rounds.json");

const document = roundVectors();
const registry = SchemaRegistry.build(
  document.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);
const idOf = new Map(document.deltas.map((d) => [d.name, d.id]));
const nameOf = new Map(document.deltas.map((d) => [d.id, d.name]));
const claimsOf = new Map(document.deltas.map((d) => [d.name, parseClaims(d.claims)]));
const reactor = new Reactor();
const sequenceOf = new Map<string, number>();
for (const admission of document.load.admissions)
  for (const { delta, arrival } of admission.added) {
    const id = idOf.get(delta)!;
    sequenceOf.set(id, arrival.sequence);
    const result = reactor.ingest({ id, claims: claimsOf.get(delta)! });
    if (result.status !== "accepted") throw new Error(`fixture delta refused: ${delta}`);
  }

for (const c of document.cases) {
  const excluded = new Set((c.selection.excludeIds ?? []).map((name) => idOf.get(name)!));
  const read = reactor.evalAnchored(
    parseTerm(c.term),
    c.now,
    c.root,
    registry,
    c.bindings === undefined ? undefined : new Map(Object.entries(c.bindings)),
    (delta) =>
      !(
        c.selection.timestampAtMost !== undefined &&
        delta.claims.timestamp > c.selection.timestampAtMost
      ) &&
      !(
        c.selection.arrivalAtMost !== undefined &&
        sequenceOf.get(delta.id)! > c.selection.arrivalAtMost
      ) &&
      !excluded.has(delta.id),
  );
  const got = JSON.stringify({
    canonicalHex: resultCanonicalHex(read.result),
    scope: read.scope,
    members: read.members.map((id) => nameOf.get(id)),
  });
  const { canonicalHex, scope, members } = c.expect;
  if (got !== JSON.stringify({ canonicalHex, scope, members }))
    throw new Error(`rounds case ${c.name}: the anchored evaluation differs from the model`);
}

writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `wrote ${document.cases.length} round cases, ${document.interleaved.length} interleaved and ${document.refusals.length} refusals to ${out}`,
);
