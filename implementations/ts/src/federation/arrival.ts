/** Arrival testimony assigned after a peer has chosen its final accepted set (SPEC-6 vNext §3). */
export interface ArrivalRecord {
  readonly id: string;
  readonly at: number;
  readonly sequence: number;
  readonly transfer: number;
  readonly sender: string;
}

export interface ArrivalCursor {
  readonly lastSequence: number;
  readonly lastTransfer: number;
}

export interface ArrivalPlan extends ArrivalCursor {
  readonly arrivals: readonly ArrivalRecord[];
}

/**
 * Plan receiver-local testimony without changing the peer. The caller commits this plan in the
 * same transaction as the final admitted ids and persists its counters across restarts.
 * `activeIds` is the pre-transfer admitted set, not all historical arrivals: a lower-posture
 * peer may admit an id again in a later epoch.
 */
export function planArrivals(
  cursor: ArrivalCursor,
  activeIds: ReadonlySet<string>,
  acceptedIds: readonly string[],
  at: number,
  sender: string,
): ArrivalPlan {
  if (
    !Number.isSafeInteger(cursor.lastSequence) ||
    cursor.lastSequence < 0 ||
    !Number.isSafeInteger(cursor.lastTransfer) ||
    cursor.lastTransfer < 0
  ) {
    throw new Error("arrival cursor must contain nonnegative safe integers");
  }
  if (!Number.isFinite(at)) throw new Error("arrival time must be finite");
  if (sender.length === 0) throw new Error("arrival sender must not be empty");

  const fresh = [...new Set(acceptedIds.filter((id) => !activeIds.has(id)))].sort();
  if (fresh.some((id) => id.length === 0)) throw new Error("arrival id must not be empty");
  if (fresh.length === 0) return { ...cursor, arrivals: [] };
  if (
    cursor.lastTransfer === Number.MAX_SAFE_INTEGER ||
    cursor.lastSequence > Number.MAX_SAFE_INTEGER - fresh.length
  ) {
    throw new Error("arrival counter exhausted");
  }
  const transfer = cursor.lastTransfer + 1;
  return {
    lastSequence: cursor.lastSequence + fresh.length,
    lastTransfer: transfer,
    arrivals: fresh.map((id, i) => ({
      id,
      at,
      sequence: cursor.lastSequence + i + 1,
      transfer,
      sender,
    })),
  };
}
