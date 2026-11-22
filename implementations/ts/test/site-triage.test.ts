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
import { MAPPING_ADDS, SPELLINGS_LINE, pageText, short } from "../demo/site/page-text.js";

describe("the landing page's release triage", () => {
  it("signs every published claim with its author's fixed key", () => {
    for (const d of [...TOOL_CLAIMS, ...MAPPER_CLAIMS]) expect(verifyDelta(d)).toBe("verified");
    expect(MAPPER_CLAIMS.every((d) => d.claims.author === SAM.author)).toBe(true);
    expect(adaptReleaseScript({ build: "web@4.2.0", status: "ship" }, 1000).id).toBe(
      ENGINEER_CLAIM.id,
    );
  });

  it("without the mapping the gate answers ship from the status claim and leaves the verdict claim unmatched", () => {
    for (const policy of ["latest", "engineering"] as const) {
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

  it("with the mapping, highest claimed timestamp wins answers block from the later support claim", () => {
    expect(SUPPORT_CLAIM.claims.timestamp).toBeGreaterThan(ENGINEER_CLAIM.claims.timestamp);
    expect(MAPPER_CLAIMS.every((d) => d.claims.timestamp > SUPPORT_CLAIM.claims.timestamp)).toBe(
      true,
    );
    const g = gate({ mapping: true, policy: "latest" });
    expect(g.answer).toBe("block");
    expect(g.decidedBy?.id).toBe(SUPPORT_CLAIM.id);
    expect(g.decidedBy?.spelling).toBe("verdict");
  });

  it("with the mapping, engineering's word wins answers ship from the release script claim", () => {
    const g = gate({ mapping: true, policy: "engineering" });
    expect(g.answer).toBe("ship");
    expect(g.decidedBy?.id).toBe(ENGINEER_CLAIM.id);
    expect(g.decidedBy?.spelling).toBe("status");
  });

  it("with the mapping the report from the pack shows both claims, both signers and the conflict", () => {
    const r = report({ mapping: true });
    expect(r.fromPack).toBe(true);
    expect(r.packedClaims).toBe(5);
    expect(r.packAuthors).toBe(3);
    expect(r.claims.map((c) => c.id).sort()).toEqual([ENGINEER_CLAIM.id, SUPPORT_CLAIM.id].sort());
    expect(r.signers).toEqual([ENGINEER.author, SUPPORT.author].sort());
    expect(r.view).toEqual({ decision: ["block", "ship"] });
  });

  it("the report from a pack round trip equals the report from the live set", () => {
    for (const mapping of [true, false]) {
      const { fromPack, packId, packBytes, packedClaims, packAuthors, ...packed } = report({
        mapping,
      });
      expect([fromPack, packedClaims, packAuthors]).toEqual([
        true,
        published(mapping).size,
        mapping ? 3 : 2,
      ]);
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
    expect(r.packAuthors).toBe(2);
    expect(r.claims.map((c) => c.id)).toEqual([SUPPORT_CLAIM.id]);
    expect(r.signers).toEqual([SUPPORT.author]);
    expect(r.view).toEqual({});
  });

  it("a pack without the support claim gives a report of the release script claim alone, while the live set holds both", () => {
    const live = published(true);
    const pack = packSet(DeltaSet.from([...live].filter((d) => d.id !== SUPPORT_CLAIM.id)));
    expect(
      reportFrom(live)
        .claims.map((c) => c.id)
        .sort(),
    ).toEqual([ENGINEER_CLAIM.id, SUPPORT_CLAIM.id].sort());
    const r = reportFromPack(pack);
    expect(r.packedClaims).toBe(4);
    expect(r.packAuthors).toBe(2);
    expect(r.claims.map((c) => c.id)).toEqual([ENGINEER_CLAIM.id]);
    expect(r.signers).toEqual([ENGINEER.author]);
    expect(r.view).toEqual({});
  });

  it("the page text names the gate answer, the deciding claim and the report view for every switch state", () => {
    const off = { gateTitle: 'in the HyperView under "decision": 1 claim' };
    const offReport = {
      reportView: "{}",
      reportMatched: "The report matched 1 claim. No conflict to keep.",
    };
    const onReport = {
      reportView: '{"decision":["block","ship"]}',
      reportMatched: "The report matched 2 claims.",
    };
    const by = (d: typeof ENGINEER_CLAIM, who: string) =>
      `decided by: ${who}, claim ${short(d.id)}`;
    const cases = [
      [
        { mapping: false, policy: "latest" },
        "ship",
        by(ENGINEER_CLAIM, ENGINEER.name),
        off,
        offReport,
      ],
      [
        { mapping: false, policy: "engineering" },
        "ship",
        by(ENGINEER_CLAIM, ENGINEER.name),
        off,
        offReport,
      ],
      [{ mapping: true, policy: "latest" }, "block", by(SUPPORT_CLAIM, SUPPORT.name), {}, onReport],
      [
        { mapping: true, policy: "engineering" },
        "ship",
        by(ENGINEER_CLAIM, ENGINEER.name),
        {},
        onReport,
      ],
    ] as const;
    for (const [input, answer, decided, gateExtra, reportExtra] of cases) {
      const t = pageText(input);
      expect(t, JSON.stringify(input)).toMatchObject({
        gateAnswer: answer,
        gateDecided: decided,
        ...gateExtra,
        ...reportExtra,
      });
      expect(t.gateTitle).toBe(
        `in the HyperView under "decision": ${input.mapping ? "2 claims" : "1 claim"}`,
      );
      expect(t.reportMeta).toMatch(
        input.mapping
          ? /^Pack .+… contains 5 claims in \d+ bytes\. The claims carry signatures from 3 authors\.$/
          : /^Pack .+… contains 2 claims in \d+ bytes\. The claims carry signatures from 2 authors\.$/,
      );
      expect(Object.values(t).join(" ")).not.toContain("(s)");
    }
    expect(SPELLINGS_LINE).toBe('This reader asks for "verdict". The gate asks for "status".');
    expect(MAPPING_ADDS).toBe(MAPPER_CLAIMS.map((d) => short(d.id)).join(", "));
  });

  it("no singular-or-plural (s) form appears on the page or in its scripts", () => {
    for (const path of [
      "../demo/site/landing.ts",
      "../demo/site/page-text.ts",
      "../../../docs/index.html",
    ]) {
      expect(readFileSync(new URL(path, import.meta.url), "utf8"), path).not.toContain("(s)");
    }
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
