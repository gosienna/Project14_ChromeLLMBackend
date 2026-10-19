import { ORIGIN, PAGE, enable, expect, test } from "./fixtures";

test("iframes do not get the API (top frame only)", async ({ context, sw }) => {
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/frame.html`);
  const frame = page.frameLocator("#f");
  await frame.locator("h1").waitFor();
  const inFrame = await page.frames()[1].evaluate(() => "LanguageModel" in window);
  expect(inFrame).toBe(false);
  expect(await page.evaluate(() => "LanguageModel" in window)).toBe(true);
});

test("a second handshake from page script is ignored and spoofed fields are dropped", async ({ context, sw }) => {
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(PAGE);
  const r = await page.evaluate(async () => {
    // Hostile script tries to hijack the relay with its own channel and a forged origin.
    const ch = new MessageChannel();
    const got: unknown[] = [];
    ch.port1.onmessage = (e) => got.push(e.data);
    window.postMessage({ __localLLM: "hello", nonce: "a".repeat(32) }, location.origin, [ch.port2]);
    ch.port1.postMessage({ nonce: "a".repeat(32), msg: { kind: "availability", id: "x1", origin: "https://bank.example" } });
    await new Promise((res) => setTimeout(res, 300));
    // The legitimate stub still works.
    const s = await (window as any).LanguageModel.create();
    return { got, text: await s.prompt("still fine") };
  });
  expect(r.got).toEqual([]);
  expect(r.text).toBe("Echo #1: still fine");
});
