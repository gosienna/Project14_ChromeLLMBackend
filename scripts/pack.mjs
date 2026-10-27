// Build a Chrome Web Store zip. The archive root is the extension (manifest.json at the top),
// not a dist/ folder. Run `npm run fetch:webllm-libs` first so model libraries are inside the package.
//
//   node scripts/pack.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));

const permissions = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
if (permissions.includes("debugger")) {
  console.error("refusing to pack: the debugger permission cannot ship (Chrome drops it when optional, and it is outside the extension's purpose)");
  process.exit(1);
}
if ((manifest.host_permissions ?? []).length) {
  console.error("refusing to pack: required host_permissions must stay empty");
  process.exit(1);
}

const libs = join(root, "vendor/webllm-libs");
const wasm = existsSync(libs) ? readdirSync(libs).filter((f) => f.endsWith(".wasm")) : [];
if (!wasm.length) {
  console.error("vendor/webllm-libs has no .wasm files. Run `npm run fetch:webllm-libs` before packing, so the store package contains no remote code.");
  process.exit(1);
}

const built = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);

const dist = join(root, "dist");
if (!existsSync(join(dist, "ui/privacy.html"))) {
  console.error("dist/ui/privacy.html is missing");
  process.exit(1);
}

const outDir = join(root, "release");
mkdirSync(outDir, { recursive: true });
const zip = join(outDir, `local-llm-${manifest.version}.zip`);
rmSync(zip, { force: true });
// -X strips extra file attributes so the archive is just the extension files.
const packed = spawnSync("zip", ["-r", "-X", zip, "."], { cwd: dist, stdio: "inherit" });
if (packed.status !== 0) process.exit(packed.status ?? 1);

const mb = statSync(zip).size / 2 ** 20;
console.log(`packed ${zip} (${mb.toFixed(1)} MB)`);
if (mb > 2048) {
  console.error("zip is over the Chrome Web Store 2 GB limit");
  process.exit(1);
}
