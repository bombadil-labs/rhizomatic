// HyperSchemas and the schema registry (SPEC-3 §2-3 §6, ERRATA-2 E10/E13). The registry indexes
// schemas by name AND by term hash; pinned refs resolve by hash and are immutable by construction.
// Since issue #23 it also holds resolution Schemas ("readings"), indexed the same two ways, so an
// expand term can name both halves of a child's lens and be validated at build time.

import type { SchemaRefT, Term } from "./eval.js";
import type { Schema } from "./resolution.js";
import { schemaHash, termHash } from "./term-io.js";

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
      case "intersect":
        walk(t.left);
        walk(t.right);
        return;
      case "difference":
        walk(t.of);
        walk(t.without);
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

// Reading refs are derived the same way — every expand's `reading` (issue #23). Kept separate
// from collectRefs because they resolve against a different index (readings, not hyperschemas).
export function collectReadingRefs(term: Term): SchemaRefT[] {
  const out: SchemaRefT[] = [];
  const walk = (t: Term): void => {
    switch (t.kind) {
      case "input":
      case "fix":
        return;
      case "select":
      case "mask":
      case "group":
      case "prune":
      case "resolve":
        walk(t.of);
        return;
      case "union":
      case "intersect":
        walk(t.left);
        walk(t.right);
        return;
      case "difference":
        walk(t.of);
        walk(t.without);
        return;
      case "expand":
        if (t.reading !== undefined) out.push(t.reading);
        walk(t.of);
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
    private readonly readingsByName: ReadonlyMap<string, Schema>,
    private readonly readingsByHash: ReadonlyMap<string, Schema>,
  ) {}

  // Rejects duplicate names, unresolved refs (gather AND reading), and reference cycles
  // (SPEC-3 §3). Data cycles remain legal — the DAG constraint is on programs, not data.
  static build(schemas: readonly HyperSchema[], readings: readonly Schema[] = []): SchemaRegistry {
    const readingsByName = new Map<string, Schema>();
    const readingsByHash = new Map<string, Schema>();
    for (const r of readings) {
      if (r.name === undefined) {
        throw new Error("a registered reading must carry a name (issue #23)");
      }
      if (readingsByName.has(r.name)) throw new Error(`duplicate reading name: ${r.name}`);
      readingsByName.set(r.name, r);
      const h = schemaHash(r);
      // As with hyperschema bodies, two names MAY share a hash; first registration wins.
      if (!readingsByHash.has(h)) readingsByHash.set(h, r);
    }
    const resolveReadingRef = (ref: SchemaRefT, from: string): void => {
      const found =
        ref.kind === "name" ? readingsByName.get(ref.name) : readingsByHash.get(ref.hash);
      if (found === undefined) {
        const label = ref.kind === "name" ? ref.name : `pinned:${ref.hash.slice(0, 12)}…`;
        throw new Error(`schema ${from} references unknown reading ${label} (issue #23)`);
      }
    };
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
      for (const r of collectReadingRefs(s.body)) resolveReadingRef(r, s.name);
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
    return new SchemaRegistry(byName, byHash, readingsByName, readingsByHash);
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

  getReading(name: string): Schema | undefined {
    return this.readingsByName.get(name);
  }

  resolveReading(ref: SchemaRefT): Schema | undefined {
    return ref.kind === "name"
      ? this.readingsByName.get(ref.name)
      : this.readingsByHash.get(ref.hash);
  }
}
