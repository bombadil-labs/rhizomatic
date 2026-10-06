import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { evalMaterializationTerm, evalTerm } from "../src/resolve/eval.js";
import { EvaluationBudget } from "../src/resolve/evaluation-budget.js";
import {
  materializationInputCatalog,
  prepareMaterializationInput,
  validateMaterializationInputProgram,
  validateMaterializationSourceInput,
} from "../src/command/materialization-input.js";
import { parseCommandDelta } from "../src/command-data/codec.js";
import { DeltaSet } from "../src/delta/set.js";
const v = JSON.parse(
  readFileSync(new URL("../../../vectors/materialization/commands.json", import.meta.url), "utf8"),
);
for (const [id, singleNodeSummaries, descents] of [
  ["bounded_dag_exact", 15, 14],
  ["bounded_dag_node_over", 15, 14],
  ["bounded_dag_depth_over", 3, 3],
  ["bounded_dag_exponential_early_stop", 43, 42],
  ["bounded_wrappers_non_cumulative", 15, 14],
  ["bounded_pending_child_prunes_to_one", 201, 199],
] as const) {
  it(`bounded logical visitation/${id}`, () => {
    const f = [...v.positives, ...v.negatives].find((f: { id: string }) => f.id === id),
      boot = f.boot ?? v.boot;
    const c = materializationInputCatalog({
        configuration: parseCommandDelta(boot.configuration),
        declarations: boot.declarations.map(parseCommandDelta),
        bindings: boot.bindings.map(parseCommandDelta),
      }),
      p = prepareMaterializationInput(c, f.request.id, f.delivery, 1000),
      s = validateMaterializationSourceInput(c, p, 1000),
      program = validateMaterializationInputProgram(c, p);
    const set = vi.spyOn(EvaluationBudget.prototype, "set"),
      descend = vi.spyOn(EvaluationBudget.prototype, "descend");
    try {
      const run = () =>
        evalMaterializationTerm(
          program.selected.hyper.body,
          DeltaSet.from(s.deltas),
          1000,
          c.limits,
          "item:fern",
          program.selected.registry,
          program.bindings,
        );
      if (v.positives.some((f: { id: string }) => f.id === id)) expect(run().sort).toBe("hview");
      else expect(run).toThrow("resource-limit");
      // Count one-node group results and the one-node prune publication, not abstract allocations.
      // The pending-child fixture has 200 groups plus its 100-to-1 prune; sharing discounts no paths.
      expect(set.mock.calls.filter(([, s]) => s.nodes === 1).length).toBe(singleNodeSummaries);
      expect(descend).toHaveBeenCalledTimes(descents);
      if (id === "bounded_dag_node_over")
        expect(
          evalTerm(
            program.selected.hyper.body,
            DeltaSet.from(s.deltas),
            1000,
            "item:fern",
            program.selected.registry,
            program.bindings,
          ).sort,
        ).toBe("hview");
    } finally {
      set.mockRestore();
      descend.mockRestore();
    }
  });
}
