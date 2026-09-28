/** SPEC-6 §2 step 4 authority and budget filter for verified order candidates. */
export interface ErasureOrderCandidate {
  readonly id: string;
  readonly targetId: string;
}

/** Must be deterministic and side-effect-free over the supplied pre-transfer view. */
export type ErasureAuthority = (
  order: ErasureOrderCandidate,
  admittedBefore: ReadonlySet<string>,
) => boolean;

export interface ErasureFilterPlan {
  readonly effectiveOrderIds: readonly string[];
  readonly ineligibleOrderIds: readonly string[];
  readonly limitedOrderIds: readonly string[];
  /** Targets reserved by the budget before the second authority filter. No refill follows. */
  readonly selectedTargets: readonly string[];
}

const utf8 = new TextEncoder();
function cmp(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

/** Simultaneous monotone elimination, using each round's full remaining order set. */
function authorityFixedPoint(
  orders: readonly ErasureOrderCandidate[],
  admittedBefore: ReadonlySet<string>,
  authorize: ErasureAuthority,
  ineligible: Set<string>,
): ErasureOrderCandidate[] {
  let remaining = [...orders];
  while (true) {
    const failing = new Set<string>();
    for (const order of remaining) {
      const hidden = new Set(
        remaining
          .filter((other) => other.id !== order.id && other.targetId !== order.targetId)
          .map((other) => other.targetId),
      );
      const visible = new Set([...admittedBefore].filter((id) => !hidden.has(id)));
      if (!authorize(Object.freeze({ ...order }), visible)) failing.add(order.id);
    }
    if (failing.size === 0) return remaining;
    for (const id of failing) ineligible.add(id);
    remaining = remaining.filter((order) => !failing.has(order.id));
  }
}

/** Pure staging result. No erasure or admission is committed by this function. */
export function planErasureFilter(
  orders: readonly ErasureOrderCandidate[],
  admittedBeforeIds: ReadonlySet<string>,
  targetBudget: number,
  authorize: ErasureAuthority,
): ErasureFilterPlan {
  if (!Number.isSafeInteger(targetBudget) || targetBudget < 0)
    throw new Error("erasure filter: budget must be a nonnegative safe integer");
  const ids = new Set<string>();
  for (const order of orders) {
    if (!order.id || !order.targetId || ids.has(order.id))
      throw new Error("erasure filter: order ids must be unique and targets nonempty");
    ids.add(order.id);
  }
  const before = new Set([...admittedBeforeIds].sort(cmp));
  const ordered = [...orders]
    .map((order) => Object.freeze({ ...order }))
    .sort((a, b) => cmp(a.id, b.id));
  const ineligible = new Set<string>();
  const provisional = ordered.filter((order) => {
    if (authorize(order, new Set(before))) return true;
    ineligible.add(order.id);
    return false;
  });
  const stable = authorityFixedPoint(provisional, before, authorize, ineligible);
  const lowestByTarget = new Map<string, string>();
  for (const order of stable) {
    const current = lowestByTarget.get(order.targetId);
    if (current === undefined || cmp(order.id, current) < 0)
      lowestByTarget.set(order.targetId, order.id);
  }
  const rankedTargets = [...lowestByTarget].sort((a, b) => cmp(a[1], b[1]) || cmp(a[0], b[0]));
  const selectedTargets = rankedTargets.slice(0, targetBudget).map(([target]) => target);
  const selectedTargetSet = new Set(selectedTargets);
  const limited = stable.filter((order) => !selectedTargetSet.has(order.targetId));
  const selected = stable.filter((order) => selectedTargetSet.has(order.targetId));
  const effective = authorityFixedPoint(selected, before, authorize, ineligible);
  return {
    effectiveOrderIds: effective.map((order) => order.id),
    ineligibleOrderIds: [...ineligible].sort(cmp),
    limitedOrderIds: limited.map((order) => order.id),
    selectedTargets,
  };
}
