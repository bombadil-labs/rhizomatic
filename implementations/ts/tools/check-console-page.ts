// Sanity: the console's served inline script must parse as JavaScript. (The TS source holds
// it as a template literal with escape sequences; only the SERVED bytes are the real program.)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startConsole } from "../chorus/console.js";

const dir = mkdtempSync(join(tmpdir(), "console-parse-"));
const h = await startConsole({
  storePath: join(dir, "s.jsonl"),
  masterSeedHex: "0f".repeat(32),
  port: 0,
});
const page = await (await fetch(h.url)).text();
const m = page.match(/<script>([\s\S]*?)<\/script>/);
if (m === null) throw new Error("no inline script in the served page");
new Function(m[1]!); // parse-only; throws on syntax errors
console.log(`served inline script parses OK (${m[1]!.length} chars)`);
h.close();
rmSync(dir, { recursive: true, force: true });
