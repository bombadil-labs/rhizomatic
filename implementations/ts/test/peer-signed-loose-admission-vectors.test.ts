import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/delta/json-profile.js";
import type { Delta } from "../src/delta/types.js";
import {
  decodeDurablePeerState,
  encodeDurablePeerState,
  writeDurablePeerState,
} from "../src/federation/durable-state.js";
import {
  admitSignedLooseOrdinaryTransfer,
  planSignedLooseOrdinaryTransfer,
} from "../src/federation/signed-loose-admission.js";

interface Case {
  name: string;
  beforeCase: number;
  afterCase: number;
  offered: string[];
  guardReject?: string[];
  erasure?: string[];
  corruptSignature?: string[];
  capacity: number;
  at: number;
  sender: string;
  expected: string[];
}
const read = (name: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../vectors", name), "utf8")) as never;
const cases = (read("peer/signed-loose-admission.json") as { cases: Case[] }).cases;
const images = (read("peer/durable-state.json") as { cases: Array<{ expectedHex: string }> }).cases;
const fixture = read("principal/evidence.json") as {
  deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }>;
};
const named = new Map<string, Delta>(
  fixture.deltas.map((row) => [
    row.name,
    { id: row.id, claims: parseClaims(row.claims), ...(row.sig ? { sig: row.sig } : {}) },
  ]),
);
const id = (name: string) => named.get(name)!.id;
const image = (index: number) => Uint8Array.from(Buffer.from(images[index]!.expectedHex, "hex"));

function input(c: Case, reverse = false) {
  const offered = c.offered.map((name) => {
    const delta = named.get(name)!;
    return c.corruptSignature?.includes(name) ? { ...delta, sig: "00" } : delta;
  });
  return {
    offered: reverse ? offered.reverse() : offered,
    sendingPeerId: c.sender,
    arrivedAt: c.at,
    capacity: c.capacity,
    policyState: {},
    guards: [
      (context: { candidate: Delta }) =>
        !c.guardReject?.some((name) => id(name) === context.candidate.id),
    ],
    isErasureCandidate: (delta: Delta) => c.erasure?.some((name) => id(name) === delta.id) ?? false,
  };
}

describe("shared SPEC-6 signed loose ordinary admission", () => {
  for (const c of cases) {
    it(c.name, () => {
      const before = decodeDurablePeerState(image(c.beforeCase), "peer-A");
      const plan = planSignedLooseOrdinaryTransfer(before, input(c));
      expect(plan.outcomes.map((row) => row.status)).toEqual(c.expected);
      expect(Buffer.from(encodeDurablePeerState(plan.state)).toString("hex")).toBe(
        images[c.afterCase]!.expectedHex,
      );
      const reversed = planSignedLooseOrdinaryTransfer(before, input(c, true));
      expect(encodeDurablePeerState(reversed.state)).toEqual(encodeDurablePeerState(plan.state));
    });
  }

  it("commits against its planning image and rejects a stale image", () => {
    const dir = mkdtempSync(join(tmpdir(), "rhizomatic-ordinary-admission-"));
    const path = join(dir, "peer.bin");
    try {
      const empty = image(0);
      writeDurablePeerState(path, decodeDurablePeerState(empty, "peer-A"), null);
      const c = cases[0]!;
      const result = admitSignedLooseOrdinaryTransfer(path, empty, "peer-A", input(c));
      expect(result.write).toEqual({ status: "durable" });
      expect(readFileSync(path).toString("hex")).toBe(images[1]!.expectedHex);
      expect(() => admitSignedLooseOrdinaryTransfer(path, empty, "peer-A", input(c))).toThrow(
        "expected prior image changed",
      );
      expect(readFileSync(path).toString("hex")).toBe(images[1]!.expectedHex);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the verified candidate when a guard mutates the caller's offer", () => {
    const transfer = input(cases[0]!);
    const verifiedId = id("userRootDeclaration");
    transfer.guards[0] = () => {
      transfer.offered[0] = named.get("operatorRootDeclaration")!;
      return true;
    };
    const before = decodeDurablePeerState(image(0), "peer-A");
    const plan = planSignedLooseOrdinaryTransfer(before, transfer);
    expect(plan.outcomes).toEqual([{ id: verifiedId, status: "admitted" }]);
    expect(Buffer.from(encodeDurablePeerState(plan.state)).toString("hex")).toBe(
      images[1]!.expectedHex,
    );
  });
});
