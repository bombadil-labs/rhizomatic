// Execute a reading's ordinary order predicates under an explicit variable environment.
import type { Order, Policy, Schema } from "./model.js";
import { substituteHoles, type Bindings } from "./pred.js";
export function bindReadingVariables(schema: Schema, bindings: Bindings | undefined): Schema {
  if (bindings === undefined) return schema;
  const order = (value: Order): Order => {
    if (value.kind === "byPred")
      return { ...value, pred: substituteHoles(value.pred, bindings), then: order(value.then) };
    if (value.kind === "chain") return { ...value, orders: value.orders.map(order) };
    return value;
  };
  const policy = (value: Policy): Policy => {
    if (value.kind === "pick" || value.kind === "all" || value.kind === "conflicts")
      return { ...value, order: order(value.order) };
    if (value.kind === "absentAs") return { ...value, then: policy(value.then) };
    return value;
  };
  return {
    ...schema,
    props: new Map([...schema.props].map(([name, value]) => [name, policy(value)])),
    default: policy(schema.default),
  };
}
