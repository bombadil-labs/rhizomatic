// Importing the SQLite subpath registers the `sqlite:` scheme, and the import never fails on it
// (SPEC-18 §9). A scheme a host registered first stays the host's, and a second evaluation of the
// module leaves the first registration as it is. `openSqliteStore` is reachable either way.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openStore, registerStoreScheme } from "../src/storage/open-store.js";
import { StoreError } from "../src/storage/store.js";

// No static import of the subpath here, also not through a fixture: the first test must register
// its own factory before the module ever loads.
const dir = mkdtempSync(join(tmpdir(), "rhizomatic-register-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fixture = { path: () => join(dir, `store-${n++}.db`) };

type Module = typeof import("../src/storage/sqlite-store.js");
const SUBPATH = "../src/storage/sqlite-store.js";
/** A new evaluation of the subpath module: each query names another module. */
const evaluate = (query: string): Promise<Module> =>
  import(/* @vite-ignore */ `${SUBPATH}?${query}`) as Promise<Module>;

const url = (path: string): string => `sqlite://${path}`;

describe("registering the sqlite scheme by import", () => {
  it("leaves a host's own sqlite factory in place, and the subpath still loads", async () => {
    const remove = registerStoreScheme("sqlite", async () => {
      throw new StoreError("open-failed", "the host's own factory");
    });
    const first = await evaluate("host-first");
    const second = await evaluate("host-first-again");
    const error = (await openStore(url(fixture.path())).catch((e: unknown) => e)) as StoreError;
    expect(error.message).toBe("the host's own factory");
    for (const module of [first, second]) {
      const store = await module.openSqliteStore(fixture.path());
      await store.close();
    }
    remove();
  });

  it("registers once, and a second evaluation of the module loads too", async () => {
    await evaluate("alone");
    await evaluate("alone-again");
    const store = await openStore(url(fixture.path()));
    expect(store.profile.formatVersion).toBe("rhizomatic-store-sqlite/1");
    await store.close();
  });
});
