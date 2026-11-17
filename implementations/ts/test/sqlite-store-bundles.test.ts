// The SQLite subpath in a host's bundle. A host can bundle `src/storage/sqlite-store.ts` as a
// CommonJS or an ES module file, with `better-sqlite3` left external, as a native addon needs.
// Each bundle loads in a new Node process: with the driver it opens a store; without it the error
// names the package to install; and a driver that fails for another reason passes its own error
// up, without that message. Every bundle and store lives in a `mkdtempSync` directory.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const INSTALL = "@bombadil/rhizomatic/store/sqlite needs the package better-sqlite3";

/** The subpath bundled in `format` into a new directory; the bundle's path. */
async function bundle(format: "cjs" | "esm"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rhizomatic-sqlite-bundle-"));
  dirs.push(dir);
  const file = join(dir, format === "cjs" ? "store.cjs" : "store.mjs");
  await build({
    entryPoints: [resolve(pkg, "src/storage/sqlite-store.ts")],
    bundle: true,
    platform: "node",
    format,
    external: ["better-sqlite3"],
    outfile: file,
    logLevel: "silent",
  });
  return file;
}

/**
 * Loads the bundle in a new process, opens a store in its directory and closes it. `NODE_PATH`
 * names where `require` finds the driver; without it the bundle's directory has none.
 */
function run(
  file: string,
  driver: "installed" | "absent",
): { status: number | null; output: string } {
  const store = join(dirname(file), "store.db");
  const load = file.endsWith(".cjs")
    ? `require(${JSON.stringify(file)})`
    : `await import(${JSON.stringify(pathToFileURL(file).href)})`;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
try {
  const { openSqliteStore } = ${load};
  const opened = await openSqliteStore(${JSON.stringify(store)});
  await opened.close();
  console.log("opened");
} catch (error) {
  console.log(error.message);
  console.log("cause:", error.cause?.code);
  process.exit(1);
}`,
    ],
    {
      cwd: dirname(file),
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, NODE_PATH: driver === "installed" ? join(pkg, "node_modules") : "" },
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("the SQLite subpath bundled by a host, with better-sqlite3 external", () => {
  for (const format of ["cjs", "esm"] as const) {
    it(`a ${format} bundle loads and opens a store with the driver`, async () => {
      const file = await bundle(format);
      const result = run(file, "installed");
      expect(result.output).toContain("opened");
      expect(result.status).toBe(0);
    }, 120_000);

    it(`a ${format} bundle without the driver refuses with the message that names better-sqlite3 and npm install, with Node's MODULE_NOT_FOUND as its cause`, async () => {
      const file = await bundle(format);
      const result = run(file, "absent");
      expect(result.output).toContain(INSTALL);
      expect(result.output).toContain("npm install better-sqlite3");
      expect(result.output).toContain("cause: MODULE_NOT_FOUND");
      expect(result.status).toBe(1);
    }, 120_000);
  }

  it("a driver that fails with another error passes that error up, without the message to install it", async () => {
    const file = await bundle("cjs");
    const driver = join(dirname(file), "node_modules", "better-sqlite3");
    mkdirSync(driver, { recursive: true });
    writeFileSync(join(driver, "package.json"), '{"name":"better-sqlite3","main":"index.js"}');
    writeFileSync(
      join(driver, "index.js"),
      'throw Object.assign(new Error("the driver failed to start"), { code: "ERR_DLOPEN_FAILED" });',
    );
    const result = run(file, "absent");
    expect(result.output).toContain("the driver failed to start");
    expect(result.output).not.toContain(INSTALL);
    expect(result.status).toBe(1);
  }, 120_000);
});
