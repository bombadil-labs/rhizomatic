// The strings that the landing page shows, as a pure function of the fixture's answers. The
// landing script writes them into the DOM; the tests read them without one.

import {
  GATE_SPELLING,
  MAPPER_CLAIMS,
  REPORT_SPELLING,
  gate,
  report,
  type PolicyName,
} from "./triage.js";

export const short = (id: string): string => `${id.slice(4, 16)}…`;

export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

export const MAPPING_ADDS = MAPPER_CLAIMS.map((d) => short(d.id)).join(", ");

export const SPELLINGS_LINE = `This reader asks for "${REPORT_SPELLING}". The gate asks for "${GATE_SPELLING}".`;

export interface PageText {
  readonly gateAnswer: string;
  readonly gateDecided: string;
  readonly gateTitle: string;
  readonly reportMeta: string;
  readonly reportView: string;
  readonly reportMatched: string;
}

export function pageText(input: { mapping: boolean; policy: PolicyName }): PageText {
  const g = gate(input);
  const r = report({ mapping: input.mapping });
  return {
    gateAnswer: g.answer === undefined ? "(no answer)" : String(g.answer),
    gateDecided:
      g.decidedBy === undefined
        ? ""
        : `decided by: ${g.decidedBy.who}, claim ${short(g.decidedBy.id)}`,
    gateTitle: `in the HyperView under "decision": ${count(g.inView.length, "claim")}`,
    reportMeta:
      `The pack holds ${count(r.packedClaims, "claim")} in ${count(r.packBytes, "byte")}, ` +
      `pack ${short(r.packId)}, signed by ${count(r.packAuthors, "author")}.`,
    reportView: JSON.stringify(r.view),
    reportMatched:
      `The report matched ${count(r.claims.length, "claim")}.` +
      (r.claims.length < 2 ? " No conflict to keep." : ""),
  };
}
