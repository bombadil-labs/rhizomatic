import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/delta/json-profile.js";
import type { Delta } from "../src/delta/types.js";
import {
  admitSinglePeerTransfer,
  emptyDurablePeerState,
  encodeDurablePeerState,
  openSinglePeer,
  type DurablePeerStore,
  type PeerImageRead,
  type PeerImageWrite,
} from "../src/index.js";
import { FileDurablePeerStore } from "../src/federation/file-single-peer.js";

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/peer/single-peer-api.json", import.meta.url)),
    "utf8",
  ),
) as {
  peerId: string;
  selfSenderError: string;
  noOpWrites: number;
  emptyHex: string;
  firstName: string;
  secondName: string;
  local: { at: number; expectedHex: string; outcomes: Array<{ id: string; status: string }> };
  individual: {
    at: number;
    reason: string;
    expectedHex: string;
    outcomes: Array<{ id: string; status: string; reason?: string }>;
  };
};
const evidence = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/principal/evidence.json", import.meta.url)),
    "utf8",
  ),
) as { deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }> };
const named = new Map<string, Delta>(
  evidence.deltas.map((row) => [
    row.name,
    {
      id: row.id,
      claims: parseClaims(row.claims),
      ...(row.sig === undefined ? {} : { sig: row.sig }),
    },
  ]),
);
const first = named.get(vector.firstName)!;
const second = named.get(vector.secondName)!;

class MemoryStore implements DurablePeerStore {
  image: Uint8Array | null = null;
  readonly rows = new Map<string, Delta>();
  nextWrite: "durable" | "conflict" | "committed-unconfirmed" = "durable";
  writes = 0;

  readImage(peerId: string): Promise<PeerImageRead> {
    expect(peerId).toBe(vector.peerId);
    if (this.image !== null)
      return Promise.resolve({ status: "image", image: Uint8Array.from(this.image) });
    return Promise.resolve(
      this.rows.size === 0 ? { status: "empty" } : { status: "rows-without-image" },
    );
  }

  compareAndSet(
    peerId: string,
    expectedPrior: Uint8Array | null,
    nextImage: Uint8Array,
    newlyAdmitted: readonly Delta[],
  ): Promise<PeerImageWrite> {
    expect(peerId).toBe(vector.peerId);
    this.writes++;
    const matches =
      this.image === null
        ? expectedPrior === null
        : expectedPrior !== null && Buffer.from(this.image).equals(Buffer.from(expectedPrior));
    if (!matches || (expectedPrior === null && this.rows.size > 0) || this.nextWrite === "conflict")
      return Promise.resolve({ status: "conflict" });
    this.image = Uint8Array.from(nextImage);
    for (const delta of newlyAdmitted) this.rows.set(delta.id, delta);
    if (this.nextWrite === "committed-unconfirmed")
      return Promise.resolve({ status: "committed-unconfirmed", fault: "sync uncertain" });
    return Promise.resolve({ status: "durable" });
  }
}

const ordinary = () => false;
const allow = () => true;
const reasonGuard = ({ candidate }: { candidate: Delta }) =>
  candidate.id === second.id
    ? { ok: false as const, reason: vector.individual.reason }
    : { ok: true as const };

describe("shared SPEC-6 typed single-peer API", () => {
  it("constructs and reopens the canonical empty image", async () => {
    expect(
      Buffer.from(encodeDurablePeerState(emptyDurablePeerState(vector.peerId))).toString("hex"),
    ).toBe(vector.emptyHex);
    expect(() => emptyDurablePeerState("peer-A")).toThrow("canonical peer id");
    const store = new MemoryStore();
    expect((await openSinglePeer(store, vector.peerId)).status).toBe("open");
    const legacy = new MemoryStore();
    legacy.rows.set(first.id, first);
    expect((await openSinglePeer(legacy, vector.peerId)).status).toBe("rows-without-image");
    expect(Buffer.from(store.image!).toString("hex")).toBe(vector.emptyHex);
    expect((await openSinglePeer(store, vector.peerId)).status).toBe("open");
  });

  it("commits local atomic append with the image and admitted row together", async () => {
    const store = new MemoryStore();
    await openSinglePeer(store, vector.peerId);
    const result = await admitSinglePeerTransfer(store, vector.peerId, {
      offered: [first],
      origin: { kind: "local" },
      arrivedAt: vector.local.at,
      policyState: {},
      guards: [allow],
      isErasureCandidate: ordinary,
      mode: "atomic",
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("expected commit");
    expect(result.outcomes).toEqual(vector.local.outcomes);
    expect(Buffer.from(result.image).toString("hex")).toBe(vector.local.expectedHex);
    expect(store.rows.has(first.id)).toBe(true);
    expect(result.state.base.arrivals).toMatchObject([{ sender: "local", at: vector.local.at }]);
  });

  it("skips storage writes for unchanged offers and rejects a self-sender", async () => {
    const store = new MemoryStore();
    await openSinglePeer(store, vector.peerId);
    const writes = store.writes;
    const base = {
      origin: { kind: "local" as const },
      arrivedAt: vector.local.at,
      policyState: {},
      guards: [],
      isErasureCandidate: ordinary,
      mode: "atomic" as const,
    };
    expect(
      (await admitSinglePeerTransfer(store, vector.peerId, { ...base, offered: [] })).status,
    ).toBe("committed");
    expect(store.writes - writes).toBe(vector.noOpWrites);
    await expect(
      admitSinglePeerTransfer(store, vector.peerId, {
        ...base,
        offered: [first],
        origin: { kind: "authenticated-peer", peerId: vector.peerId },
      }),
    ).rejects.toThrow(vector.selfSenderError);
    expect(store.writes - writes).toBe(vector.noOpWrites);
    expect(
      (await admitSinglePeerTransfer(store, vector.peerId, { ...base, offered: [first] })).status,
    ).toBe("committed");
    const after = store.writes;
    expect(
      (await admitSinglePeerTransfer(store, vector.peerId, { ...base, offered: [first] })).status,
    ).toBe("committed");
    expect(store.writes - after).toBe(vector.noOpWrites);
  });

  it("strips caller-only row fields and verifies a changed image before planning", async () => {
    const store = new MemoryStore();
    await openSinglePeer(store, vector.peerId);
    const offered = {
      ...first,
      extra: "junk",
      claims: {
        ...first.claims,
        junk: 1,
        pointers: [
          {
            ...first.claims.pointers[0]!,
            pjunk: 2,
            target: { ...first.claims.pointers[0]!.target, tjunk: 3 },
          },
          ...first.claims.pointers.slice(1),
        ],
      },
    };
    const result = await admitSinglePeerTransfer(store, vector.peerId, {
      offered: [offered],
      origin: { kind: "local" },
      arrivedAt: vector.local.at,
      policyState: {},
      guards: [],
      isErasureCandidate: ordinary,
      mode: "atomic",
    });
    expect(result.status).toBe("committed");
    expect(Object.keys(store.rows.get(first.id)!)).toEqual(["id", "claims", "sig"]);
    expect(store.rows.get(first.id)).toEqual(first);
    if (result.status !== "committed") throw new Error("expected commit");
    const exposed = result.state.base.admitted.get(first.id)! as unknown as {
      claims: { timestamp: number };
    };
    exposed.claims.timestamp = -999;
    const reopened = await openSinglePeer(store, vector.peerId);
    if (reopened.status !== "open") throw new Error("expected open");
    expect(reopened.state.base.admitted.get(first.id)!.claims.timestamp).toBe(
      first.claims.timestamp,
    );
    store.image = Uint8Array.of(0);
    await expect(
      admitSinglePeerTransfer(store, vector.peerId, {
        offered: [second],
        origin: { kind: "local" },
        arrivedAt: vector.individual.at,
        policyState: {},
        guards: [],
        isErasureCandidate: ordinary,
        mode: "atomic",
      }),
    ).rejects.toThrow();
  });

  it("rejects a guard explanation with a non-text runtime value", async () => {
    const store = new MemoryStore();
    await openSinglePeer(store, vector.peerId);
    await expect(
      admitSinglePeerTransfer(store, vector.peerId, {
        offered: [first],
        origin: { kind: "local" },
        arrivedAt: vector.local.at,
        policyState: {},
        guards: [() => ({ ok: false, reason: 7 }) as never],
        isErasureCandidate: ordinary,
        mode: "atomic",
      }),
    ).rejects.toThrow("candidate guard: refusal reason must be text");
  });

  it("refuses the entire atomic unit with the first guard reason, and individually admits the survivor", async () => {
    const store = new MemoryStore();
    await openSinglePeer(store, vector.peerId);
    const input = {
      offered: [first, second],
      origin: { kind: "unattributed" as const },
      arrivedAt: vector.individual.at,
      policyState: {},
      guards: [reasonGuard],
      isErasureCandidate: ordinary,
    };
    const refused = await admitSinglePeerTransfer(store, vector.peerId, {
      ...input,
      mode: "atomic",
    });
    expect(refused).toMatchObject({ status: "rejected", reason: vector.individual.reason });
    expect(Buffer.from(store.image!).toString("hex")).toBe(vector.emptyHex);
    expect(store.rows.size).toBe(0);
    const accepted = await admitSinglePeerTransfer(store, vector.peerId, {
      ...input,
      mode: "individual",
    });
    expect(accepted.status).toBe("committed");
    if (accepted.status !== "committed") throw new Error("expected commit");
    expect(accepted.outcomes).toEqual(vector.individual.outcomes);
    expect(Buffer.from(accepted.image).toString("hex")).toBe(vector.individual.expectedHex);
    expect([...store.rows.keys()]).toEqual([first.id]);
    expect(accepted.state.base.arrivals).toMatchObject([
      { sender: "unattributed", at: vector.individual.at },
    ]);
  });

  it("does not claim a conflict or uncertain write committed", async () => {
    const store = new MemoryStore();
    await openSinglePeer(store, vector.peerId);
    const input = {
      offered: [first],
      origin: { kind: "local" as const },
      arrivedAt: 100,
      policyState: {},
      guards: [allow],
      isErasureCandidate: ordinary,
      mode: "atomic" as const,
    };
    store.nextWrite = "conflict";
    expect((await admitSinglePeerTransfer(store, vector.peerId, input)).status).toBe("conflict");
    expect(Buffer.from(store.image!).toString("hex")).toBe(vector.emptyHex);
    expect(store.rows.size).toBe(0);
    store.nextWrite = "committed-unconfirmed";
    expect((await admitSinglePeerTransfer(store, vector.peerId, input)).status).toBe(
      "committed-unconfirmed",
    );
  });

  it("reopens the single-writer file image", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rhizomatic-single-peer-"));
    const path = join(dir, "peer.bin");
    try {
      const store = new FileDurablePeerStore(path, vector.peerId);
      expect((await openSinglePeer(store, vector.peerId)).status).toBe("open");
      const result = await admitSinglePeerTransfer(store, vector.peerId, {
        offered: [first],
        origin: { kind: "local" },
        arrivedAt: vector.local.at,
        policyState: {},
        guards: [],
        isErasureCandidate: ordinary,
        mode: "atomic",
      });
      expect(result.status).toBe("committed");
      expect(readFileSync(path).toString("hex")).toBe(vector.local.expectedHex);
      expect(
        (await openSinglePeer(new FileDurablePeerStore(path, vector.peerId), vector.peerId)).status,
      ).toBe("open");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
