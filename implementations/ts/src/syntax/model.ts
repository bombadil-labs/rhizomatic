// Shared syntax types. These declarations sit below schema, algebra and resolution.
import type { Pred, StrMatch, Bindings } from "./pred.js";
import type { Primitive } from "../delta/types.js";

// A bytes View leaf, shaped identically to the target (SPEC-5 §5). Distinguished from a plain
// object View by its Uint8Array `value` — which is never itself a View, so the two never collide.
export interface BytesView {
  readonly mime: string;
  readonly value: Uint8Array;
}

export type View = Primitive | BytesView | readonly View[] | { readonly [key: string]: View };

export type MergeFn = "max" | "min" | "sum" | "count" | "and" | "or" | "concatSorted";

export type Order =
  | { readonly kind: "byTimestamp"; readonly dir: "desc" | "asc" }
  | { readonly kind: "byValidFrom"; readonly dir: "desc" | "asc" }
  | { readonly kind: "byAuthorRank"; readonly authors: readonly string[] }
  | { readonly kind: "byPred"; readonly pred: Pred; readonly then: Order }
  | { readonly kind: "chain"; readonly orders: readonly Order[] }
  | { readonly kind: "lexById" };

export type Policy =
  | { readonly kind: "pick"; readonly order: Order }
  // distinct (R9): order first, then keep the first occurrence of each distinct value — value
  // equality is the View's canonical CBOR bytes, the same equality conflicts dedups by. Only the
  // literal `true` is representable: absent means off, and `false` is a parse rejection, so a
  // schema has exactly one spelling per meaning and hashing needs no normalization rule.
  | { readonly kind: "all"; readonly order: Order; readonly distinct?: true }
  | { readonly kind: "merge"; readonly fn: MergeFn }
  | { readonly kind: "conflicts"; readonly order: Order }
  | { readonly kind: "absentAs"; readonly constant: Primitive; readonly then: Policy };

export interface Schema {
  readonly props: ReadonlyMap<string, Policy>;
  readonly default: Policy;
  // Optional identity for a named/self-hosting Schema (SPEC-3 ERRATA S6); absent on inline
  // resolve-term schemas. A named Schema carries name + alg (the L5 algebra version).
  readonly name?: string;
  readonly alg?: number;
}

export type MaskPolicy =
  | { readonly kind: "drop" }
  | { readonly kind: "annotate" }
  | { readonly kind: "trust"; readonly pred: Pred };

export type SchemaRefT =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "pinned"; readonly hash: string };

export type GroupKey =
  | { readonly kind: "byTargetContext" }
  | { readonly kind: "byRole" }
  | { readonly kind: "const"; readonly prop: string };

export type Term =
  | { readonly kind: "input" }
  | { readonly kind: "select"; readonly pred: Pred; readonly of: Term }
  | { readonly kind: "union"; readonly left: Term; readonly right: Term }
  | { readonly kind: "intersect"; readonly left: Term; readonly right: Term }
  | { readonly kind: "difference"; readonly of: Term; readonly without: Term }
  | { readonly kind: "mask"; readonly policy: MaskPolicy; readonly of: Term }
  | { readonly kind: "group"; readonly key: GroupKey; readonly of: Term }
  | { readonly kind: "prune"; readonly keep: "all" | StrMatch; readonly of: Term }
  | {
      readonly kind: "expand";
      readonly role: StrMatch;
      readonly schema: SchemaRefT;
      // The child's resolution Schema — the other half of the child's lens (issue #23). Required
      // in the current vocabulary; absent only in legacy bodies, whose expansions then refuse to
      // RESOLVE (gather is unchanged). There is deliberately no parent-Schema fallback.
      readonly reading?: SchemaRefT;
      readonly of: Term;
    }
  | {
      readonly kind: "fix";
      readonly schema: SchemaRefT;
      readonly entity: string;
      readonly bindings?: Bindings;
    }
  | { readonly kind: "resolve"; readonly schema: Schema; readonly of: Term };
