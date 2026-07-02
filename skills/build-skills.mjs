// Package every skill directory under skills/ into skills/dist/<name>.skill (a zip with SKILL.md at
// its root). Cross-platform: PowerShell Compress-Archive on Windows, `zip` elsewhere. No deps.
//
//   node skills/build-skills.mjs            # build all
//   node skills/build-skills.mjs media-log  # build one
//
// A "skill" is any immediate subdirectory of skills/ that contains a SKILL.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const only = process.argv.slice(2);
const skills = readdirSync(root).filter((name) => {
  if (name === "dist" || name === "node_modules") return false;
  const dir = join(root, name);
  return statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md")) && (only.length === 0 || only.includes(name));
});

if (skills.length === 0) {
  console.error(only.length ? `no matching skill with a SKILL.md: ${only.join(", ")}` : "no skills found");
  process.exit(1);
}

for (const name of skills) {
  const dir = join(root, name);
  const out = join(dist, `${name}.skill`);
  if (existsSync(out)) rmSync(out);
  if (process.platform === "win32") {
    // Compress-Archive writes a .zip; -Path "<dir>\*" puts the skill's files at the archive root.
    const tmp = join(dist, `${name}.zip`);
    if (existsSync(tmp)) rmSync(tmp);
    execFileSync("powershell", [
      "-NoProfile", "-Command",
      `Compress-Archive -Path "${join(dir, "*")}" -DestinationPath "${tmp}" -Force; Move-Item "${tmp}" "${out}" -Force`,
    ], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-r", "-q", out, "."], { cwd: dir, stdio: "inherit" });
  }
  console.log(`packaged ${name} -> dist/${name}.skill`);
}

console.log(`\n${skills.length} skill(s) built into skills/dist/`);
