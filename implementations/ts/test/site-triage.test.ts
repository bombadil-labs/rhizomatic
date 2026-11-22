import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { packSet, unpackSet } from "../src/pack.js";
import { DeltaSet } from "../src/set.js";
import { verifyDelta } from "../src/sign.js";
import {
  ENGINEER,
  ENGINEER_CLAIM,
  MAPPER_CLAIMS,
  SAM,
  SUPPORT,
  SUPPORT_CLAIM,
  TOOL_CLAIMS,
  adaptReleaseScript,
  gate,
  published,
  report,
  reportFrom,
  reportFromPack,
} from "../demo/site/triage.js";

describe("the landing page's release triage", () => {
  it("signs every published claim with its author's fixed key", () => {
    for (const d of [...TOOL_CLAIMS, ...MAPPER_CLAIMS]) expect(verifyDelta(d)).toBe("verified");
    expect(MAPPER_CLAIMS.every((d) => d.claims.author === SAM.author)).toBe(true);
    expect(adaptReleaseScript({ build: "web@4.2.0", status: "ship" }, 2000).id).toBe(
      ENGINEER_CLAIM.id,
    );
  });

  it("without the mapping the gate answers ship from the status claim and leaves the verdict claim unmatched", () => {
    for (const policy of ["latest", "support"] as const) {
      const g = gate({ mapping: false, policy });
      expect(g.answer).toBe("ship");
      expect(g.inView.map((c) => c.id)).toEqual([ENGINEER_CLAIM.id]);
      expect(g.decidedBy?.id).toBe(ENGINEER_CLAIM.id);
      expect(published(false).has(SUPPORT_CLAIM.id)).toBe(true);
      expect(g.notMatched.map((c) => c.id)).toEqual([SUPPORT_CLAIM.id]);
    }
  });

  it("with the mapping the view holds both claims under one property, two authors and both spellings", () => {
    const g = gate({ mapping: true, policy: "latest" });
    expect(g.inView.map((c) => c.id).sort()).toEqual([ENGINEER_CLAIM.id, SUPPORT_CLAIM.id].sort());
    expect(new Set(g.inView.map((c) => c.author))).toEqual(
      new Set([ENGINEER.author, SUPPORT.author]),
    );
    expect(g.inView.map((c) => c.spelling).sort()).toEqual(["status", "verdict"]);
    expect(g.notMatched).toEqual([]);
    expect(Object.keys(g.view as object)).toEqual(["decision"]);
  });

  it("with the mapping, latest claim wins answers the later claim's value", () => {
    const g = gate({ mapping: true, policy: "latest" });
    const later = [ENGINEER_CLAIM, SUPPORT_CLAIM].sort(
      (a, b) => b.claims.timestamp - a.claims.timestamp,
    )[0]!;
    expect(g.decidedBy?.id).toBe(later.id);
    expect(g.answer).toBe(g.decidedBy?.value);
    expect(g.answer).toBe("ship");
  });

  it("with the mapping, support's word wins answers block from the support claim", () => {
    const g = gate({ mapping: true, policy: "support" });
    expect(g.answer).toBe("block");
    expect(g.decidedBy?.id).toBe(SUPPORT_CLAIM.id);
    expect(g.decidedBy?.spelling).toBe("verdict");
  });

  it("with the mapping the report from the pack shows both claims, both signers and the conflict", () => {
    const r = report({ mapping: true });
    expect(r.fromPack).toBe(true);
    expect(r.packedClaims).toBe(5);
    expect(r.claims.map((c) => c.id).sort()).toEqual([ENGINEER_CLAIM.id, SUPPORT_CLAIM.id].sort());
    expect(r.signers).toEqual([ENGINEER.author, SUPPORT.author].sort());
    expect(r.view).toEqual({ decision: ["ship", "block"] });
  });

  it("the report from a pack round trip equals the report from the live set", () => {
    for (const mapping of [true, false]) {
      const { fromPack, packId, packBytes, packedClaims, ...packed } = report({ mapping });
      expect([fromPack, packedClaims]).toEqual([true, published(mapping).size]);
      expect(packId.length).toBeGreaterThan(0);
      expect(packBytes).toBeGreaterThan(0);
      expect(packed).toEqual(reportFrom(published(mapping)));
    }
  });

  it("with the mapper's claims removed from the pack the report shows one claim and no conflict", () => {
    const full = unpackSet(packSet(published(true)));
    const without = DeltaSet.from([...full].filter((d) => d.claims.author !== SAM.author));
    const r = reportFromPack(packSet(without));
    expect(r.packedClaims).toBe(2);
    expect(r.claims.map((c) => c.id)).toEqual([SUPPORT_CLAIM.id]);
    expect(r.signers).toEqual([SUPPORT.author]);
    expect(r.view).toEqual({});
  });

  it("every element id that the landing script looks up exists once in docs/index.html", () => {
    const script = readFileSync(new URL("../demo/site/landing.ts", import.meta.url), "utf8");
    const page = readFileSync(new URL("../../../docs/index.html", import.meta.url), "utf8");
    const typed = [...script.matchAll(/^\s+\| "([a-z-]+)"$/gm)].map((m) => m[1]!);
    const looked = [...script.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]!);
    expect(typed.length).toBeGreaterThan(10);
    expect(new Set(looked).size).toBeGreaterThan(10);
    for (const id of new Set([...typed, ...looked])) {
      expect(page.split(`id="${id}"`).length - 1, id).toBe(1);
    }
    expect(page).toContain('<script src="landing.bundle.js"');
  });
});
