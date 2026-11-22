#!/usr/bin/env node
// Builds dist/paseo-multi-account-<version>.tgz and its .sha256 (sha256sum format).
//
// The tarball holds one top-level folder, paseo-multi-account/, with the plugin source and its
// production node_modules, so `paseo plugin install <extracted dir>` works offline: Paseo
// compiles the TypeScript itself and runs no build step for a directory install. Every
// production dependency is plain JavaScript; the build fails if a native addon shows up, which
// keeps the tarball platform independent.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "paseo-multi-account";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const dist = join(root, "dist");
const stage = join(dist, ".stage");
const top = join(stage, NAME);
const tarball = join(dist, `${NAME}-${pkg.version}.tgz`);

// What `npm pack` would ship (package.json "files"), plus what an offline install needs.
const entries = [
  ...pkg.files,
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "README.md",
  "LICENSE",
  "NOTICE",
];

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

async function nativeFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && (entry.name.endsWith(".node") || entry.name === "binding.gyp")) {
      found.push(join(entry.parentPath, entry.name));
    }
  }
  return found;
}

await rm(stage, { recursive: true, force: true });
await mkdir(top, { recursive: true });
for (const entry of entries) {
  await cp(join(root, entry.replace(/\/$/, "")), join(top, entry.replace(/\/$/, "")), {
    recursive: true,
  });
}

// Exactly the locked production tree; no install scripts run.
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: top });

const native = await nativeFiles(join(top, "node_modules"));
if (native.length) {
  throw new Error(`Native files would make the tarball platform specific:\n${native.join("\n")}`);
}

await rm(tarball, { force: true });
const gnu = execFileSync("tar", ["--version"], { encoding: "utf8" }).includes("GNU tar");
const ownership = gnu
  ? ["--owner=0", "--group=0", "--numeric-owner", "--sort=name"]
  : ["--uid", "0", "--gid", "0"];
// COPYFILE_DISABLE keeps macOS tar from adding AppleDouble (._*) files.
run("tar", [...ownership, "-czf", tarball, "-C", stage, NAME], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
await rm(stage, { recursive: true, force: true });

const digest = createHash("sha256")
  .update(await readFile(tarball))
  .digest("hex");
await writeFile(`${tarball}.sha256`, `${digest}  ${basename(tarball)}\n`);
process.stdout.write(`${tarball}\n${digest}  ${basename(tarball)}\n`);
