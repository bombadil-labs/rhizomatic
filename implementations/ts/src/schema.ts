// HyperSchemas and the schema registry (SPEC-3 §2-3, ERRATA-2 E10). The registry is an explicit
// evaluation input in v0; pinned/evolvable references arrive with schemas-as-deltas (M1.5).

import type { Term } from "./eval.js";

export interface HyperSchema {
  readonly name: string;
  readonly alg: number; // L2 algebra version
  readonly body: Term; // an HView-sort term, a function of the ambient root
}

// refs are derived from the body — every expand/fix schema name (E10).
export function collectRefs(term: Term): string[] {
  const out: string[] = [];
  const walk = (t: Term): void => {
    switch (t.kind) {
      case "input":
        return;
      case "select":
      case "mask":
      case "group":
      case "prune":
        walk(t.of);
        return;
      case "union":
        walk(t.left);
        walk(t.right);
        return;
      case "expand":
        out.push(t.schema);
        walk(t.of);
        return;
      case "fix":
        out.push(t.schema);
        return;
    }
  };
  walk(term);
  return out;
}

export class SchemaRegistry {
  private constructor(private readonly byName: ReadonlyMap<string, HyperSchema>) {}

  // Rejects duplicate names, unresolved refs, and reference cycles (SPEC-3 §3).
  // Data cycles remain legal — the DAG constraint is on programs, not data.
  static build(schemas: readonly HyperSchema[]): SchemaRegistry {
    const byName = new Map<string, HyperSchema>();
    for (const s of schemas) {
      if (byName.has(s.name)) throw new Error(`duplicate schema name: ${s.name}`);
      byName.set(s.name, s);
    }
    const refs = new Map<string, string[]>();
    for (const s of schemas) {
      const rs = collectRefs(s.body);
      for (const r of rs) {
        if (!byName.has(r)) throw new Error(`schema ${s.name} references unknown schema ${r}`);
      }
      refs.set(s.name, rs);
    }
    // DFS cycle detection over the derived reference graph.
    const state = new Map<string, "visiting" | "done">();
    const visit = (name: string, path: string[]): void => {
      const st = state.get(name);
      if (st === "done") return;
      if (st === "visiting") {
        throw new Error(`schema reference cycle: ${[...path, name].join(" -> ")} (SPEC-3 §3)`);
      }
      state.set(name, "visiting");
      for (const r of refs.get(name) ?? []) visit(r, [...path, name]);
      state.set(name, "done");
    };
    for (const s of schemas) visit(s.name, []);
    return new SchemaRegistry(byName);
  }

  get(name: string): HyperSchema | undefined {
    return this.byName.get(name);
  }
}
