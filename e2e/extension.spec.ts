import { OTHER, PAGE, ORIGIN, enable, expect, test } from "./fixtures";

test("unapproved origins cannot see the API", async ({ context, sw }) => {
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(OTHER);
  expect(await page.evaluate(() => "LanguageModel" in window || "localLLM" in window)).toBe(false);
});

test("prompt API round trip through the relay chain", async ({ context, sw }) => {
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(PAGE);

  const result = await page.evaluate(async () => {
    const LM = (window as any).LanguageModel;
    const availability = await LM.availability();
    const params = await LM.params();
    const progress: number[] = [];
    const s = await LM.create({
      initialPrompts: [{ role: "system", content: "You are concise." }],
      monitor(m: EventTarget) { m.addEventListener("downloadprogress", (e) => progress.push((e as ProgressEvent).loaded)); },
    });
    const first = await s.prompt("hello world");
    let streamed = "";
    for await (const chunk of s.promptStreaming("again")) streamed += chunk;
    const usage = await s.measureInputUsage("abcd efgh");
    const clone = await s.clone();
    const cloned = await clone.prompt("from clone");
    const info = await (window as any).localLLM.info();
    s.destroy();
    let destroyedError = "";
    try { await s.prompt("x"); } catch (e) { destroyedError = (e as DOMException).name; }
    return { availability, params, progress, first, streamed, usage, cloned, info, destroyedError, inputUsage: clone.inputUsage, quota: clone.inputQuota };
  });

  expect(result.availability).toBe("available");
  expect(result.params.maxTemperature).toBeGreaterThan(0);
  expect(result.progress).toContain(0);
  expect(result.progress).toContain(1);
  expect(result.first).toBe("Echo #1: hello world");
  expect(result.streamed).toBe("Echo #2: again");
  expect(result.usage).toBeGreaterThan(0);
  expect(result.cloned).toBe("Echo #3: from clone");
  expect(result.info.backend).toBe("dummy");
  expect(result.destroyedError).toBe("InvalidStateError");
  expect(result.inputUsage).toBeGreaterThan(0);
  expect(result.quota).toBe(4096);

  const usage = await sw.evaluate(() => (globalThis as any).__test.getUsage());
  expect(usage.length).toBeGreaterThanOrEqual(3);
  expect(usage[0].origin).toBe(ORIGIN);
  expect(JSON.stringify(usage)).not.toContain("hello world"); // no prompt text in the log
});

test("abort signal cancels a prompt", async ({ context, sw }) => {
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(PAGE);
  const name = await page.evaluate(async () => {
    const s = await (window as any).LanguageModel.create();
    const ac = new AbortController();
    const p = s.prompt("one two three four five six seven eight nine ten", { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    try { await p; return "resolved"; } catch (e) { return (e as DOMException).name; }
  });
  expect(name).toBe("AbortError");
});

test("first create asks for consent; Always persists", async ({ context, sw }) => {
  await enable(sw);
  const page = await context.newPage();
  await page.goto(PAGE);
  expect(await page.evaluate(() => (window as any).LanguageModel.availability())).toBe("downloadable");

  const dialog = context.waitForEvent("page", (p) => p.url().includes("consent.html"));
  const created = page.evaluate(async () => {
    const s = await (window as any).LanguageModel.create();
    return s.prompt("hi");
  });
  const consent = await dialog;
  await consent.getByRole("button", { name: "Always allow" }).click();
  expect(await created).toBe("Echo #1: hi");

  const site = await sw.evaluate(async (o) => ((await chrome.storage.local.get("sites")) as any).sites[o], ORIGIN);
  expect(site.consent).toBe("always");
});

test("denied sites get NotAllowedError and report unavailable", async ({ context, sw }) => {
  await enable(sw, "deny");
  const page = await context.newPage();
  await page.goto(PAGE);
  const r = await page.evaluate(async () => {
    const availability = await (window as any).LanguageModel.availability();
    try { await (window as any).LanguageModel.create(); return { availability, error: "" }; }
    catch (e) { return { availability, error: (e as DOMException).name }; }
  });
  expect(r).toEqual({ availability: "unavailable", error: "NotAllowedError" });
});

test("per-origin concurrent session limit", async ({ context, sw }) => {
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(PAGE);
  const name = await page.evaluate(async () => {
    const LM = (window as any).LanguageModel;
    await LM.create();
    await LM.create();
    try { await LM.create(); return "created"; } catch (e) { return (e as DOMException).name; }
  });
  expect(name).toBe("QuotaExceededError");
});

test("revocation takes effect immediately", async ({ context, sw }) => {
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(PAGE);
  await page.evaluate(async () => { (window as any).s = await (window as any).LanguageModel.create(); });
  await sw.evaluate((o) => (globalThis as any).__test.revokeSite(o), ORIGIN);
  const name = await page.evaluate(async () => {
    try { await (window as any).s.prompt("x"); return "ok"; } catch (e) { return (e as DOMException).name; }
  });
  expect(["NotAllowedError", "InvalidStateError", "OperationError"]).toContain(name);
  await page.reload();
  expect(await page.evaluate(() => "LanguageModel" in window)).toBe(false);
});
