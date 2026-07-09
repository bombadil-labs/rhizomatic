// Cut a release tag: bump, commit, tag rhizomatic-vX.Y.Z, push. Publishing itself happens in CI
// (.github/workflows/release.yml) keyed off the tag — no npm login or OTP on the workstation.
// npm's own `npm version` git integration is skipped (--no-git-tag-version) because it only
// commits/tags when the package root is the git root, which a monorepo package never is.
//
// Usage: npm run release:patch|minor|major  (= tsx tools/release.ts <bump>)

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const bump = process.argv[2];
if (bump !== "patch" && bump !== "minor" && bump !== "major") {
  console.error("usage: tsx tools/release.ts patch|minor|major");
  process.exit(1);
}

const run = (cmd: string): void => {
  execSync(cmd, { stdio: "inherit" });
};
const out = (cmd: string): string => execSync(cmd).toString().trim();

if (out("git status --porcelain") !== "") {
  console.error("working tree is not clean — commit or stash first");
  process.exit(1);
}

// preversion (check) and version (build) lifecycle scripts still run here.
run(`npm version ${bump} --no-git-tag-version`);
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const tag = `rhizomatic-v${version}`;

run("git add package.json package-lock.json");
run(`git commit -m "@bombadil/rhizomatic ${version}"`);
run(`git tag -a ${tag} -m "@bombadil/rhizomatic ${version}"`);
run(`git push origin HEAD ${tag}`);
console.log(`\ncut ${tag} — CI publishes it: https://github.com/bombadil-labs/rhizomatic/actions`);
