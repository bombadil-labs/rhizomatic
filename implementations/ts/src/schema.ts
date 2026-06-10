// HyperSchemas and the schema registry (SPEC-3 §2-3 §6, ERRATA-2 E10/E13). The registry indexes
// schemas by name AND by term hash; pinned refs resolve by hash and are immutable by construction.

import type { SchemaRefT, Term } from "./eval.js";
import { termHash } from "./term-io.js";

export interface HyperSchema {
  readonly name: string;
  readonly alg: number; // L2 algebra version
  readonly body: Term; // an HView-sort term, a function of the ambient root
}

// refs are derived from the body — every expand/fix schema reference (E10).
export function collectRefs(term: Term): SchemaRefT[] {
  const out: SchemaRefT[] = [];
  const walk = (t: Term): void => {
    switch (t.kind) {
      case "input":
        return;
      case "select":
      case "mask":
      case "group":
      case "prune":
      case "resolve":
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
  private constructor(
    private readonly byName: ReadonlyMap<string, HyperSchema>,
    private readonly byHash: ReadonlyMap<string, HyperSchema>,
  ) {}

  // Rejects duplicate names, unresolved refs, and reference cycles (SPEC-3 §3).
  // Data cycles remain legal — the DAG constraint is on programs, not data.
  static build(schemas: readonly HyperSchema[]): SchemaRegistry {
    const byName = new Map<string, HyperSchema>();
    const byHash = new Map<string, HyperSchema>();
    const hashOf = new Map<string, string>(); // name -> term hash
    for (const s of schemas) {
      if (byName.has(s.name)) throw new Error(`duplicate schema name: ${s.name}`);
      byName.set(s.name, s);
      const h = termHash(s.body);
      hashOf.set(s.name, h);
      // Two names MAY share a body hash; first registration wins the hash index.
      if (!byHash.has(h)) byHash.set(h, s);
    }
    const resolveName = (ref: SchemaRefT, from: string): string => {
      if (ref.kind === "name") {
        const s = byName.get(ref.name);
        if (s === undefined)
          throw new Error(`schema ${from} references unknown schema ${ref.name}`);
        return s.name;
      }
      const s = byHash.get(ref.hash);
      if (s === undefined) {
        throw new Error(`schema ${from} references unknown pinned schema ${ref.hash} (E13)`);
      }
      return s.name;
    };
    const refs = new Map<string, string[]>();
    for (const s of schemas) {
      refs.set(
        s.name,
        collectRefs(s.body).map((r) => resolveName(r, s.name)),
      );
    }
    // DFS cycle detection over the resolved reference graph.
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
    return new SchemaRegistry(byName, byHash);
  }

  get(name: string): HyperSchema | undefined {
    return this.byName.get(name);
  }

  getByHash(hash: string): HyperSchema | undefined {
    return this.byHash.get(hash);
  }

  resolve(ref: SchemaRefT): HyperSchema | undefined {
    return ref.kind === "name" ? this.byName.get(ref.name) : this.byHash.get(ref.hash);
  }
}
