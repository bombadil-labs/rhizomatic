import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/json-profile.js";
import { Reactor } from "../src/reactor.js";
import { makeDelta } from "../src/set.js";
import type { Delta } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/peer/atomic-transfer.json"), "utf8"),
) as {
  deltas: Array<{ name: string; claims: unknown }>;
  cases: Array<{
    name: string;
    before: string[];
    offer: string[];
    status: string;
    after: string[];
  }>;
};
const named = new Map(vector.deltas.map((row) => [row.name, makeDelta(parseClaims(row.claims))]));
const forgedTwo: Delta = { ...named.get("two")!, id: `1e20${"00".repeat(32)}` };
named.set("forgedTwo", forgedTwo);
named.set("forgedOne", { ...named.get("one")!, claims: named.get("two")!.claims });

describe("shared SPEC-6 atomic transfer vectors", () => {
  for (const c of vector.cases) {
    it(c.name, () => {
      const reactor = new Reactor();
      for (const name of c.before)
        expect(reactor.ingest(named.get(name)!)).toEqual({ status: "accepted" });
      const result = reactor.ingestBatch(c.offer.map((name) => named.get(name)!));
      expect(result.status).toBe(c.status);
      const actual = [...reactor.arrivalLog()]
        .map(
          (d) =>
            [...named].find(([name, value]) => !name.startsWith("forged") && value.id === d.id)![0],
        )
        .sort();
      expect(actual).toEqual([...c.after].sort());
    });
  }

  it("every raw subscriber sees the whole accepted update", () => {
    const reactor = new Reactor();
    const sizes: number[] = [];
    reactor.subscribeRaw(() => sizes.push(reactor.size));
    expect(reactor.ingestBatch([named.get("one")!, named.get("two")!])).toEqual({
      status: "accepted",
    });
    expect(sizes).toEqual([2, 2]);
  });
});
