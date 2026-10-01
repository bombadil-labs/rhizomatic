// Complete selected-program closure validation. Semantic references belong to schema, not intake.
import type { Schema, Term, SchemaRefT, Order, Policy } from "../syntax/model.js";
import type { Bindings, Pred, StrMatch } from "../syntax/pred.js";
import { schemaHash, termHash } from "../syntax/term-io.js";
import { SchemaRegistry, type HyperSchema } from "./schema.js";
export type CommandProgramDefinition =
  | { readonly id: string; readonly kind: "hyper"; readonly hyper: HyperSchema }
  | { readonly id: string; readonly kind: "reading"; readonly reading: Schema };
export type CommandProgramCode =
  | "pin-mismatch"
  | "ambiguous-definition"
  | "definition-closure"
  | "definition-cycle"
  | "invalid-program";
export class CommandProgramError extends Error {
  constructor(readonly code: CommandProgramCode) {
    super(code);
  }
}
interface Edge {
  kind: "hyper" | "reading";
  ref: SchemaRefT;
  bindings?: Bindings;
}
interface Features {
  edges: Edge[];
  holes: Set<string>;
  actsFor: boolean;
  badSort: boolean;
}
function features(definition: CommandProgramDefinition): Features {
  const result: Features = { edges: [], holes: new Set(), actsFor: false, badSort: false };
  const hole = (v: unknown) => {
    if (typeof v === "object" && v !== null && "kind" in v && v.kind === "hole" && "name" in v)
      result.holes.add(v.name as string);
  };
  const str = (s: StrMatch | undefined) => {
    if (s?.kind === "aliased" && s.trust) pred(s.trust);
  };
  const pred = (p: Pred): void => {
    switch (p.kind) {
      case "actsFor":
        result.actsFor = true;
        return;
      case "and":
      case "or":
        pred(p.left);
        pred(p.right);
        return;
      case "not":
        pred(p.pred);
        return;
      case "inView":
        term(p.term);
        return;
      case "match":
        hole(p.constant);
        return;
      case "hasPointer": {
        str(p.ppred.role);
        str(p.ppred.context);
        hole(p.ppred.targetEntity);
        if (p.ppred.targetValue?.kind === "vcmp") hole(p.ppred.targetValue.value);
        return;
      }
      default:
        return;
    }
  };
  const order = (o: Order): void => {
    if (o.kind === "byPred") {
      pred(o.pred);
      order(o.then);
    }
    if (o.kind === "chain") o.orders.forEach(order);
  };
  const policy = (p: Policy): void => {
    if (p.kind === "pick" || p.kind === "all" || p.kind === "conflicts") order(p.order);
    if (p.kind === "absentAs") policy(p.then);
  };
  const reading = (s: Schema): void => {
    s.props.forEach(policy);
    policy(s.default);
  };
  const requireSort = (actual: string, expected: string) => {
    if (actual !== expected) result.badSort = true;
  };
  const term = (t: Term): "dset" | "hview" | "view" => {
    switch (t.kind) {
      case "input":
        return "dset";
      case "select":
        pred(t.pred);
        requireSort(term(t.of), "dset");
        return "dset";
      case "mask":
        if (t.policy.kind === "trust") pred(t.policy.pred);
        requireSort(term(t.of), "dset");
        return "dset";
      case "union":
      case "intersect":
        requireSort(term(t.left), "dset");
        requireSort(term(t.right), "dset");
        return "dset";
      case "difference":
        requireSort(term(t.of), "dset");
        requireSort(term(t.without), "dset");
        return "dset";
      case "group":
        requireSort(term(t.of), "dset");
        return "hview";
      case "prune":
        if (t.keep !== "all") str(t.keep);
        requireSort(term(t.of), "hview");
        return "hview";
      case "expand":
        str(t.role);
        result.edges.push({ kind: "hyper", ref: t.schema });
        if (t.reading) result.edges.push({ kind: "reading", ref: t.reading });
        else result.badSort = true;
        requireSort(term(t.of), "hview");
        return "hview";
      case "fix":
        result.edges.push({
          kind: "hyper",
          ref: t.schema,
          ...(t.bindings ? { bindings: t.bindings } : {}),
        });
        return "hview";
      case "resolve":
        reading(t.schema);
        requireSort(term(t.of), "hview");
        return "view";
    }
  };
  if (definition.kind === "hyper") requireSort(term(definition.hyper.body), "hview");
  else reading(definition.reading);
  return result;
}
export function validateCommandProgram(
  definitions: readonly CommandProgramDefinition[],
  hyperId: string,
  readingId: string,
  hyperPin: string,
  readingPin: string,
  bindings: Bindings,
  allowPrincipal: boolean,
): { hyper: HyperSchema; reading: Schema; registry: SchemaRegistry } {
  const fail = (code: CommandProgramCode): never => {
    throw new CommandProgramError(code);
  };
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const hyper = byId.get(hyperId),
    reading = byId.get(readingId);
  if (hyper?.kind !== "hyper" || reading?.kind !== "reading")
    throw new CommandProgramError("invalid-program");
  // Pins are checked before every registry or program feature category.
  if (termHash(hyper.hyper.body) !== hyperPin || schemaHash(reading.reading) !== readingPin)
    fail("pin-mismatch");
  const byName = new Map<string, CommandProgramDefinition>(),
    byHash = new Map<string, CommandProgramDefinition>();
  for (const d of definitions) {
    const name = d.kind === "hyper" ? d.hyper.name : d.reading.name!;
    const key = `${d.kind}:${name}`;
    if (byName.has(key)) fail("ambiguous-definition");
    byName.set(key, d);
    const hash = d.kind === "hyper" ? termHash(d.hyper.body) : schemaHash(d.reading);
    if (!byHash.has(`${d.kind}:${hash}`)) byHash.set(`${d.kind}:${hash}`, d);
  }
  const scans = new Map(definitions.map((d) => [d.id, features(d)]));
  const edges = new Map<string, { id: string; bindings?: Bindings }[]>();
  let missing = false;
  for (const d of definitions) {
    const targets: { id: string; bindings?: Bindings }[] = [];
    for (const e of scans.get(d.id)!.edges) {
      const target =
        e.ref.kind === "name"
          ? byName.get(`${e.kind}:${e.ref.name}`)
          : byHash.get(`${e.kind}:${e.ref.hash}`);
      if (!target) missing = true;
      else targets.push({ id: target.id, ...(e.bindings ? { bindings: e.bindings } : {}) });
    }
    edges.set(d.id, targets);
  }
  const reached = new Set<string>();
  const reach = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    edges.get(id)?.forEach((e) => reach(e.id));
  };
  reach(hyperId);
  reach(readingId);
  if (missing || reached.size !== definitions.length) fail("definition-closure");
  const colors = new Map<string, "visiting" | "done">();
  const visit = (id: string): void => {
    if (colors.get(id) === "visiting") fail("definition-cycle");
    if (colors.has(id)) return;
    colors.set(id, "visiting");
    edges.get(id)!.forEach((e) => visit(e.id));
    colors.set(id, "done");
  };
  visit(hyperId);
  visit(readingId);
  const check = (id: string, environment: Bindings): void => {
    const f = scans.get(id)!;
    if (
      f.badSort ||
      (!allowPrincipal && f.actsFor) ||
      [...f.holes].some((h) => !environment.has(h))
    )
      fail("invalid-program");
    edges.get(id)!.forEach((e) => check(e.id, e.bindings ?? environment));
  };
  check(hyperId, bindings);
  check(readingId, bindings);
  // Legacy build remains the compatibility API; this complete walk already validated closure.
  const registry = SchemaRegistry.build(
    definitions.filter((d) => d.kind === "hyper").map((d) => d.hyper),
    definitions.filter((d) => d.kind === "reading").map((d) => d.reading),
  );
  return { hyper: hyper.hyper, reading: reading.reading, registry };
}
