// Bundles the extension with esbuild. All code (including engine runtimes and .wasm files)
// is bundled; output is readable, not minified, per Chrome Web Store policy.
//
//   node scripts/build.mjs           -> dist/
//   node scripts/build.mjs --test    -> dist-test/ (localhost host permissions + test hooks)
//   node scripts/build.mjs --watch

import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const test = process.argv.includes("--test");
const watch = process.argv.includes("--watch");
const out = join(root, test ? "dist-test" : "dist");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));

const define = {
  __TEST__: String(test),
  __VERSION__: JSON.stringify(manifest.version),
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  minify: false,
  sourcemap: test ? "inline" : false,
  target: "chrome116",
  logLevel: "info",
  legalComments: "none",
  define,
};

// Content scripts must be classic scripts (IIFE).
const iife = [
  { in: "src/bridge/bridge.ts", out: "bridge", define: {} },
  { in: "src/polyfill/polyfill.ts", out: "polyfill", define: { __OVERRIDE_NATIVE__: "false" } },
  { in: "src/polyfill/polyfill.ts", out: "polyfill-override", define: { __OVERRIDE_NATIVE__: "true" } },
  // Injected into pages by the playground's browser tools, and the custom-tool sandbox page.
  { in: "src/ui/tools/a11y-injected.ts", out: "ui/a11y-injected", define: {} },
  { in: "src/ui/tool-sandbox.ts", out: "ui/tool-sandbox", define: {} },
].map((e) => ({
  ...common,
  entryPoints: [e.in],
  outfile: join(out, `${e.out}.js`),
  format: "iife",
  define: { ...define, ...e.define },
}));

// Extension pages and the worker are ES modules; engines are code-split and loaded lazily.
const esm = {
  ...common,
  entryPoints: {
    background: "src/background/router.ts",
    "offscreen/host": "src/offscreen/host.ts",
    "ui/options": "src/ui/options.ts",
    "ui/popup": "src/ui/popup.ts",
    "ui/consent": "src/ui/consent.ts",
    "ui/playground": "src/ui/playground.ts",
  },
  outdir: out,
  format: "esm",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  // Node-only branches inside engine libraries.
  external: ["fs", "path", "url", "os", "crypto", "worker_threads", "module", "sharp", "onnxruntime-node"],
  loader: { ".wasm": "file" },
};

function copyStatic() {
  const m = structuredClone(manifest);
  m.version = manifest.version;
  if (test) {
    m.name += " (test)";
    m.host_permissions = ["http://localhost/*", "http://127.0.0.1/*"];
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(m, null, 2));
  cpSync(join(root, "src/icons"), join(out, "icons"), { recursive: true });
  cpSync(join(root, "src/offscreen/host.html"), join(out, "offscreen/host.html"));
  for (const page of ["options", "popup", "consent", "playground", "tool-sandbox"]) cpSync(join(root, `src/ui/${page}.html`), join(out, `ui/${page}.html`));
  cpSync(join(root, "src/ui/style.css"), join(out, "ui/style.css"));
  // KaTeX for math in playground replies: its stylesheet (unminified) and the woff2 fonts it uses first.
  const katex = join(root, "node_modules/katex/dist");
  mkdirSync(join(out, "ui/katex/fonts"), { recursive: true });
  cpSync(join(katex, "katex.css"), join(out, "ui/katex/katex.css"));
  for (const f of readdirSync(join(katex, "fonts"))) if (f.endsWith(".woff2")) cpSync(join(katex, "fonts", f), join(out, "ui/katex/fonts", f));

  // Engine runtimes: served from the extension, never from a CDN.
  const nm = join(root, "node_modules");
  mkdirSync(join(out, "vendor/ort"), { recursive: true });
  for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
    cpSync(join(nm, "onnxruntime-web/dist", f), join(out, "vendor/ort", f));
  }
  mkdirSync(join(out, "vendor/wllama"), { recursive: true });
  cpSync(join(nm, "@wllama/wllama/esm/wasm/wllama.wasm"), join(out, "vendor/wllama/wllama.wasm"));
  const libs = join(root, "vendor/webllm-libs");
  if (existsSync(libs)) cpSync(libs, join(out, "vendor/webllm-libs"), { recursive: true });
  else console.warn("! vendor/webllm-libs missing: run `npm run fetch:webllm-libs` to bundle WebLLM model libraries");
}

if (watch) {
  const ctxs = await Promise.all([...iife, esm].map((o) => esbuild.context(o)));
  copyStatic();
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log(`watching -> ${out}`);
} else {
  await Promise.all([...iife, esm].map((o) => esbuild.build(o)));
  copyStatic();
  console.log(`built ${pkg.name} ${manifest.version} -> ${out}`);
}
