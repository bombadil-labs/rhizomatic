// The SQLite subpath in a host's bundle. A host can bundle `src/storage/sqlite-store.ts` as a
// CommonJS or an ES module file, with `better-sqlite3` left external, as a native addon needs.
// Each bundle loads in a new Node process: with the driver it opens a store; without it the error
// names the package to install; and a driver that fails for another reason passes its own error
// up, without that message. A bundle evaluated with no file location refuses with a message that
// says so, and loads nothing from the working directory. Every bundle and store lives in a
// `mkdtempSync` directory.

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

const NO_LOCATION = "@bombadil/rhizomatic/store/sqlite cannot find its own module location";

/**
 * The subpath bundled in `format` into a new directory; the bundle's path. With `metaUrl`, the
 * bundler writes that string for `import.meta.url`, as some bundlers do.
 */
async function bundle(format: "cjs" | "esm" | "iife", metaUrl?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rhizomatic-sqlite-bundle-"));
  dirs.push(dir);
  const file = join(dir, { cjs: "store.cjs", esm: "store.mjs", iife: "store.js" }[format]);
  await build({
    entryPoints: [resolve(pkg, "src/storage/sqlite-store.ts")],
    bundle: true,
    platform: "node",
    format,
    ...(format === "iife" ? { globalName: "sqliteStore" } : {}),
    ...(metaUrl === undefined ? {} : { define: { "import.meta.url": JSON.stringify(metaUrl) } }),
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

/**
 * A new directory whose `node_modules/better-sqlite3` is a stub that prints `stub ran`, to be a
 * working directory that a load must not read.
 */
function planted(): string {
  const dir = mkdtempSync(join(tmpdir(), "rhizomatic-sqlite-planted-"));
  dirs.push(dir);
  const driver = join(dir, "node_modules", "better-sqlite3");
  mkdirSync(driver, { recursive: true });
  writeFileSync(join(driver, "package.json"), '{"name":"better-sqlite3","main":"index.js"}');
  writeFileSync(join(driver, "index.js"), 'console.log("stub ran"); module.exports = {};');
  return dir;
}

/** Writes a stub `better-sqlite3` into `dir/node_modules` that prints `word` when it loads. */
function stub(dir: string, word: string): void {
  const driver = join(dir, "node_modules", "better-sqlite3");
  mkdirSync(driver, { recursive: true });
  writeFileSync(join(driver, "package.json"), '{"name":"better-sqlite3","main":"index.js"}');
  writeFileSync(
    join(driver, "index.js"),
    `console.log(${JSON.stringify(word)}); module.exports = {};`,
  );
}

/** Runs `args` in a new Node process in `cwd`, with no NODE_PATH; what it printed. */
function node(args: string[], cwd: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, NODE_PATH: "" },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("the SQLite subpath bundled by a host, with better-sqlite3 external", () => {
  it("a bundle evaluated with no module location (vm.runInThisContext) refuses with the message that the location is unknown, and loads no better-sqlite3 from the working directory", async () => {
    const file = await bundle("iife");
    const result = node(
      [
        "--input-type=module",
        "-e",
        `import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
globalThis.require = createRequire(import.meta.url);
try {
  vm.runInThisContext(readFileSync(${JSON.stringify(file)}, "utf8"), { filename: ${JSON.stringify(file)} });
  console.log("loaded");
} catch (error) {
  console.log(error.message);
  process.exit(1);
}`,
      ],
      planted(),
    );
    expect(result.output).toContain(NO_LOCATION);
    expect(result.output).not.toContain("stub ran");
    expect(result.status).toBe(1);
  }, 120_000);

  it("a CommonJS bundle evaluated in node -e, where __filename is [eval], refuses with the message that the location is unknown, not ERR_INVALID_ARG_VALUE", async () => {
    const file = await bundle("cjs");
    const result = node(
      [
        "-e",
        `try {
  eval(require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8"));
  console.log("loaded");
} catch (error) {
  console.log(error.message);
  process.exit(1);
}`,
      ],
      planted(),
    );
    expect(result.output).toContain(NO_LOCATION);
    expect(result.output).not.toContain("ERR_INVALID_ARG_VALUE");
    expect(result.output).not.toContain("stub ran");
    expect(result.status).toBe(1);
  }, 120_000);

  for (const scheme of ["file:", "FILE:"])
    it(`a CommonJS bundle whose import.meta.url (${scheme}) names another directory loads the driver from there, not from beside the bundle: import.meta.url comes before __filename, and the scheme is read without case`, async () => {
      const other = mkdtempSync(join(tmpdir(), "rhizomatic-sqlite-meta-"));
      dirs.push(other);
      stub(other, "meta driver ran");
      const href = pathToFileURL(join(other, "store.cjs")).href.replace(/^file:/, scheme);
      const file = await bundle("cjs", href);
      stub(dirname(file), "bundle driver ran");
      const result = node(
        ["-e", `require(${JSON.stringify(file)}); console.log("loaded");`],
        planted(),
      );
      expect(result.output).toContain("meta driver ran");
      expect(result.output).not.toContain("bundle driver ran");
      expect(result.output).not.toContain("stub ran");
      expect(result.status).toBe(0);
    }, 120_000);

  it("an ES module bundle whose import.meta.url is not a file: URL refuses with the message that the location is unknown, not ERR_INVALID_ARG_VALUE", async () => {
    const file = await bundle("esm", "https://example.invalid/store.mjs");
    const result = node(
      [
        "--input-type=module",
        "-e",
        `try {
  await import(${JSON.stringify(pathToFileURL(file).href)});
  console.log("loaded");
} catch (error) {
  console.log(error.message);
  process.exit(1);
}`,
      ],
      planted(),
    );
    expect(result.output).toContain(NO_LOCATION);
    expect(result.output).not.toContain("ERR_INVALID_ARG_VALUE");
    expect(result.output).not.toContain("stub ran");
    expect(result.status).toBe(1);
  }, 120_000);

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
