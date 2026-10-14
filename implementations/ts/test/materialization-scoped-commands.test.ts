// Scoped batch gather (SPEC-16 §4a): each shared delivery, replayed into a fresh endpoint, yields
// the exact recorded outcome; refusals carry the codes §4a names; and the completed scoped read
// shows the same HView a whole-store evaluation shows.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decode } from "../src/delta/cbor.js";
import { parseClaims } from "../src/delta/json-profile.js";
import { DeltaSet, makeDelta } from "../src/delta/set.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import type { Delta } from "../src/delta/types.js";
import { hviewCanonicalHex } from "../src/algebra/hview.js";
import { decodeHViewEnvelope } from "../src/algebra/hview-envelope.js";
import { commandBytes, commandText } from "../src/command-data/codec.js";
import { readMaterializationDescription } from "../src/command-data/materialization-codec.js";
import { MaterializationEndpoint } from "../src/command/materialization-endpoint.js";
import { evalTerm } from "../src/resolve/eval.js";
import { SchemaRegistry } from "../src/schema/schema.js";
import { parseSchema, parseTerm } from "../src/syntax/term-json.js";

interface Wire {
  id: string;
  claims: unknown;
  sig?: string;
}
const v = JSON.parse(
  readFileSync(
    new URL("../../../vectors/materialization/scoped-commands.json", import.meta.url),
    "utf8",
  ),
) as {
  seeds: { receiver: string };
  boot: { configuration: Wire; declarations: Wire[]; bindings: Wire[] };
  wholeStore: Wire[];
  cases: {
    id: string;
    binding: string;
    scope: string[] | null;
    root: string;
    revision: string;
    request: Wire;
    delivery: Wire[];
    expected: { outcome: Wire; checks: (string[] | null)[] };
  }[];
};
const delta = (w: Wire): Delta => {
  const d = makeDelta(parseClaims(w.claims), w.sig);
  expect(d.id).toBe(w.id);
  return d;
};
const receiver = authorForSeed(v.seeds.receiver);
const expectedCodes: Record<string, string | undefined> = {
  scoped_bed_tree: undefined,
  scope_misses_a_child: "scope-miss",
  scope_misses_the_root: "scope-miss",
  unanchored_program: "unsupported-operation",
  full_binding_scoped_capture: "invalid-source",
  scoped_binding_full_capture: "invalid-source",
};

for (const c of v.cases)
  it(`scoped gather ${c.id}`, async () => {
    const checks: (readonly string[] | null)[] = [];
    const endpoint = MaterializationEndpoint.boot({
      configuration: delta(v.boot.configuration),
      declarations: v.boot.declarations.map(delta),
      bindings: v.boot.bindings.map(delta),
      signer: { author: receiver, sign: (claims) => signClaims(claims, v.seeds.receiver) },
      sourceGrants: new Map(
        v.boot.bindings.map((b) => [
          b.id,
          {
            capture: () => Promise.resolve({ status: "source-unavailable" as const }),
            reacquireSnapshot: () => Promise.resolve({ status: "source-unavailable" as const }),
            checkCurrent: (
              _b: string,
              revision: string,
              _a: string,
              _at: number,
              _cut: number | undefined,
              _s: readonly string[],
              scope?: readonly string[],
            ) => {
              checks.push(scope ?? null);
              return Promise.resolve(
                revision === c.revision
                  ? { status: "current" as const }
                  : { status: "source-changed" as const },
              );
            },
          },
        ]),
      ),
      diagnostic: () => {},
    });
    const outcome = await endpoint.invoke(c.request.id, c.delivery, 1000);
    expect(outcome).toEqual(delta(c.expected.outcome));
    expect(checks).toEqual(c.expected.checks);
    const f = readMaterializationDescription(outcome);
    const body = decode(commandBytes(f, "result"));
    const fields = new Map(body.t === "map" ? body.v : []);
    const code = expectedCodes[c.id];
    if (code === undefined) {
      expect(commandText(f, "status")).toBe("completed");
      // A completed scoped read equals a whole-store read of the same program.
      const envelope = fields.get("envelope");
      if (envelope?.t !== "bstr") throw Error("no envelope");
      const leaf = {
        op: "group",
        key: "byTargetContext",
        in: {
          op: "select",
          pred: { hasPointer: { targetEntity: { var: "root" } } },
          in: { op: "mask", policy: "drop", in: "input" },
        },
      };
      const reading = parseSchema({
        name: "Plant",
        alg: 1,
        props: {},
        default: { pick: { order: { byTimestamp: "desc" } } },
      });
      const registry = SchemaRegistry.build(
        [{ name: "Plant", alg: 1, body: parseTerm(leaf) }],
        [reading],
      );
      const bed = parseTerm({
        op: "expand",
        role: { exact: "plant" },
        schema: "Plant",
        reading: "Plant",
        in: leaf,
      });
      const store = DeltaSet.from(v.wholeStore.map(delta));
      const expected = evalTerm(bed, store, 1000, c.root, registry);
      if (expected.sort !== "hview") throw Error();
      expect(hviewCanonicalHex(decodeHViewEnvelope(envelope.v))).toBe(
        hviewCanonicalHex(expected.hview),
      );
    } else {
      expect(commandText(f, "status")).toBe("refused");
      const got = fields.get("code");
      expect(got?.t === "tstr" ? got.v : undefined).toBe(code);
    }
  });
