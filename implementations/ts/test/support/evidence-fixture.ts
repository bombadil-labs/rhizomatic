// Test/serialized adapter only: explicit debug model, never imported by the core.
import { parseClaims, claimsToJson } from "../../src/delta/json-profile.js";
import { parseSchema } from "../../src/syntax/term-json.js";
import { schemaToJson } from "../../src/syntax/term-io.js";
import type { HView, HVEntry } from "../../src/algebra/hview.js";
export function fixtureView(input: unknown): HView {
  const n = input as {
    id: string;
    props: Record<
      string,
      {
        delta: { id: string; claims: unknown; sig?: string };
        negated: boolean;
        expanded: [number, unknown][];
        readings: [number, unknown][];
      }[]
    >;
  };
  return {
    id: n.id,
    props: new Map(
      Object.entries(n.props).map(([k, es]) => [
        k,
        es.map((e) => ({
          delta: { ...e.delta, claims: parseClaims(e.delta.claims) },
          negated: e.negated,
          expanded: new Map(e.expanded.map(([i, c]) => [i, fixtureView(c)])),
          readings: new Map(e.readings.map(([i, r]) => [i, parseSchema(r)])),
        })),
      ]),
    ),
  };
}
export function inspectView(n: HView): unknown {
  const entry = (e: HVEntry): unknown => ({
    delta: {
      id: e.delta.id,
      claims: claimsToJson(e.delta.claims),
      ...(e.delta.sig === undefined ? {} : { sig: e.delta.sig }),
    },
    negated: e.negated,
    expanded: [...(e.expanded ?? [])].map(([i, c]) => [i, inspectView(c)]),
    readings: [...(e.readings ?? [])].map(([i, r]) => [i, schemaToJson(r)]),
  });
  return { id: n.id, props: Object.fromEntries([...n.props].map(([k, es]) => [k, es.map(entry)])) };
}
