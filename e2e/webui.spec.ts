import { PAGE, enable, expect, test } from "./fixtures";

test("web chat backend round trip through a stubbed runner", async ({ context, sw }) => {
  await sw.evaluate(async () => {
    const { settings } = (await chrome.storage.local.get("settings")) as { settings: Record<string, unknown> };
    const providers = {
      ...((settings.providers as Record<string, unknown>) ?? {}),
      "chatgpt-web": { enabled: true, model: "default", monthlyTokenCap: 2_000_000 },
    };
    await chrome.storage.local.set({ settings: { ...settings, providers } });
  });
  await sw.evaluate(() => (globalThis as any).__test.setWebUiStub((prompt: string) => `WebEcho: ${prompt}`));
  await enable(sw, "always", { allowedBackends: ["local", "chatgpt-web"], backend: "chatgpt-web" });

  const page = await context.newPage();
  await page.goto(PAGE);

  const result = await page.evaluate(async () => {
    const models = await (window as any).localLLM.models();
    const s = await (window as any).LanguageModel.create({ model: "chatgpt-web:default" });
    const reply = await s.prompt("hello web");
    const info = await (window as any).localLLM.info();
    return { models: models.map((m: { id: string }) => m.id), reply, info };
  });

  expect(result.models).toContain("chatgpt-web:default");
  expect(result.reply).toContain("WebEcho:");
  expect(result.reply).toContain("hello web");
  expect(result.info.backend).toMatch(/ChatGPT/i);

  const usage = await sw.evaluate(() => (globalThis as any).__test.getUsage());
  expect(usage.at(-1).backend).toBe("chatgpt-web");
  expect(JSON.stringify(usage)).not.toContain("hello web");
});
