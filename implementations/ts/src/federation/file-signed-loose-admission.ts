// Node-only file wrapper around the pure signed-loose admission planner.
import { decodeDurablePeerState } from "./durable-state.js";
import { writeDurablePeerState } from "./file-durable-state.js";
import {
  planSignedLooseOrdinaryTransfer,
  type SignedLooseTransferInput,
} from "./signed-loose-admission.js";

/** Single-writer file operation. The expected bytes are also the planning snapshot. */
export function admitSignedLooseOrdinaryTransfer<State>(
  path: string,
  expectedPrior: Uint8Array,
  peerId: string,
  input: SignedLooseTransferInput<State>,
) {
  const before = decodeDurablePeerState(expectedPrior, peerId);
  const plan = planSignedLooseOrdinaryTransfer(before, input);
  const write = writeDurablePeerState(path, plan.state, expectedPrior);
  return { ...plan, write };
}
