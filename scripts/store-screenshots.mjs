// Capture Chrome Web Store screenshots from the built extension, plus the two promo tiles.
// Screenshots are 1280x800. Promo tiles are 1400x560 and 440x280.
//
//   node scripts/store-screenshots.mjs

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

/** Chrome's unpacked-extension id: first 32 hex chars of sha256(path), mapped 0-f → a-p. */
function extensionId(path) {
  const hex = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "store");
mkdirSync(out, { recursive: true });

const built = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);

// Branded Chrome ignores --load-extension. Playwright's Chromium still honors it.
// Set CHROME_PATH to override.
const dist = join(root, "dist");
const context = await chromium.launchPersistentContext("", {
  // headless: true uses the headless shell, which cannot load extensions.
  // Full Chromium plus --headless=new can.
  headless: false,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  args: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

try {
  const base = `chrome-extension://${extensionId(dist)}`;
  const page = context.pages()[0] ?? (await context.newPage());
  await page.setViewportSize({ width: 1280, height: 800 });
  page.on("pageerror", (err) => console.error("pageerror", err));

  // Extension pages can write chrome.storage. The service worker starts when the page messages it.
  await page.goto(`${base}/ui/options.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    await chrome.storage.local.set({
      sites: {
        "https://example.com": {
          origin: "https://example.com",
          consent: "always",
          allowedBackends: ["local"],
          backend: "local",
          dailyTokenCap: 200000,
          allowFallback: false,
          webSearch: false,
        },
      },
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#sites", { timeout: 20_000 });
  await page.screenshot({ path: join(out, "01-sites.png") });

  for (const [id, file] of [
    ["local", "02-local-model.png"],
    ["cloud", "03-cloud-providers.png"],
    ["tools", "04-tools.png"],
  ]) {
    await page.locator(`#${id}`).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, file) });
  }

  await page.goto(`${base}/ui/playground.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea[aria-label='Message']", { timeout: 20_000 });
  await page.screenshot({ path: join(out, "05-playground.png") });

  await shootPromo(page, 1400, 560, join(out, "marquee-1400x560.png"));
  await shootPromo(page, 440, 280, join(out, "promo-440x280.png"));
  console.log(`screenshots written to ${out}`);
} finally {
  await context.close();
}

async function shootPromo(page, width, height, path) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html>
    <html><head><style>
      html, body { margin: 0; height: 100%; }
      body {
        display: flex; align-items: center; justify-content: center; gap: ${Math.round(width * 0.04)}px;
        background: #3b5bdb; color: white; font: ${Math.round(height * 0.12)}px/1.2 system-ui, sans-serif;
      }
      .mark { width: ${Math.round(height * 0.42)}px; height: ${Math.round(height * 0.42)}px; background: white; border-radius: 22%;
        display: grid; align-content: center; justify-items: center; gap: ${Math.round(height * 0.035)}px; padding: ${Math.round(height * 0.08)}px 0; box-sizing: border-box; }
      .mark i { display: block; height: ${Math.round(height * 0.045)}px; background: #3b5bdb; border-radius: 99px; }
      .mark i:nth-child(1), .mark i:nth-child(2) { width: 70%; }
      .mark i:nth-child(3) { width: 42%; align-self: start; justify-self: start; margin-left: 15%; }
      h1 { margin: 0; font-size: 1em; font-weight: 650; letter-spacing: -0.02em; }
      p { margin: 0.35em 0 0; font-size: 0.42em; font-weight: 500; max-width: 16em; }
    </style></head>
    <body>
      <div class="mark"><i></i><i></i><i></i></div>
      <div><h1>Local LLM</h1><p>An on-device model for the sites you approve.</p></div>
    </body></html>`, { waitUntil: "domcontentloaded" });
  await page.screenshot({ path });
}
