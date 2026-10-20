import { expect, test } from "./fixtures";

// 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("playground chats with the local backend and sends images", async ({ context, sw }) => {
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/playground.html`);
  await expect(page.locator(".pg-head")).toContainText("on dummy");

  const message = page.getByLabel("Message");
  const replies = page.locator(".pg-assistant .pg-text");

  await message.fill("hello there");
  await message.press("Enter");
  await expect(replies.nth(0)).toHaveText("Echo #1: hello there");

  await page.locator('input[type="file"]').setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator(".pg-thumb img")).toHaveCount(1);
  await message.fill("what is this");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(replies.nth(1)).toHaveText("Echo #2: what is this [image/png]");
  await expect(page.locator(".pg-user img")).toHaveCount(1);
  await expect(page.locator(".pg-thumb")).toHaveCount(0);

  await message.fill("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen");
  await message.press("Enter");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".pg-assistant").nth(2)).toContainText("Stopped");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  await page.getByRole("button", { name: "New chat" }).click();
  await message.fill("fresh");
  await message.press("Enter");
  await expect(replies.nth(0)).toHaveText("Echo #1: fresh");

  const usage = await sw.evaluate(() => (globalThis as any).__test.getUsage());
  expect(usage.at(-1).origin).toBe(`chrome-extension://${extId}`);
  expect(JSON.stringify(usage)).not.toContain("what is this");
});

test("playground shows a reasoning model's thinking apart from the answer", async ({ context, sw }) => {
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/playground.html`);
  const message = page.getByLabel("Message");
  await message.fill("/think hard");
  await message.press("Enter");
  const reply = page.locator(".pg-assistant").nth(0);
  await expect(reply.locator(":scope > .pg-text")).toHaveText("Echo #1: /think hard");
  await expect(reply.locator(".pg-thinking summary")).toHaveText("Thought");
  await expect(reply.locator(".pg-thinking .pg-text")).toHaveText("Thinking about: /think hard");
});

test("only the playground page may open a playground port", async ({ context, sw }) => {
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/playground.html`);
  await expect(page.locator(".pg-head")).toContainText("on dummy");
  // A port named like the playground's but opened by any other page is dropped by the router.
  const dropped = await page.evaluate(async () => {
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("ui/popup.html");
    document.body.append(frame);
    await new Promise((r) => frame.addEventListener("load", r, { once: true }));
    const port = (frame.contentWindow as typeof window).chrome.runtime.connect({ name: "llm-playground" });
    return new Promise<boolean>((resolve) => {
      port.onDisconnect.addListener(() => resolve(true));
      port.postMessage({ backend: "local", req: { kind: "info", id: "x1" } });
      port.onMessage.addListener(() => resolve(false));
    });
  });
  expect(dropped).toBe(true);
});

test("the transcript keeps the newest reply in view, also with panels open", async ({ context, sw }) => {
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`chrome-extension://${extId}/ui/playground.html`);
  await expect(page.locator(".pg-head")).toContainText("on dummy");
  const message = page.getByLabel("Message", { exact: true });
  const atEnd = () => page.locator(".pg-log").evaluate((l) => {
    const last = [...l.querySelectorAll(".pg-assistant")].at(-1)!;
    return l.clientHeight >= 150 && last.getBoundingClientRect().bottom <= l.getBoundingClientRect().bottom + 1;
  });
  for (let i = 0; i < 6; i++) {
    await message.fill(`message ${i} ${"word ".repeat(40)}`);
    await message.press("Enter");
    await expect(page.locator(".pg-assistant > .pg-text").nth(i)).toContainText("Echo");
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  }
  await expect.poll(atEnd).toBe(true);
  await page.getByRole("button", { name: "Show raw" }).click();
  await page.locator(".pg-tools-box > summary").click();
  await expect.poll(atEnd).toBe(true);
});

test("replies render Markdown and LaTeX, with a plain-text option", async ({ context, sw }) => {
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  const failed: string[] = [];
  page.on("requestfailed", (r) => failed.push(r.url()));
  page.on("response", (r) => r.status() >= 400 && failed.push(r.url()));
  await page.goto(`chrome-extension://${extId}/ui/playground.html`);
  await expect(page.locator(".pg-head")).toContainText("on dummy");
  await page.getByLabel("Message", { exact: true }).fill("intro\n# Title\nSee [site](https://example.com) and $E = mc^2$.\n$$\\frac{a}{b}$$");
  await page.getByRole("button", { name: "Send" }).click();
  const answer = page.locator(".pg-assistant > .pg-text").last();
  await expect(answer.locator("h1")).toHaveText("Title");
  await expect(answer.locator('a[href="https://example.com"]')).toHaveAttribute("target", "_blank");
  await expect(answer.locator(".katex")).toHaveCount(2);
  await expect(answer.locator(".katex-display")).toHaveCount(1);
  // KaTeX's bundled fonts load (from the extension, never a CDN).
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check("16px KaTeX_Main"))).toBe(true);
  expect(failed).toEqual([]);

  await page.locator(".pg-head details summary", { hasText: "Session options" }).click();
  await page.getByLabel("Render Markdown and math in replies").uncheck();
  await expect(answer.locator("h1")).toHaveCount(0);
  await expect(answer).toContainText("# Title");
  await expect(answer).toContainText("$$\\frac{a}{b}$$");
});

test("sessions are released when the worker stopped before the playground closed", async ({ context, sw }) => {
  const extId = new URL(sw.url()).host;
  const origin = `chrome-extension://${extId}`;
  const count = () => sw.evaluate(async (o) => ((await (globalThis as any).__test.admin({ op: "status" })).sessions[o] ?? 0), origin);
  const page = await context.newPage();
  await page.goto(`${origin}/ui/playground.html`);
  const message = page.getByLabel("Message");
  const replies = page.locator(".pg-assistant .pg-text");
  await message.fill("hi");
  await message.press("Enter");
  await expect(replies.nth(0)).toHaveText("Echo #1: hi");
  expect(await count()).toBe(1);

  // The playground resets its chat; the stale session goes on the next connect.
  await sw.evaluate(() => (globalThis as any).__test.dropPorts());
  await message.fill("again");
  await message.press("Enter");
  await expect(replies.nth(1)).toContainText("again");
  await expect.poll(count).toBe(1);

  // Closing the tab while the router has no port for it.
  await sw.evaluate(() => (globalThis as any).__test.dropPorts());
  await page.close();
  await expect.poll(count).toBe(0);
});
