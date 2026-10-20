import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { deliversTo } from "../src/background/policy";
import { openAICompatAdapter } from "../src/offscreen/adapters/openai-compat";
import type { Trace } from "../src/offscreen/backend";
import { sanitizeTrace, tracedAdapter, withResponseTrace } from "../src/offscreen/trace";
import { BUILTIN_PROVIDERS } from "../src/shared/providers";
import { parsePayload } from "../src/ui/playground/payload";
import { BUILTIN_TOOLS } from "../src/ui/tools/builtin";
import { registryTools } from "../src/ui/tools/meta";
import { declarations, deleteTool, getTool, listTools, resetTool, saveTool, seedBuiltins, validateTool } from "../src/ui/tools/registry";
import { rowsToSchema, schemaToRows } from "../src/ui/tools/schema-form";
import { streamOf } from "./streams";

describe("raw traces", () => {
  it("shrink images, binary data and base64 but keep ordinary text", () => {
    const img = "A".repeat(5000);
    const out = sanitizeTrace({ messages: [{ content: "hi", image: `data:image/png;base64,${img}`, data: img, buf: new ArrayBuffer(2048) }] }) as any;
    expect(out.messages[0].content).toBe("hi");
    expect(out.messages[0].image).toMatch(/^<base64 · \d+ KB>$/);
    expect(out.messages[0].data).toMatch(/^<base64/);
    expect(out.messages[0].buf).toBe("<binary · 2 KB>");
    expect(sanitizeTrace("word ".repeat(1000))).toBe("word ".repeat(1000));
  });

  it("record a cloud provider's posted body and raw stream events", async () => {
    const events = [{ choices: [{ delta: { content: "Hi" } }] }, { usage: { prompt_tokens: 3, completion_tokens: 1 } }];
    const f = (async () => new Response(streamOf(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")))) as unknown as typeof fetch;
    const traces: Trace[] = [];
    const provider = BUILTIN_PROVIDERS.find((p) => p.id === "openai")!;
    const gen = tracedAdapter(openAICompatAdapter, "openai")({ provider, model: "m", apiKey: "SECRET" }, [{ role: "user", content: "hello" }], { temperature: 1, topK: 3, onTrace: (t) => traces.push(t) }, new AbortController().signal, f);
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    expect(traces).toHaveLength(1);
    const t = traces[0] as any;
    expect(t.engine).toBe("openai");
    expect(t.request.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(JSON.stringify(t)).not.toContain("SECRET"); // headers are never traced
    expect(t.response).toMatchObject({ text: "Hi", inputTokens: 3, outputTokens: 1, events });
  });

  it("report the error when a generation fails", async () => {
    const traces: Trace[] = [];
    const gen = withResponseTrace({ temperature: 1, topK: 1, onTrace: (t) => traces.push(t) }, (o) => (async function* () {
      o.onTrace?.({ engine: "webllm", request: { messages: [] } });
      yield "par";
      throw new Error("GPU lost");
    })());
    await expect((async () => { for (;;) if ((await gen.next()).done) break; })()).rejects.toThrow("GPU lost");
    expect(traces[0]).toMatchObject({ engine: "webllm", request: { messages: [] }, response: { text: "par", error: "Error: GPU lost" } });
  });

  it("reach the playground only", () => {
    expect(deliversTo("trace", false)).toBe(false);
    expect(deliversTo("trace", true)).toBe(true);
  });
});

describe("tool registry", () => {
  it("seeds every built-in, disabled, and keeps user choices on reseed", async () => {
    await seedBuiltins();
    const tools = await listTools();
    expect(tools.filter((t) => t.kind === "builtin").map((t) => t.name).sort()).toEqual(BUILTIN_TOOLS.map((b) => b.name).sort());
    expect(tools.every((t) => !t.enabled)).toBe(true);
    const snap = (await getTool("browser_snapshot"))!;
    await saveTool({ ...snap, enabled: true, confirm: true });
    await seedBuiltins();
    expect(await getTool("browser_snapshot")).toMatchObject({ enabled: true, confirm: true });
  });

  it("validates names, collisions and custom code", async () => {
    const base = { description: "d", inputSchema: { type: "object" }, kind: "custom" as const, code: "return 1;" };
    expect(await validateTool({ ...base, name: "bad name" }, true)).toMatch(/Name/);
    expect(await validateTool({ ...base, name: "read_page" }, true)).toMatch(/built-in/);
    expect(await validateTool({ ...base, name: "ok_tool", code: "" }, true)).toMatch(/code/);
    expect(await validateTool({ ...base, name: "ok_tool" }, true)).toBeNull();
  });

  it("refuses to delete built-ins and resets edited ones", async () => {
    await expect(deleteTool("read_page")).rejects.toThrow(/built in/);
    const rp = (await getTool("read_page"))!;
    await saveTool({ ...rp, description: "mine", edited: true });
    await seedBuiltins();
    expect((await getTool("read_page"))!.description).toBe("mine"); // edits survive reseeding
    expect((await resetTool("read_page")).description).toBe(BUILTIN_TOOLS.find((b) => b.name === "read_page")!.description);
  });

  it("offers only enabled tools to a session", async () => {
    const decls = declarations(await listTools());
    expect(decls.map((d) => d.name)).toContain("browser_snapshot");
    expect(decls.map((d) => d.name)).not.toContain("read_page");
    expect(Object.keys(decls[0]).sort()).toEqual(["description", "inputSchema", "name"]);
  });

  it("lets the model create, read, edit and delete custom tools", async () => {
    await registryTools.create({ name: "add", description: "Add two numbers", inputSchema: { type: "object" }, code: "return args.a + args.b;" });
    expect(await getTool("add")).toMatchObject({ kind: "custom", enabled: true, confirm: true });
    expect(await registryTools.get({ name: "add" })).toMatchObject({ code: "return args.a + args.b;" });
    const add = (await getTool("add"))!;
    await saveTool({ ...add, confirm: false });
    await registryTools.update({ name: "add", code: "return args.a - args.b;" });
    expect(await getTool("add")).toMatchObject({ code: "return args.a - args.b;", confirm: true }); // new code asks again
    await expect(registryTools.update({ name: "read_page", code: "x" })).rejects.toThrow(/built in/);
    await registryTools.update({ name: "read_page", description: "Read it" });
    expect(await getTool("read_page")).toMatchObject({ description: "Read it", edited: true });
    await expect(registryTools.create({ name: "add", description: "dup", code: "1" })).rejects.toThrow(/already exists/);
    await registryTools.remove({ name: "add" });
    expect(await getTool("add")).toBeUndefined();
    await expect(registryTools.remove({ name: "list_tools" })).rejects.toThrow(/built in/);
  });
});

describe("parameter form", () => {
  it("round-trips flat schemas", () => {
    const schema = {
      type: "object",
      properties: { city: { type: "string", description: "City", enum: ["Paris", "Oslo"] }, days: { type: "integer" }, tags: { type: "array", items: {} } },
      required: ["city"],
    };
    const rows = schemaToRows(schema)!;
    expect(rows.map((r) => r.name)).toEqual(["city", "days", "tags"]);
    expect(rowsToSchema(rows)).toEqual(schema);
  });
  it("leaves rich schemas to the JSON editor", () => {
    expect(schemaToRows({ type: "object", properties: { a: { type: "object", properties: {} } } })).toBeNull();
    expect(schemaToRows({ type: "object", properties: {}, additionalProperties: false })).toBeNull();
  });
});

describe("edited request payload", () => {
  const known = new Set(["getWeather"]);
  const ok = (v: unknown) => parsePayload(JSON.stringify(v), known);
  it("accepts a conversation ending in a user turn, with registry tools", () => {
    const r = ok({ messages: [{ role: "system", content: "S" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }], tools: [{ name: "getWeather", description: "", inputSchema: { type: "object" } }] });
    expect("payload" in r && r.payload.messages).toHaveLength(4);
  });
  it("explains what's wrong", () => {
    expect(parsePayload("{", known)).toMatchObject({ error: expect.stringMatching(/Invalid JSON/) });
    expect(ok({ messages: [{ role: "user", content: "a" }, { role: "system", content: "S" }] })).toMatchObject({ error: expect.stringMatching(/system/) });
    expect(ok({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] })).toMatchObject({ error: expect.stringMatching(/last message/) });
    expect(ok({ messages: [{ role: "tool", content: "a" }] })).toMatchObject({ error: expect.stringMatching(/role/) });
    expect(ok({ messages: [{ role: "user", content: "a" }], tools: [{ name: "launch", inputSchema: {} }] })).toMatchObject({ error: expect.stringMatching(/registry/) });
    expect(ok({ messages: [{ role: "user", content: "a" }], temperature: 1 })).toMatchObject({ error: expect.stringMatching(/Unknown field/) });
  });
});
