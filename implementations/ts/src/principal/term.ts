// Lower the serializable actsFor predicate through an explicit principal resolver (SPEC-14 §5).
import { evalTerm, type EvalResult } from "../resolve/eval.js";
import { Reactor } from "../reactor/reactor.js";
import type { DeltaSet } from "../delta/set.js";
import type { SchemaRegistry } from "../schema/schema.js";
import type { Order, Policy, Schema, Term } from "../syntax/model.js";
import type { Bindings, Pred } from "../syntax/pred.js";
import { authorsForPrincipal, type PrincipalSuppression } from "./read.js";

export type PrincipalResolver = (
  input: DeltaSet,
  root: string,
  policy: { readonly kind: "exact" | "prefix"; readonly scope: string },
  at: number,
) => readonly string[];

/** Portable resolver over exactly the supplied input set. Suppression is a required host choice. */
export function principalResolver(suppression: PrincipalSuppression): PrincipalResolver {
  return (input, root, policy, at) => {
    const reactor = new Reactor();
    for (const delta of input) {
      const result = reactor.ingest(delta);
      if (result.status !== "accepted")
        throw new Error("principal input contains an invalid delta");
    }
    return authorsForPrincipal(reactor, root, {
      at,
      now: at,
      scope: policy.scope,
      scopePolicy: policy.kind,
      suppression,
    });
  };
}

/** Replace each principal predicate with the sorted, explicit author set it denotes. */
export function lowerPrincipalTerm(
  term: Term,
  input: DeltaSet,
  at: number,
  resolver: PrincipalResolver,
): Term {
  if (!Number.isFinite(at)) throw new Error("now must be a finite number");
  const cache = new Map<string, readonly string[]>();
  const lowerPred = (pred: Pred): Pred => {
    switch (pred.kind) {
      case "actsFor": {
        const key = JSON.stringify([pred.root, pred.policy.kind, pred.policy.scope]);
        let authors = cache.get(key);
        if (authors === undefined) {
          authors = [...new Set(resolver(input, pred.root, pred.policy, at))].sort();
          cache.set(key, authors);
        }
        return { kind: "match", field: "author", cmp: "inSet", constant: authors };
      }
      case "and":
      case "or":
        return { ...pred, left: lowerPred(pred.left), right: lowerPred(pred.right) };
      case "not":
        return { ...pred, pred: lowerPred(pred.pred) };
      case "inView":
        return { ...pred, term: lowerTerm(pred.term) };
      default:
        return pred;
    }
  };
  const lowerOrder = (order: Order): Order => {
    switch (order.kind) {
      case "byPred":
        return { ...order, pred: lowerPred(order.pred), then: lowerOrder(order.then) };
      case "chain":
        return { ...order, orders: order.orders.map(lowerOrder) };
      default:
        return order;
    }
  };
  const lowerPolicy = (policy: Policy): Policy => {
    switch (policy.kind) {
      case "pick":
      case "all":
      case "conflicts":
        return { ...policy, order: lowerOrder(policy.order) };
      case "absentAs":
        return { ...policy, then: lowerPolicy(policy.then) };
      default:
        return policy;
    }
  };
  const lowerSchema = (schema: Schema): Schema => ({
    ...schema,
    props: new Map([...schema.props].map(([name, policy]) => [name, lowerPolicy(policy)])),
    default: lowerPolicy(schema.default),
  });
  const lowerTerm = (node: Term): Term => {
    switch (node.kind) {
      case "input":
      case "fix":
        return node;
      case "select":
        return { ...node, pred: lowerPred(node.pred), of: lowerTerm(node.of) };
      case "union":
      case "intersect":
        return { ...node, left: lowerTerm(node.left), right: lowerTerm(node.right) };
      case "difference":
        return { ...node, of: lowerTerm(node.of), without: lowerTerm(node.without) };
      case "mask":
        return {
          ...node,
          policy:
            node.policy.kind === "trust"
              ? { kind: "trust", pred: lowerPred(node.policy.pred) }
              : node.policy,
          of: lowerTerm(node.of),
        };
      case "resolve":
        return { ...node, schema: lowerSchema(node.schema), of: lowerTerm(node.of) };
      default:
        return { ...node, of: lowerTerm(node.of) };
    }
  };
  return lowerTerm(term);
}

/** Keep pinned reference hashes tied to the signed program while lowering bodies for this read. */
export function lowerPrincipalRegistry(
  registry: SchemaRegistry,
  input: DeltaSet,
  at: number,
  resolver: PrincipalResolver,
): SchemaRegistry {
  return registry.mapEvaluationBodies(
    (body) => lowerPrincipalTerm(body, input, at, resolver),
    (reading) => {
      const wrapper: Term = { kind: "resolve", schema: reading, of: { kind: "input" } };
      const lowered = lowerPrincipalTerm(wrapper, input, at, resolver);
      if (lowered.kind !== "resolve") throw new Error("principal reading lowering failed");
      return lowered.schema;
    },
  );
}

/** Evaluate a term with principal membership resolved over the caller's chosen input. */
export function evalPrincipalTerm(
  term: Term,
  input: DeltaSet,
  now: number,
  resolver: PrincipalResolver,
  root?: string,
  registry?: SchemaRegistry,
  bindings?: Bindings,
): EvalResult {
  return evalTerm(
    lowerPrincipalTerm(term, input, now, resolver),
    input,
    now,
    root,
    registry === undefined ? undefined : lowerPrincipalRegistry(registry, input, now, resolver),
    bindings,
  );
}

/** Register a live view whose principal membership follows ingest and validity boundaries. */
export function registerPrincipalMaterialization(
  reactor: Reactor,
  name: string,
  term: Term,
  roots: readonly string[],
  now: number,
  resolver: PrincipalResolver,
  registry?: SchemaRegistry,
): void {
  reactor.register(name, term, roots, now, registry, (body, input, at, available) => ({
    term: lowerPrincipalTerm(body, input, at, resolver),
    ...(available === undefined
      ? {}
      : { registry: lowerPrincipalRegistry(available, input, at, resolver) }),
  }));
}
