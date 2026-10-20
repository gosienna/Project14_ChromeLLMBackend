import { PAGE, enable, expect, test } from "./fixtures";

// The echo engine calls a tool when the prompt is "/tool <name> <json args>" and that tool was
// offered, then answers "Tool <name> said: <result>" once the page has run it.

test("the page runs a tool the model calls and the model answers with its result", async ({ context, sw }) => {
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(PAGE);
  const r = await page.evaluate(async () => {
    const seen: unknown[] = [];
    const s = await (window as any).LanguageModel.create({
      tools: [{
        name: "getWeather",
        description: "Weather for a city",
        inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        async execute(args: { city: string }) {
          seen.push(args);
          return { city: args.city, sky: "sunny" };
        },
      }],
    });
    const answer = await s.prompt('/tool getWeather {"city":"Paris"}');
    let streamed = "";
    for await (const c of s.promptStreaming('/tool getWeather {"city":"Oslo"}')) streamed += c;
    // A clone keeps the tools; a tool that was not offered is never called.
    const clone = await s.clone();
    const cloned = await clone.prompt('/tool getWeather {"city":"Rome"}');
    const notOffered = await s.prompt('/tool launch {"x":1}');
    const info = await (window as any).localLLM.info();
    return { seen, answer, streamed, cloned, notOffered, tools: info.tools };
  });
  expect(r.seen).toEqual([{ city: "Paris" }, { city: "Oslo" }, { city: "Rome" }]);
  expect(r.answer).toBe('Tool getWeather said: {"city":"Paris","sky":"sunny"}');
  expect(r.streamed).toBe('Tool getWeather said: {"city":"Oslo","sky":"sunny"}');
  expect(r.cloned).toBe('Tool getWeather said: {"city":"Rome","sky":"sunny"}');
  expect(r.notOffered).toMatch(/^Echo #\d+: \/tool launch/);
  expect(r.tools).toBe("native");
});

test("a failing tool reports its error to the model", async ({ context, sw }) => {
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(PAGE);
  const answer = await page.evaluate(async () => {
    const s = await (window as any).LanguageModel.create({
      tools: [{ name: "flaky", description: "", inputSchema: { type: "object" }, execute() { throw new Error("service down"); } }],
    });
    return s.prompt("/tool flaky {}");
  });
  expect(answer).toBe("Tool flaky said: Error: service down");
});

test("aborting while a tool runs cancels the prompt", async ({ context, sw }) => {
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(PAGE);
  const r = await page.evaluate(async () => {
    const ac = new AbortController();
    const s = await (window as any).LanguageModel.create({
      tools: [{ name: "slow", description: "", inputSchema: { type: "object" }, execute: () => { ac.abort(); return new Promise((res) => setTimeout(() => res("late"), 200)); } }],
    });
    let name = "resolved";
    try { await s.prompt("/tool slow {}", { signal: ac.signal }); } catch (e) { name = (e as DOMException).name; }
    // The session still works afterwards.
    return { name, after: await s.prompt("hello") };
  });
  expect(r.name).toBe("AbortError");
  expect(r.after).toMatch(/^Echo #\d+: hello$/);
});

test("create() rejects malformed tools in the page", async ({ context, sw }) => {
  await enable(sw, "always");
  const page = await context.newPage();
  await page.goto(PAGE);
  const errors = await page.evaluate(async () => {
    const LM = (window as any).LanguageModel;
    const attempt = async (tools: unknown) => {
      try { await LM.create({ tools }); return "created"; } catch (e) { return (e as Error).name; }
    };
    return [
      await attempt([{ name: "no execute", description: "" }]),
      await attempt([{ name: "ok", execute() {} }, { name: "ok", execute() {} }]),
      await attempt("nope"),
    ];
  });
  expect(errors).toEqual(["TypeError", "TypeError", "TypeError"]);
});
