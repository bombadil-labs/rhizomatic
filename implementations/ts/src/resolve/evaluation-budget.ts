// Invocation-local summaries for SPEC-16's bounded logical HView results. No clock/callback/cache.
export interface MaterializationEvaluationLimits {
  readonly nodes: number;
  readonly entries: number;
  readonly buckets: number;
  readonly depth: number;
}
export interface LogicalTreeSummary {
  readonly nodes: number;
  readonly entries: number;
  readonly maxBuckets: number;
  readonly depth: number;
}
export class EvaluationResourceLimit extends Error {
  constructor() {
    super("resource-limit");
  }
}
export class EvaluationBudget {
  readonly summaries = new WeakMap<object, LogicalTreeSummary>();
  constructor(
    readonly limits: MaterializationEvaluationLimits,
    readonly pathDepth = 1,
  ) {
    for (const [key, max] of Object.entries({
      nodes: 4096,
      entries: 16384,
      buckets: 256,
      depth: 32,
    })) {
      const n = limits[key as keyof MaterializationEvaluationLimits];
      if (!Number.isSafeInteger(n) || n < 1 || n > max)
        throw Error("invalid materialization evaluation limits");
    }
    this.check({ nodes: 1, entries: 0, maxBuckets: 0, depth: 1 });
  }
  check(s: LogicalTreeSummary): void {
    if (
      s.nodes > this.limits.nodes ||
      s.entries > this.limits.entries ||
      s.maxBuckets > this.limits.buckets ||
      this.pathDepth + s.depth - 1 > this.limits.depth
    )
      throw new EvaluationResourceLimit();
  }
  descend(): EvaluationBudget {
    return new EvaluationBudget(this.limits, this.pathDepth + 1);
  }
  set<T extends object>(tree: T, s: LogicalTreeSummary): T {
    this.check(s);
    this.summaries.set(tree, s);
    return tree;
  }
  summary(tree: object): LogicalTreeSummary {
    const s = this.summaries.get(tree);
    if (!s) throw Error("missing internal tree summary");
    return s;
  }
}
