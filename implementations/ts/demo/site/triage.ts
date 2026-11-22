// Release triage: the running example of the landing page, with no DOM. Two tools that never
// agreed on a schema, a third party's mapping, a reader's policy, and a late-comer that reads
// only the published pack. Every answer here comes from the library in src/.

import { evalTerm } from "../../src/eval.js";
import type { HView } from "../../src/hview.js";
import { packId, packSet, unpackSet } from "../../src/pack.js";
import { firstByOrder, resolveView, type View } from "../../src/resolution.js";
import type { HyperSchema } from "../../src/schema.js";
import { DeltaSet } from "../../src/set.js";
import { authorForSeed, signClaims } from "../../src/sign.js";
import { parseSchema, parseTerm } from "../../src/term-json.js";
import type { Delta } from "../../src/types.js";

interface Author {
  readonly name: string;
  readonly seed: string;
  readonly author: string;
}

const author = (name: string, seed: string): Author => ({
  name,
  seed,
  author: authorForSeed(seed),
});

export const ENGINEER = author("the release script (engineering)", "e1".repeat(32));
export const SUPPORT = author("the support helper", "5a".repeat(32));
export const SAM = author("Sam (the mapper)", "3c".repeat(32));
export const AUTHORS: readonly Author[] = [ENGINEER, SUPPORT, SAM];

export function whoIs(id: string): string {
  return AUTHORS.find((a) => a.author === id)?.name ?? id;
}

export const BUILD = "build:web@4.2.0";
export const CONCEPT = "concept:release-decision";
export const SLOT = "concept:release-decision#decision";
export const PROPERTY = "decision";

export const RELEASE_SCRIPT_RECORD = { build: "web@4.2.0", status: "ship" } as const;
export const SUPPORT_HELPER_RECORD = { build: "web@4.2.0", verdict: "block" } as const;

export function adaptReleaseScript(record: { build: string; status: string }, when: number): Delta {
  return signClaims(
    {
      author: ENGINEER.author,
      timestamp: when,
      validFrom: when,
      pointers: [
        {
          role: "build",
          target: { kind: "entity", entity: { id: `build:${record.build}`, context: "status" } },
        },
        { role: "status", target: { kind: "primitive", value: record.status } },
      ],
    },
    ENGINEER.seed,
  );
}

export function adaptSupportHelper(
  record: { build: string; verdict: string },
  when: number,
): Delta {
  return signClaims(
    {
      author: SUPPORT.author,
      timestamp: when,
      validFrom: when,
      pointers: [
        {
          role: "build",
          target: { kind: "entity", entity: { id: `build:${record.build}`, context: "verdict" } },
        },
        { role: "verdict", target: { kind: "primitive", value: record.verdict } },
      ],
    },
    SUPPORT.seed,
  );
}

export const SUPPORT_CLAIM = adaptSupportHelper(SUPPORT_HELPER_RECORD, 1000);
export const ENGINEER_CLAIM = adaptReleaseScript(RELEASE_SCRIPT_RECORD, 2000);

const samSigns = (at: number, pointers: Delta["claims"]["pointers"]): Delta =>
  signClaims({ author: SAM.author, timestamp: at, validFrom: at, pointers }, SAM.seed);

export const SLOT_DECLARATION = samSigns(3000, [
  {
    role: "rhizomatic.alias.slot",
    target: { kind: "entity", entity: { id: SLOT, context: "rhizomatic.alias.concept" } },
  },
  {
    role: "rhizomatic.alias.concept",
    target: { kind: "entity", entity: { id: CONCEPT, context: "rhizomatic.alias.slots" } },
  },
]);

const mapping = (at: number, fragment: string): Delta =>
  samSigns(at, [
    { role: "rhizomatic.alias.fragment", target: { kind: "primitive", value: fragment } },
    {
      role: "rhizomatic.alias.slot",
      target: { kind: "entity", entity: { id: SLOT, context: "rhizomatic.alias.mappings" } },
    },
  ]);

export const MAP_STATUS = mapping(3001, "status");
export const MAP_VERDICT = mapping(3002, "verdict");
export const MAPPER_CLAIMS: readonly Delta[] = [SLOT_DECLARATION, MAP_STATUS, MAP_VERDICT];
export const TOOL_CLAIMS: readonly Delta[] = [ENGINEER_CLAIM, SUPPORT_CLAIM];

export function published(mapping: boolean): DeltaSet {
  return DeltaSet.from(mapping ? [...TOOL_CLAIMS, ...MAPPER_CLAIMS] : TOOL_CLAIMS);
}

export const recallBody = (spelling: string) => ({
  op: "group",
  key: { const: PROPERTY },
  in: {
    op: "mask",
    policy: "drop",
    in: {
      op: "select",
      pred: {
        hasPointer: {
          targetEntity: { var: "root" },
          context: { aliased: { name: spelling, via: CONCEPT } },
        },
      },
      in: "input",
    },
  },
});

const recall = (name: string, spelling: string): HyperSchema => ({
  name,
  alg: 1,
  body: parseTerm(recallBody(spelling)),
});

export const GATE_HYPERSCHEMA = recall("ReleaseGate", "status");
export const REPORT_HYPERSCHEMA = recall("DiscrepancyReport", "verdict");

export type PolicyName = "latest" | "support";

export const POLICIES: Readonly<Record<PolicyName, { label: string; order: unknown }>> = {
  latest: { label: "latest claim wins", order: { byTimestamp: "desc" } },
  support: { label: "support's word wins", order: { byAuthorRank: [SUPPORT.author] } },
};

export const REPORT_SCHEMA = parseSchema({
  props: { [PROPERTY]: { conflicts: { order: { byTimestamp: "desc" } } } },
  default: { all: { order: { byTimestamp: "desc" } } },
});

const NOW = 10_000;

export interface Claim {
  readonly id: string;
  readonly author: string;
  readonly who: string;
  readonly spelling: string;
  readonly value: string;
  readonly timestamp: number;
}

function claimOf(delta: Delta): Claim {
  const filing = delta.claims.pointers.find(
    (p) => p.target.kind === "entity" && p.target.entity.id === BUILD,
  );
  const value = delta.claims.pointers.find((p) => p.target.kind === "primitive");
  return {
    id: delta.id,
    author: delta.claims.author,
    who: whoIs(delta.claims.author),
    spelling: filing?.target.kind === "entity" ? (filing.target.entity.context ?? "") : "",
    value: value?.target.kind === "primitive" ? String(value.target.value) : "",
    timestamp: delta.claims.timestamp,
  };
}

export function hyperView(hyperSchema: HyperSchema, set: DeltaSet): HView {
  const result = evalTerm(hyperSchema.body, set, NOW, BUILD);
  if (result.sort !== "hview") throw new Error(`${hyperSchema.name} did not give a HyperView`);
  const names = [...result.hview.props.keys()];
  if (names.some((n) => n !== PROPERTY)) throw new Error(`unexpected properties: ${names.join()}`);
  return result.hview;
}

export interface GateAnswer {
  readonly answer: View | undefined;
  readonly decidedBy: Claim | undefined;
  readonly inView: readonly Claim[];
  readonly notMatched: readonly Claim[];
  readonly view: View;
}

export function gate(input: { mapping: boolean; policy: PolicyName }): GateAnswer {
  const set = published(input.mapping);
  const hview = hyperView(GATE_HYPERSCHEMA, set);
  const entries = hview.props.get(PROPERTY) ?? [];
  const pick = { pick: { order: POLICIES[input.policy].order } };
  const schema = parseSchema({ props: { [PROPERTY]: pick }, default: pick });
  const policy = schema.props.get(PROPERTY);
  if (policy?.kind !== "pick") throw new Error("the gate's policy must pick one claim");
  const view = resolveView(schema, hview);
  const decided = firstByOrder(policy.order, entries);
  const matched = new Set(entries.map((e) => e.delta.id));
  return {
    answer: (view as Record<string, View>)[PROPERTY],
    decidedBy: decided === undefined ? undefined : claimOf(decided.delta),
    inView: entries.map((e) => claimOf(e.delta)),
    notMatched: TOOL_CLAIMS.filter((d) => set.has(d.id) && !matched.has(d.id)).map(claimOf),
    view,
  };
}

export interface Report {
  readonly claims: readonly Claim[];
  readonly signers: readonly string[];
  readonly view: View;
}

export function reportFrom(set: DeltaSet): Report {
  const hview = hyperView(REPORT_HYPERSCHEMA, set);
  const claims = (hview.props.get(PROPERTY) ?? []).map((e) => claimOf(e.delta));
  return {
    claims,
    signers: [...new Set(claims.map((c) => c.author))].sort(),
    view: resolveView(REPORT_SCHEMA, hview),
  };
}

export interface PackedReport extends Report {
  readonly fromPack: true;
  readonly packId: string;
  readonly packBytes: number;
  readonly packedClaims: number;
}

export function reportFromPack(bytes: Uint8Array): PackedReport {
  const set = unpackSet(bytes);
  return {
    ...reportFrom(set),
    fromPack: true,
    packId: packId(bytes),
    packBytes: bytes.length,
    packedClaims: set.size,
  };
}

export function report(input: { mapping: boolean }): PackedReport {
  return reportFromPack(packSet(published(input.mapping)));
}
