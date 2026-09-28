import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeDurablePeerState } from "../src/federation/durable-state.js";
import type { ClosedImportState } from "../src/federation/closed-import.js";
import type { ImportedObligationCarry } from "../src/federation/imported-obligations.js";
import { decodeRefusalSnapshot } from "../src/federation/refusal-snapshot.js";
import { importedCase } from "./peer-imported-holdings-fixture.js";

const vector = (name: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../vectors/peer/${name}`, import.meta.url)), "utf8"),
  );
const durable = vector("durable-state.json") as { cases: Array<{ expectedHex: string }> };
const refusals = vector("refusal-snapshot.json") as { cases: Array<{ expectedHex: string }> };
const obligationCarries = vector("imported-obligations.json") as {
  cases: ImportedObligationCarry[];
};

export interface ClosedImportCase {
  name: string;
  snapshotCase: number;
  holdings: string[];
  cover: boolean;
  obligationCase: number | null;
  expectedHex: string;
  carriedDigest: string;
  policyDigest: string;
}

function local(index: number) {
  const original = decodeDurablePeerState(
    Buffer.from(durable.cases[index]!.expectedHex, "hex"),
    "peer-A",
  );
  return { ...original, base: { ...original.base, peerId: "peer-new" } };
}

export function closedImportCase(c: ClosedImportCase): ClosedImportState {
  return {
    attemptId: "attempt-1",
    oldPeerId: "peer-A",
    oldStateVersion: 9,
    deadline: 5000,
    closed: {
      local: local(0),
      inherited: decodeRefusalSnapshot(
        Buffer.from(refusals.cases[c.snapshotCase]!.expectedHex, "hex"),
      ),
    },
    obligations:
      c.obligationCase === null
        ? { obligations: [] }
        : { obligations: structuredClone(obligationCarries.cases[c.obligationCase]!.obligations) },
    holdings: importedCase(c.holdings, c.cover),
    policyFormat: "rhizomatic.peer.policy.test.v1",
    policyBytes: new TextEncoder().encode("host-law:peer-A"),
  };
}

export function invalidClosedImportCase(c: ClosedImportCase, mutation: string): ClosedImportState {
  const state = closedImportCase(c);
  switch (mutation) {
    case "nonempty-local":
      return { ...state, closed: { ...state.closed, local: local(1) } };
    case "same-peer":
      return { ...state, oldPeerId: "peer-new" };
    case "missing-policy":
      return { ...state, policyBytes: new Uint8Array() };
    case "unsafe-version":
      return { ...state, oldStateVersion: Number.MAX_SAFE_INTEGER + 1 };
    case "stale-obligation":
      return {
        ...state,
        obligations: {
          obligations: state.obligations.obligations.map((row) => ({
            ...row,
            event: { ...row.event, sequence: 3 },
          })),
        },
      };
    case "new-peer-obligation":
      return {
        ...state,
        obligations: {
          obligations: state.obligations.obligations.map((row) => ({
            ...row,
            sourcePeerId: "peer-new",
          })),
        },
      };
    default:
      throw new Error(`unknown closed import mutation ${mutation}`);
  }
}
