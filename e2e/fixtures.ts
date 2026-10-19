import { test as base, chromium, expect, type BrowserContext, type Worker } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const extPath = join(import.meta.dirname, "..", "dist-test");
// Use the preinstalled Chromium when present (CI images), else Playwright's default.
const preinstalled = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

export const PAGE = "http://localhost:8790/index.html";
export const ORIGIN = "http://localhost:8790";
export const OTHER = "http://127.0.0.1:8790/index.html";

export const test = base.extend<{ context: BrowserContext; sw: Worker }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      executablePath: existsSync(preinstalled) ? preinstalled : undefined,
      args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent("serviceworker");
    // The worker may be reported before its module has finished evaluating.
    await expect.poll(() => sw.evaluate(() => typeof (globalThis as any).__test), { timeout: 10_000 }).toBe("object");
    // Use the echo engine so no weights are downloaded.
    await sw.evaluate(() => chrome.storage.local.set({ settings: { local: { modelId: "echo-test", enginePin: {} } } }));
    await use(sw);
  },
});

export async function enable(sw: Worker, consent?: "always" | "deny", patch: object = {}) {
  await sw.evaluate(
    ([origin, consent, patch]) => (globalThis as any).__test.enableSite(origin, consent, patch),
    [ORIGIN, consent, patch] as const,
  );
}

export { expect };
