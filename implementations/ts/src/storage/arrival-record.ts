/**
 * Arrival testimony for one admitted delta (SPEC-6 vNext §3). It is the receiving peer's own
 * record and is not part of the delta's canonical bytes. The store keeps one per peer and id;
 * federation plans them (`planArrivals`).
 */
export interface ArrivalRecord {
  readonly id: string;
  readonly at: number;
  readonly sequence: number;
  readonly transfer: number;
  readonly sender: string;
}
