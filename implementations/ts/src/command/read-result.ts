import {
  readOutcome,
  verifyCommandAppearance,
  commandEntity,
  commandRef,
  readRequestArguments,
  commandText,
  commandNumber,
  type ReadOutcome,
} from "../command-data/codec.js";
import { array, encode, tstr, type CborValue } from "../delta/cbor.js";
import { contentAddress } from "../delta/hash.js";
import { decodeView } from "../resolve-kernel/resolution.js";
import type { View } from "../syntax/model.js";
import type { Delta } from "../delta/types.js";
/** Full result validation: attribution, optional originating request, and strict View reconstruction. */
export function readCommandResult(
  delta: Delta,
  expected: { receiver: string; configuration: string; request: string },
  originatingRequest?: Delta,
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
  // A receiver may refuse an invalid appearance; that refusal does not authenticate the request.
  if (result.status === "completed" && originatingRequest) {
    verifyCommandAppearance(originatingRequest);
    if (originatingRequest.id !== expected.request)
      throw new Error("command originating request mismatch");
    const bodyText = (key: string) => {
      const v = result.body.get(key);
      if (v?.t !== "tstr") throw new Error("command body text expected");
      return v.v;
    };
    const kind = bodyText("kind");
    if (kind !== "retain" && kind !== "evaluate") throw new Error("command result kind");
    const request = readRequestArguments(originatingRequest, kind);
    if (
      commandEntity(request, "receiver") !== expected.receiver ||
      commandRef(request, "configuration") !== expected.configuration
    )
      throw new Error("command request context mismatch");
    if (kind === "retain") {
      const offered = (request.payload ?? [])
        .map((t) => (t.kind === "delta" ? t.deltaRef.delta : ""))
        .sort();
      const ids = (value: CborValue | undefined) =>
        value?.t === "array" ? value.v.map((v) => (v.t === "tstr" ? v.v : "")) : [];
      const actual = [
        ...ids(result.body.get("admitted")),
        ...ids(result.body.get("duplicate")),
      ].sort();
      if (offered.length !== actual.length || offered.some((id, i) => id !== actual[i]))
        throw new Error("command incomplete retain partition");
    } else {
      const at = result.body.get("at");
      if (
        at?.t !== "float" ||
        at.v !== commandNumber(request, "at") ||
        bodyText("source") !== commandText(request, "source") ||
        bodyText("interpretation") !== commandText(request, "interpretation") ||
        bodyText("hyperschemaPin") !== commandText(request, "hyperschema-pin") ||
        bodyText("schemaPin") !== commandText(request, "schema-pin")
      )
        throw new Error("command evaluation context mismatch");
      const definitions = [
        commandRef(request, "hyperschema"),
        commandRef(request, "schema"),
        ...(request.definition ?? []).map((t) => (t.kind === "delta" ? t.deltaRef.delta : "")),
      ].sort();
      const digest = contentAddress(encode(array(definitions.map(tstr))));
      if (bodyText("definitionDigest") !== digest)
        throw new Error("command definition digest mismatch");
    }
  }
  return { ...result, ...(result.value === undefined ? {} : { view: decodeView(result.value) }) };
}
