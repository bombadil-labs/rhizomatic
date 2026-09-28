import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleEntryStatus } from "../src/federation/entry.js";
import { computeId } from "../src/delta/delta.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import { makeManifestClaims } from "../src/reactor/reactor.js";
import type { Claims, Delta } from "../src/delta/types.js";

interface Case {
  name: string;
  firstUnsigned?: boolean;
  secondAuthor?: "other";
  secondSigned?: boolean;
  active?: "all" | "first";
  refused?: "second";
  mutation?: "missingSecond" | "duplicateFirst" | "forgeManifest" | "forgeSecondId";
  expected: string;
}
const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/peer/bundle-entry.json"), "utf8"),
) as { cases: Case[] };
const ownSeed = "01".repeat(32);
const otherSeed = "02".repeat(32);
const ownAuthor = authorForSeed(ownSeed);

function member(label: string, author: string, seed?: string): Delta {
  const claims: Claims = {
    timestamp: 1,
    validFrom: 1,
    author,
    pointers: [{ role: "note", target: { kind: "primitive", value: label } }],
  };
  return seed === undefined ? { id: computeId(claims), claims } : signClaims(claims, seed);
}

describe("shared SPEC-6 bundle entry vectors", () => {
  for (const c of vector.cases) {
    it(c.name, () => {
      const first = member("first", ownAuthor, c.firstUnsigned ? undefined : ownSeed);
      const secondSeed = c.secondAuthor === "other" ? otherSeed : ownSeed;
      const second = member(
        "second",
        authorForSeed(secondSeed),
        c.secondSigned ? secondSeed : undefined,
      );
      let manifest = signClaims(makeManifestClaims(ownAuthor, 2, [first.id, second.id]), ownSeed);
      let members: Delta[] = [first, second];
      if (c.mutation === "missingSecond") members = [first];
      if (c.mutation === "duplicateFirst") members = [first, first];
      if (c.mutation === "forgeManifest") manifest = { ...manifest, sig: "00".repeat(64) };
      if (c.mutation === "forgeSecondId")
        members = [first, { ...second, id: `1e20${"00".repeat(32)}` }];
      const active = new Set(
        c.active === "all"
          ? [manifest.id, first.id, second.id]
          : c.active === "first"
            ? [first.id]
            : [],
      );
      const refused = new Set(c.refused === "second" ? [second.id] : []);
      expect(bundleEntryStatus(manifest, members, active, refused)).toBe(c.expected);
    });
  }
});
