// The product-level Store + StoreRegistry (spec/12 §1–2): a named, keyed instance that wraps a
// persistence backend. Identity is a derived child of the master seed, so it is deterministic and
// auditable and forgery-proof; the registry owns the on-disk layout under a root directory.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { authorForSeed } from "@bombadil/rhizomatic";
import { Store, StoreRegistry, storeSeed, type StoreManifest } from "../src/stores.js";
import { JsonlStore } from "../src/shared-store.js";
import { callTool, createSession } from "../src/mcp-server.js";

const MASTER = "0f".repeat(32);
const OTHER_MASTER = "a1".repeat(32);
const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const dir = mkdtempSync(join(tmpdir(), "chorus-stores-"));
const opened: Store[] = [];
const track = (s: Store): Store => (opened.push(s), s);
const registry = (root: string, master = MASTER) =>
  new StoreRegistry(root, master, clockFrom(1000));

afterAll(() => {
  for (const s of opened) s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("chorus stores: identity + registry", () => {
  it("derives a deterministic, distinct identity per name and writes a manifest", () => {
    const root = join(dir, "r1");
    const reg = registry(root);
    const personal = track(reg.open("personal"));
    const media = track(reg.open("media"));

    // StoreId is exactly the author derived from store/<name> off the master seed.
    expect(personal.id).toBe(authorForSeed(storeSeed(MASTER, "personal")));
    expect(media.id).toBe(authorForSeed(storeSeed(MASTER, "media")));
    expect(personal.id).not.toBe(media.id);
    expect(personal.id.startsWith("ed25519:")).toBe(true);

    // The manifest is on disk, matching the identity, with the documented defaults.
    const manifest = JSON.parse(
      readFileSync(join(root, "personal", "store.json"), "utf8"),
    ) as StoreManifest;
    expect(manifest).toMatchObject({
      name: "personal",
      id: personal.id,
      tier: "federated",
      backend: "jsonl",
    });
  });

  it("tier is federated by default and can be declared private", () => {
    const reg = registry(join(dir, "r2"));
    expect(reg.open("shared").tier).toBe("federated");
    const vault = track(reg.open("vault", { tier: "private" }));
    expect(vault.tier).toBe("private");
  });

  it("re-opening reads the manifest and never re-mints; a wrong master seed fails loudly", () => {
    const root = join(dir, "r3");
    const first = track(registry(root).open("personal", { tier: "private" }));

    // A fresh registry over the same root re-derives the identical id and preserves the tier.
    const reopened = track(registry(root).open("personal"));
    expect(reopened.id).toBe(first.id);
    expect(reopened.tier).toBe("private"); // not overwritten back to the default

    // The SAME directory opened under a DIFFERENT master seed must refuse, not silently mis-sign.
    expect(() => registry(root, OTHER_MASTER).open("personal")).toThrow(
      /does not match|master seed|tampered/i,
    );
  });

  it("list() surfaces every store under the root, sorted by name", () => {
    const root = join(dir, "r4");
    const reg = registry(root);
    track(reg.open("media"));
    track(reg.open("personal"));
    track(reg.open("aggregator"));
    expect(reg.list().map((m) => m.name)).toEqual(["aggregator", "media", "personal"]);
    expect(registry(join(dir, "absent")).list()).toEqual([]); // no root yet → empty, not a throw
  });

  it("the wrapped backend persists a world that a fresh registry resumes", () => {
    const root = join(dir, "r5");
    const store = track(registry(root).open("personal"));

    const s1 = createSession({ masterSeedHex: MASTER, sessionId: "p1", clock: clockFrom(1000) });
    callTool(s1, "begin-session", { model: "claude-fable-5" });
    callTool(s1, "remember", { about: "user:myk", attribute: "editor", value: "emacs" }, () =>
      store.backend.persist(s1.agent),
    );
    const before = s1.agent.digest();

    // A second process opens the same store through a new registry and recovers the world.
    const store2 = track(registry(root).open("personal"));
    const s2 = createSession({ masterSeedHex: MASTER, sessionId: "p2", clock: clockFrom(9000) });
    store2.backend.refresh(s2.agent);
    expect(s2.agent.digest()).toBe(before);
    expect(callTool(s2, "recall", { entity: "user:myk" })).toEqual({ editor: "emacs" });
  });

  it("adopts an existing store losslessly (digest-identical), idempotently, non-destructively", () => {
    // Build a pre-registry world in a standalone JSONL file, the way the live store exists today.
    const legacyPath = join(dir, "legacy-memory.jsonl");
    const legacy = new JsonlStore(legacyPath);
    const w = createSession({ masterSeedHex: MASTER, sessionId: "w", clock: clockFrom(1000) });
    callTool(w, "begin-session", { model: "claude-fable-5" });
    callTool(w, "remember", { about: "work:dune-part-two", attribute: "year", value: "2024" });
    callTool(w, "remember", {
      about: "tracker:synchronicity",
      attribute: "entries",
      value: "many",
    });
    legacy.persist(w.agent);
    const legacyDigest = w.agent.digest();

    // Adopt it as the store named "personal" in a fresh registry root.
    const root = join(dir, "adopt");
    const result = registry(root).adopt("personal", legacy, { tier: "private" });
    track(result.store);
    expect(result.deltas).toBeGreaterThan(0);
    expect(result.digest).toBe(legacyDigest); // lossless: byte-identical canonical digest
    expect(result.store.tier).toBe("private");

    // The adopted store recalls the world through a fresh registry handle…
    const reader = createSession({ masterSeedHex: MASTER, sessionId: "r", clock: clockFrom(9000) });
    const reopened = track(registry(root).open("personal"));
    reopened.backend.refresh(reader.agent);
    expect(reader.agent.digest()).toBe(legacyDigest);
    expect(callTool(reader, "recall", { entity: "work:dune-part-two" })).toEqual({ year: "2024" });

    // …the source file is untouched (adoption only reads it)…
    expect(new JsonlStore(legacyPath).deltasSince(new Set()).length).toBe(result.deltas);

    // …and re-adopting is a no-op union (idempotent by delta id): nothing new, same digest.
    const again = registry(root).adopt("personal", legacy);
    track(again.store);
    expect(again.deltas).toBe(0);
    expect(again.digest).toBe(legacyDigest);
  });

  it("a manifest is written once and reused (createdAt is stable across opens)", () => {
    const root = join(dir, "r6");
    track(registry(root).open("personal"));
    const path = join(root, "personal", "store.json");
    expect(existsSync(path)).toBe(true);
    const createdAt = (JSON.parse(readFileSync(path, "utf8")) as StoreManifest).createdAt;
    track(registry(root).open("personal")); // re-open must not rewrite the manifest
    expect((JSON.parse(readFileSync(path, "utf8")) as StoreManifest).createdAt).toBe(createdAt);
  });
});
