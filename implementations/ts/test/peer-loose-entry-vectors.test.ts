import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { looseEntryStatus } from "../src/federation/entry.js";
import { parseClaims } from "../src/json-profile.js";
import type { Delta } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/principal/evidence.json"), "utf8"),
) as { deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }> };
const vector = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/peer/loose-entry.json"), "utf8"),
) as {
  cases: Array<{
    name: string;
    candidate: string;
    mutation?: "dropSignature" | "changeSignature" | "changeId";
    active: string[];
    refused: string[];
    expected: string;
  }>;
};
const named = new Map<string, Delta>(
  fixture.deltas.map((row) => [
    row.name,
    {
      id: row.id,
      claims: parseClaims(row.claims),
      ...(row.sig === undefined ? {} : { sig: row.sig }),
    },
  ]),
);

describe("shared SPEC-6 loose entry vectors", () => {
  for (const c of vector.cases) {
    it(c.name, () => {
      const original = named.get(c.candidate)!;
      const delta: Delta =
        c.mutation === "dropSignature"
          ? { id: original.id, claims: original.claims }
          : c.mutation === "changeSignature"
            ? { ...original, sig: "00".repeat(64) }
            : c.mutation === "changeId"
              ? { ...original, id: `1e20${"00".repeat(32)}` }
              : original;
      expect(
        looseEntryStatus(
          delta,
          new Set(c.active.map((name) => named.get(name)!.id)),
          new Set(c.refused.map((name) => named.get(name)!.id)),
        ),
      ).toBe(c.expected);
    });
  }
});
