import { PAGE, enable, expect, test } from "./fixtures";

// localLLM.search() with the Google runner stubbed (setSearchStub), so nothing leaves the machine.

const RESULTS = [
  { title: "Paris weather", url: "https://weather.example/paris", snippet: "Sunny, 21°C", score: null },
  { title: "Paris forecast", url: "https://forecast.example/paris", snippet: "Clear all week", score: null },
];

const IMAGES = [{ url: "https://img.example/eiffel.jpg", description: "Eiffel Tower", width: 800, height: 600 }];

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
  expect(r.caps).toEqual({ search: true, imageSearch: true, fetchImage: true });
  expect(r.direct).toEqual({ query: "paris weather", provider: "google", results: [RESULTS[0]], note: "No Tavily API key; results from Google" });
  expect(r.answer).toContain("Tool web_search said: ");
  expect(JSON.parse(r.answer.replace("Tool web_search said: ", "")).results).toEqual(RESULTS);
});

test("search returns images when asked", async ({ context, sw }) => {
  await sw.evaluate(([r, i]) => (globalThis as any).__test.setSearchStub(r, i), [RESULTS, IMAGES] as const);
  await enable(sw, "always", { webSearch: true });
  const page = await context.newPage();
  await page.goto(PAGE);
  const r = await page.evaluate(async () => {
    const llm = (window as any).localLLM;
    const s = await (window as any).LanguageModel.create({ tools: [llm.webSearchTool()] });
    return {
      plain: await llm.search("eiffel tower", { maxResults: 2 }),
      withImages: await llm.search("eiffel tower", { maxResults: 2, includeImages: true }),
      answer: await s.prompt('/tool web_search {"query":"eiffel tower","include_images":true}'),
    };
  });
  expect(r.plain.images).toBeUndefined();
  expect(r.withImages.images).toEqual(IMAGES);
  expect(JSON.parse(r.answer.replace("Tool web_search said: ", "")).images).toEqual(IMAGES);
});

test("fetchImage downloads only images this site's search returned", async ({ context, sw }) => {
  const images = [{ url: "http://localhost:8790/pixel.png", description: "One pixel" }];
  await sw.evaluate(([r, i]) => (globalThis as any).__test.setSearchStub(r, i), [RESULTS, images] as const);
  await enable(sw, "always", { webSearch: true });
  const page = await context.newPage();
  await page.goto(PAGE);
  const r = await page.evaluate(async () => {
    const llm = (window as any).localLLM;
    const err = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.name);
    const before = await err(llm.fetchImage("http://localhost:8790/pixel.png"));
    await llm.search("pixel", { includeImages: true });
    const got = await llm.fetchImage("http://localhost:8790/pixel.png");
    const other = await err(llm.fetchImage("http://localhost:8790/index.html"));
    return { before, type: got.type, size: got.blob.size, blobType: got.blob.type, other, caps: llm.capabilities.fetchImage };
  });
  expect(r).toEqual({ before: "NotAllowedError", type: "image/png", size: 70, blobType: "image/png", other: "NotAllowedError", caps: true });
});
