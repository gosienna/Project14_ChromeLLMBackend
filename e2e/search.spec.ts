import { PAGE, enable, expect, test } from "./fixtures";

// localLLM.search() with the Google runner stubbed (setSearchStub), so nothing leaves the machine.

const RESULTS = [
  { title: "Paris weather", url: "https://weather.example/paris", snippet: "Sunny, 21°C", score: null },
  { title: "Paris forecast", url: "https://forecast.example/paris", snippet: "Clear all week", score: null },
];

test("search needs the site's web search switch", async ({ context, sw }) => {
  await sw.evaluate((r) => (globalThis as any).__test.setSearchStub(r), RESULTS);
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(PAGE);
  const err = await page.evaluate(() => (window as any).localLLM.search("paris weather").then(() => null, (e: Error) => ({ name: e.name, message: e.message })));
  expect(err).toEqual({ name: "NotAllowedError", message: expect.stringMatching(/Web search is not enabled/) });
});

test("search returns results, and webSearchTool runs inside the model's tool loop", async ({ context, sw }) => {
  await sw.evaluate((r) => (globalThis as any).__test.setSearchStub(r), RESULTS);
  await enable(sw, "always", { webSearch: true });
  const page = await context.newPage();
  await page.goto(PAGE);
  const r = await page.evaluate(async () => {
    const llm = (window as any).localLLM;
    const direct = await llm.search("paris weather", { maxResults: 1 });
    const s = await (window as any).LanguageModel.create({ tools: [llm.webSearchTool()] });
    const answer = await s.prompt('/tool web_search {"query":"paris weather"}');
    return { direct, answer, caps: llm.capabilities };
  });
  expect(r.caps).toEqual({ search: true });
  expect(r.direct).toEqual({ query: "paris weather", provider: "google", results: [RESULTS[0]], note: "No Tavily API key; results from Google" });
  expect(r.answer).toContain("Tool web_search said: ");
  expect(JSON.parse(r.answer.replace("Tool web_search said: ", "")).results).toEqual(RESULTS);
});
