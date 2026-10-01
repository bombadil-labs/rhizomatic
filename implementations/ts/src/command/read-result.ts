import {
  readOutcome,
  verifyCommandAppearance,
  commandEntity,
  commandRef,
  type ReadOutcome,
} from "../command-data/codec.js";
import { decodeView } from "../resolve-kernel/resolution.js";
import type { View } from "../syntax/model.js";
import type { Delta } from "../delta/types.js";
/** Full result validation composes outer description and the semantic owner's strict View reader. */
export function readCommandResult(
  delta: Delta,
  expected: { receiver: string; configuration: string; request: string },
): ReadOutcome & { readonly view?: View } {
  verifyCommandAppearance(delta);
  const result = readOutcome(delta);
  if (
    delta.claims.author !== expected.receiver ||
    commandEntity(result.fields, "receiver") !== expected.receiver ||
    commandRef(result.fields, "configuration") !== expected.configuration ||
    commandRef(result.fields, "request") !== expected.request
  )
    throw new Error("command outcome attribution mismatch");
  return { ...result, ...(result.value === undefined ? {} : { view: decodeView(result.value) }) };
}
