// Scoped batch gather (SPEC-16 §4a): complete deliveries under a scoped and a full binding, with
// the receiver-signed outcome each must produce. Expected outcomes come from the TypeScript
// endpoint; the TypeScript test also checks their meaning (a completed scoped read equals a
// whole-set read), and the Rust witness must reproduce every outcome byte for byte.
import { writeFileSync } from "node:fs";
import { bstr, encode, float, map, tstr, type CborValue } from "../src/delta/cbor.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import { makeNegationClaims } from "../src/delta/set.js";
import type { Delta, Target } from "../src/delta/types.js";
import { contentAddress } from "../src/delta/hash.js";
import { claimsToJson } from "../src/delta/json-profile.js";
import {
  MATERIALIZATION_MAX_LIMITS,
  encodeMaterializationLimits,
  materializationDescriptionClaims,
  type MaterializationDescriptionKind,
} from "../src/command-data/materialization-codec.js";
import { MaterializationEndpoint } from "../src/command/materialization-endpoint.js";
import { produceMaterializationSnapshot } from "../src/federation/materialization-source.js";
import { Reactor } from "../src/reactor/reactor.js";
import { scopeIds } from "../src/resolve/anchored.js";
import { parseSchema, parseTerm } from "../src/syntax/term-json.js";
import {
  schemaCanonicalHex,
  schemaHash,
  termCanonicalHex,
  termHash,
} from "../src/syntax/term-io.js";

const PREFIX = "rhizomatic.materialization.";
const seeds = { receiver: "11".repeat(32), definition: "22".repeat(32), gardener: "33".repeat(32) };
const keys = Object.fromEntries(
  Object.entries(seeds).map(([k, v]) => [k, authorForSeed(v)]),
) as Record<keyof typeof seeds, string>;
const p = (value: string | number): Target => ({ kind: "primitive", value });
const ent = (id: string): Target => ({ kind: "entity", entity: { id } });
const ref = (id: string): Target => ({ kind: "delta", deltaRef: { delta: id } });
const blob = (value: Uint8Array): Target => ({ kind: "bytes", mime: "application/cbor", value });
const serialize = (d: Delta) => ({
  id: d.id,
  claims: claimsToJson(d.claims),
  ...(d.sig === undefined ? {} : { sig: d.sig }),
});

function describe(
  at: number,
  kind: MaterializationDescriptionKind,
  fields: Record<string, readonly Target[]>,
): Delta {
  return signClaims(
    materializationDescriptionClaims(keys.receiver, at, kind, fields),
    seeds.receiver,
  );
}

// --- boot: gather and resolve, a scoped and a full binding ------------------------------------
const declarations = ["gather", "resolve"].map((verb) =>
  describe(0, "operation/1", {
    name: [ent(PREFIX + verb)],
    interpreter: [p(`${PREFIX}${verb}/1`)],
    "input-contract": [p(`${PREFIX}${verb}/1`)],
    "output-contract": [p(`${PREFIX}outcome/1`)],
    effect: [p("none")],
    replay: [p("re-evaluate/1")],
    dependencies: [p("explicit-support/1")],
  }),
);
const selectionOf = (profile: string): CborValue =>
  map([
    ["profile", tstr(profile)],
    ["parameters", bstr(encode(map([])))],
  ]);
function binding(sourceId: string, profile: string) {
  const authorityRoot = contentAddress(encode(tstr(`authority:${sourceId}`)));
  const selection = selectionOf(profile);
  const delta = describe(0, "source-binding/1", {
    receiver: [ent(keys.receiver)],
    spec: [
      blob(
        encode(
          map([
            ["sourceId", tstr(sourceId)],
            ["capturer", tstr(keys.receiver)],
            ["authorityRoot", tstr(authorityRoot)],
            ["selection", selection],
          ]),
        ),
      ),
    ],
  });
  const authority = describe(0, "authority/1", {
    "source-binding": [ref(delta.id)],
    spec: [
      blob(
        encode(
          map([
            ["root", tstr(authorityRoot)],
            ["epoch", float(1)],
            ["context", bstr(encode(map([])))],
          ]),
        ),
      ),
    ],
  });
  return { delta, authority, selection };
}
const scopedBinding = binding("scoped", "scoped-snapshot/1"),
  fullBinding = binding("full", "host-authorized-snapshot/1");
const configuration = describe(0, "endpoint/1", {
  receiver: [ent(keys.receiver)],
  caller: [p(keys.receiver)],
  administrator: [p(keys.receiver)],
  installed: declarations.map((d) => ref(d.id)),
  "source-binding": [ref(scopedBinding.delta.id), ref(fullBinding.delta.id)],
  limits: [blob(encodeMaterializationLimits(MATERIALIZATION_MAX_LIMITS))],
});
const boot = { configuration, declarations, bindings: [scopedBinding.delta, fullBinding.delta] };

// --- programs: a bed that expands its plants, and an unanchored const group -----------------
function definition(kind: "hyper" | "reading", bodyHex: string, name: string): Delta {
  const ns = kind === "hyper" ? "hyperschema" : "schema";
  return signClaims(
    {
      author: keys.definition,
      timestamp: 0,
      validFrom: 0,
      pointers: [
        {
          role: `rhizomatic.${ns}.defines`,
          target: { kind: "entity", entity: { id: `definition:${name}`, context: "definition" } },
        },
        { role: `rhizomatic.${ns}.name`, target: p(name) },
        { role: `rhizomatic.${ns}.alg`, target: p(1) },
        { role: `rhizomatic.${ns}.term`, target: p(bodyHex) },
      ],
    },
    seeds.definition,
  );
}
const leafJson = {
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
};
const leaf = parseTerm(leafJson);
const bedTree = parseTerm({
  op: "expand",
  role: { exact: "plant" },
  schema: "Plant",
  reading: "Plant",
  in: leafJson,
});
const unanchored = parseTerm({ op: "group", key: { const: "all" }, in: "input" });
const reading = (name: string) =>
  parseSchema({ name, alg: 1, props: {}, default: { pick: { order: { byTimestamp: "desc" } } } });
const program = (top: ReturnType<typeof parseTerm>, name: string, children: Delta[] = []) => {
  const hyper = definition("hyper", termCanonicalHex(top), name),
    schemaReading = reading(name),
    schema = definition("reading", schemaCanonicalHex(schemaReading), name);
  return {
    hyper,
    schema,
    hyperPin: termHash(top),
    schemaPin: schemaHash(schemaReading),
    definitions: children,
  };
};
const plantProgram = program(leaf, "Plant");
const bedProgram = program(bedTree, "Bed", [plantProgram.hyper, plantProgram.schema]);
const allProgram = program(unanchored, "All");

// --- the store: a bed with one plant, a struck reading, and a bystander ----------------------
const fact = (
  entity: string,
  context: string,
  value: string | number,
  at: number,
  extra: Target[] = [],
) =>
  signClaims(
    {
      author: keys.gardener,
      timestamp: at,
      validFrom: at,
      pointers: [
        { role: "subject", target: { kind: "entity", entity: { id: entity, context } } },
        { role: "value", target: p(value) },
        ...extra.map((target) => ({ role: "plant", target })),
      ],
    },
    seeds.gardener,
  );
const bedName = fact("bed:1", "name", "North bed", 10);
const bedHasA = fact("bed:1", "plants", "a", 11, [ent("plant:a")]);
const aHeight = fact("plant:a", "height", 10, 12);
const aWrong = fact("plant:a", "height", 99, 13);
const aStrike = signClaims(makeNegationClaims(keys.gardener, 14, aWrong.id), seeds.gardener);
const bystander = fact("plant:z", "height", 50, 15);
const store = [bedName, bedHasA, aHeight, aWrong, aStrike, bystander];
const indexed = new Reactor();
for (const d of store) indexed.ingest(d);
const scopeIdsOf = (_all: readonly Delta[], scope: readonly string[]): Delta[] =>
  scopeIds(indexed, scope).map((id) => indexed.get(id)!);

// --- one case: capture, request, delivery, and the endpoint's outcome ---------------------------
interface Case {
  readonly id: string;
  readonly binding: typeof scopedBinding;
  readonly scope: readonly string[] | undefined;
  readonly program: ReturnType<typeof program>;
  readonly root: string;
}
async function run(c: Case) {
  const rows = c.scope === undefined ? store : scopeIdsOf(store, c.scope);
  const produced = produceMaterializationSnapshot({
    binding: c.binding.delta.id,
    authority: c.binding.authority.id,
    selection: c.binding.selection,
    servingAt: 1000,
    ...(c.scope === undefined ? {} : { scope: c.scope }),
    components: [
      {
        peer: keys.receiver,
        revision: contentAddress(encode(tstr(`rows:${rows.map((d) => d.id).join()}`))),
        capturedAt: 1000,
        operands: rows,
      },
    ],
  });
  const capture = describe(1000, "capture/1", {
    "source-binding": [ref(c.binding.delta.id)],
    authority: [ref(c.binding.authority.id)],
    basis: [blob(produced.basisBytes)],
  });
  const snapshot = describe(1000, "snapshot/1", { data: [blob(produced.snapshotBytes)] });
  const request = describe(1000, "request/1", {
    receiver: [ent(keys.receiver)],
    configuration: [ref(configuration.id)],
    operation: [ref(declarations[0]!.id)],
    capture: [ref(capture.id)],
    snapshot: [ref(snapshot.id)],
    root: [ent(c.root)],
    at: [p(1000)],
    "serving-at": [p(1000)],
    interpretation: [p("core/1")],
    hyperschema: [ref(c.program.hyper.id)],
    "hyperschema-pin": [p(c.program.hyperPin)],
    schema: [ref(c.program.schema.id)],
    "schema-pin": [p(c.program.schemaPin)],
    bindings: [blob(encode(map([])))],
    "definition-at": [p(1000)],
    definition: c.program.definitions
      .map((d) => d.id)
      .sort()
      .map(ref),
  });
  const delivery = [
    request,
    capture,
    snapshot,
    c.binding.authority,
    c.program.hyper,
    c.program.schema,
    ...c.program.definitions,
  ].map(serialize);
  const checks: unknown[] = [];
  const endpoint = MaterializationEndpoint.boot({
    configuration,
    declarations,
    bindings: boot.bindings,
    signer: { author: keys.receiver, sign: (claims) => signClaims(claims, seeds.receiver) },
    sourceGrants: new Map(
      [scopedBinding, fullBinding].map((b) => [
        b.delta.id,
        {
          capture: () => Promise.resolve({ status: "source-unavailable" as const }),
          reacquireSnapshot: () => Promise.resolve({ status: "source-unavailable" as const }),
          checkCurrent: (
            _b: string,
            revision: string,
            _a: string,
            _at: number,
            _cut: number | undefined,
            _s: readonly string[],
            scope?: readonly string[],
          ) => {
            checks.push(scope ?? null);
            return Promise.resolve(
              revision === produced.revision
                ? { status: "current" as const }
                : { status: "source-changed" as const },
            );
          },
        },
      ]),
    ),
    diagnostic: () => {},
  });
  const outcome = await endpoint.invoke(request.id, delivery, 1000);
  return {
    id: c.id,
    binding: c.binding.delta.id,
    scope: c.scope ?? null,
    root: c.root,
    rows: rows.map(serialize),
    revision: produced.revision,
    request: serialize(request),
    capture: serialize(capture),
    snapshot: serialize(snapshot),
    delivery,
    expected: { outcome: serialize(outcome), checks },
  };
}

const cases: Case[] = [
  {
    id: "scoped_bed_tree",
    binding: scopedBinding,
    scope: ["bed:1", "plant:a"],
    program: bedProgram,
    root: "bed:1",
  },
  {
    id: "scope_misses_a_child",
    binding: scopedBinding,
    scope: ["bed:1"],
    program: bedProgram,
    root: "bed:1",
  },
  {
    id: "scope_misses_the_root",
    binding: scopedBinding,
    scope: ["plant:a"],
    program: bedProgram,
    root: "bed:1",
  },
  {
    id: "unanchored_program",
    binding: scopedBinding,
    scope: ["bed:1"],
    program: allProgram,
    root: "bed:1",
  },
  {
    id: "full_binding_scoped_capture",
    binding: fullBinding,
    scope: ["bed:1", "plant:a"],
    program: bedProgram,
    root: "bed:1",
  },
  {
    id: "scoped_binding_full_capture",
    binding: scopedBinding,
    scope: undefined,
    program: bedProgram,
    root: "bed:1",
  },
];

const out = [];
for (const c of cases) out.push(await run(c));
writeFileSync(
  new URL("../../../vectors/materialization/scoped-commands.json", import.meta.url),
  JSON.stringify(
    {
      format: "rhizomatic-scoped-command-vectors/1",
      oracle:
        "SPEC-16 §4a: deliveries under a scoped and a full binding. Outcomes come from the TypeScript endpoint; the TypeScript test checks their meaning and the Rust witness must reproduce every outcome byte for byte.",
      seeds,
      keys,
      boot: {
        configuration: serialize(configuration),
        declarations: declarations.map(serialize),
        bindings: boot.bindings.map(serialize),
      },
      wholeStore: store.map(serialize),
      cases: out,
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${out.length} scoped command vectors`);
