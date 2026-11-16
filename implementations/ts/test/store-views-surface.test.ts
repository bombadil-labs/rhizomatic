// The package root reaches no wrong holder (docs/audits/2026-11-15-necessity-audit.md, "Production
// code carries intentional failures"). Every import here is a root export.
import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";
import { StoreViews, createMemoryStore, makeDelta, parseTerm } from "../src/index.js";
import type { Delta } from "../src/index.js";

const PEER = `ed25519:${"7e".repeat(32)}`;
const MARKER = "erase-me-surface-4c1d";
const hexOf = (text: string): string => Buffer.from(text, "utf8").toString("hex");
const LEAF = parseTerm({
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
});
const fact = (entity: string, t: number, value: string): Delta =>
  makeDelta({
    timestamp: t,
    validFrom: t,
    author: "did:key:zA",
    pointers: [
      { role: "subject", target: { kind: "entity", entity: { id: entity, context: "subject" } } },
      { role: "value", target: { kind: "primitive", value } },
    ],
  });

async function peerWith(deltas: readonly Delta[]) {
  const peer = await createMemoryStore().createPeer(PEER, { erasure: "unproven" });
  const added = deltas.map((delta, i) => ({
    delta,
    arrival: { id: delta.id, at: 1, sequence: i + 1, transfer: 1, sender: "local" },
  }));
  const result = await peer.append({ expectedHead: null, nextHead: "h1", frame: null, added });
  if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
  return peer;
}

describe("StoreViews from the package root", () => {
  it("ignores a third constructor argument: a refresh after a purge answers before null and no purged bytes, and the bystander keeps its bytes", async () => {
    const secret = fact("target", 1, MARKER);
    const kept = fact("target", 2, "kept");
    const other = fact("bystander", 3, "bystander-value");
    const peer = await peerWith([secret, kept, other]);
    const Constructor = StoreViews as unknown as new (...args: unknown[]) => StoreViews;
    const views = new Constructor(peer, {}, { keepPurgedBaseline: true });
    views.register("leaf", { term: LEAF });
    views.register("by", { term: LEAF });
    const target = await views.hold("leaf", "target", 10);
    const bystander = await views.hold("by", "bystander", 10);
    expect(target.bytes).toContain(hexOf(MARKER));
    expect(bystander.bytes).toContain(hexOf("bystander-value"));

    await peer.purge([secret.id]);
    const refreshed = await views.refresh(10);

    const change = refreshed.changed.find((c) => c.name === "leaf" && c.root === "target");
    expect(change?.before).toBeNull();
    expect(change?.after).toContain(hexOf(kept.id));
    const answer = JSON.stringify(refreshed);
    for (const needle of [secret.id, hexOf(secret.id), MARKER, hexOf(MARKER)])
      expect(answer).not.toContain(needle);
    expect(refreshed.changed.map((c) => c.name)).toEqual(["leaf"]);
    const again = await views.hold("by", "bystander", 10);
    expect([again.from, again.bytes]).toEqual(["held", bystander.bytes]);
  });

  it("exports no quirk, and a holder carries no quirk property", async () => {
    expect(Object.keys(root).filter((name) => /quirk/i.test(name))).toEqual([]);
    const views = new StoreViews(await peerWith([]));
    expect(Object.keys(views).filter((name) => /quirk/i.test(name))).toEqual([]);
  });
});
