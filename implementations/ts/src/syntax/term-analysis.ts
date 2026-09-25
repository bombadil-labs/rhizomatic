import { predContainsInView } from "./pred.js";
import type { Term } from "./model.js";

// Any inView anywhere in the term? Parse-time stratification and the reactor's conservative
// dispatch (SPEC-4 §4.1) both hang off this walk. Schema bodies referenced by expand/fix are the
// caller's concern (the reactor walks its registry; the parser rejects per-body).
export function termContainsInView(t: Term): boolean {
  switch (t.kind) {
    case "input":
    case "fix":
      return false;
    case "select":
      return predContainsInView(t.pred) || termContainsInView(t.of);
    case "union":
    case "intersect":
      return termContainsInView(t.left) || termContainsInView(t.right);
    case "difference":
      return termContainsInView(t.of) || termContainsInView(t.without);
    case "mask":
      return (
        (t.policy.kind === "trust" && predContainsInView(t.policy.pred)) || termContainsInView(t.of)
      );
    case "group":
    case "prune":
    case "expand":
    case "resolve":
      return termContainsInView(t.of);
  }
}
