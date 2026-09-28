/** SPEC-6 §2 step 5 after erasure and dependency pre-pruning. Internal staging result only. */
export interface OrdinaryQuotaUnit {
  /** Stable identity for this offered appearance, including its full supplied member set. */
  readonly key: string;
  /** Receiver-declared rank; the portable default is the loose or manifest delta id. */
  readonly rank: string;
  /** Ids this unit would newly add. Overlap between units is charged once. */
  readonly freshIds: readonly string[];
  /** Post-commit dependencies, including eligible co-offered negations. */
  readonly requires: readonly string[];
}

export interface OrdinaryQuotaPlan {
  readonly selectedKeys: readonly string[];
  readonly skippedKeys: readonly string[];
  readonly prunedKeys: readonly string[];
  readonly admittedIds: readonly string[];
  readonly charged: number;
}

const utf8 = new TextEncoder();
const DELTA_ID = /^1e20[0-9a-f]{64}$/;
function wellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++i >= value.length) return false;
      const low = value.charCodeAt(i);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function compareBytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

/** Stable tie-breaker for verified loose and bundle appearances. */
export function ordinaryUnitKey(deltaId: string, suppliedMemberIds?: readonly string[]): string {
  if (!DELTA_ID.test(deltaId) || suppliedMemberIds?.some((id) => !DELTA_ID.test(id)))
    throw new Error("ordinary quota: invalid unit id");
  return suppliedMemberIds === undefined
    ? deltaId
    : `${deltaId}:${[...suppliedMemberIds].sort(compareBytes).join(":")}`;
}

/** Select by stable rank, skip oversized units, then prune requirements to a fixed point. */
export function planOrdinaryQuota(
  units: readonly OrdinaryQuotaUnit[],
  existingIds: ReadonlySet<string>,
  excludedIds: ReadonlySet<string>,
  capacity: number,
): OrdinaryQuotaPlan {
  if (!Number.isSafeInteger(capacity) || capacity < 0)
    throw new Error("ordinary quota: capacity must be a nonnegative safe integer");
  const keys = new Set<string>();
  for (const unit of units) {
    if (
      !unit.key ||
      !unit.rank ||
      !wellFormedUnicode(unit.key) ||
      !wellFormedUnicode(unit.rank) ||
      keys.has(unit.key)
    )
      throw new Error(
        "ordinary quota: unit keys must be unique and ranks well-formed nonempty text",
      );
    keys.add(unit.key);
    if (unit.freshIds.some((id) => excludedIds.has(id)))
      throw new Error("ordinary quota: excluded id reached ordinary selection");
  }
  const ordered = [...units].sort(
    (a, b) => compareBytes(a.rank, b.rank) || compareBytes(a.key, b.key),
  );
  const charged = new Set<string>();
  const selected = new Set<string>();
  const skipped = new Set<string>();
  for (const unit of ordered) {
    const needed = new Set(unit.freshIds.filter((id) => !existingIds.has(id) && !charged.has(id)));
    if (needed.size > capacity - charged.size) {
      skipped.add(unit.key);
      continue;
    }
    selected.add(unit.key);
    for (const id of needed) charged.add(id);
  }
  const pruned = new Set<string>();
  while (true) {
    const available = new Set([...existingIds].filter((id) => !excludedIds.has(id)));
    for (const unit of ordered) {
      if (selected.has(unit.key)) for (const id of unit.freshIds) available.add(id);
    }
    const failing = ordered.filter(
      (unit) => selected.has(unit.key) && unit.requires.some((id) => !available.has(id)),
    );
    if (failing.length === 0) break;
    for (const unit of failing) {
      selected.delete(unit.key);
      pruned.add(unit.key);
    }
  }
  const admitted = new Set<string>();
  for (const unit of ordered) {
    if (selected.has(unit.key)) {
      for (const id of unit.freshIds) if (!existingIds.has(id)) admitted.add(id);
    }
  }
  return {
    selectedKeys: ordered.filter((u) => selected.has(u.key)).map((u) => u.key),
    skippedKeys: ordered.filter((u) => skipped.has(u.key)).map((u) => u.key),
    prunedKeys: ordered.filter((u) => pruned.has(u.key)).map((u) => u.key),
    admittedIds: [...admitted].sort(compareBytes),
    charged: admitted.size,
  };
}
