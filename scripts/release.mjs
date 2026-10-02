// Bump the version, commit and tag it. Pushing the tag makes GitHub build the installer.
//
//   npm run release patch|minor|major   (or an exact version, e.g. 1.0.0)
//   git push --follow-tags

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const sh = (cmd) => execSync(cmd, { stdio: "pipe" }).toString().trim();

const kind = process.argv[2];
if (!kind) {
  console.error("usage: npm run release <patch|minor|major|x.y.z>");
  process.exit(1);
}
if (sh("git status --porcelain")) {
  console.error("Working tree is not clean. Commit or stash your changes first.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
const next =
  kind === "major" ? `${major + 1}.0.0`
  : kind === "minor" ? `${major}.${minor + 1}.0`
  : kind === "patch" ? `${major}.${minor}.${patch + 1}`
  : /^\d+\.\d+\.\d+$/.test(kind) ? kind
  : null;
if (!next) {
  console.error(`Unknown release type "${kind}".`);
  process.exit(1);
}
if (sh(`git tag -l v${next}`)) {
  console.error(`Tag v${next} already exists.`);
  process.exit(1);
}

// package.json (tauri.conf.json reads its version from here)
pkg.version = next;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

// package-lock.json
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.version = next;
if (lock.packages?.[""]) lock.packages[""].version = next;
writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");

// Cargo.toml + Cargo.lock
const replaceIn = (file, re, to) => {
  const src = readFileSync(file, "utf8");
  if (!re.test(src)) throw new Error(`version not found in ${file}`);
  writeFileSync(file, src.replace(re, to));
};
replaceIn("src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${next}"`);
replaceIn(
  "src-tauri/Cargo.lock",
  /(name = "simple-clean-mic"\r?\nversion = )"[^"]+"/,
  `$1"${next}"`,
);

sh("git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
sh(`git commit -m "chore: release v${next}"`);
sh(`git tag -a v${next} -m "v${next}"`);

console.log(`Tagged v${next} (was ${major}.${minor}.${patch}).`);
console.log("Now run:  git push --follow-tags");
