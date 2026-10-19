// Prompt API conformance checks. The same suite runs against Chrome's native LanguageModel
// and the Local LLM extension; results should match in shape and error names.

const expectName = async (fn, name) => {
  try {
    await fn();
  } catch (e) {
    if (e?.name === name) return `threw ${name}`;
    throw new Error(`expected ${name}, got ${e?.name}: ${e?.message}`);
  }
  throw new Error(`expected ${name}, but it resolved`);
};

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

export const checks = [
  ["availability() returns a known state", async (LM) => {
    const a = await LM.availability();
    assert(["unavailable", "downloadable", "downloading", "available"].includes(a), `got ${a}`);
    return a;
  }],
  ["params() shape", async (LM) => {
    if (!LM.params) return "not implemented (optional)";
    const p = await LM.params();
    for (const k of ["defaultTopK", "maxTopK", "defaultTemperature", "maxTemperature"]) assert(typeof p[k] === "number", `missing ${k}`);
    return JSON.stringify(p);
  }],
  ["create() with system prompt and monitor", async (LM, ctx) => {
    const events = [];
    ctx.session = await LM.create({
      initialPrompts: [{ role: "system", content: "Answer in one short sentence." }],
      monitor(m) { m.addEventListener("downloadprogress", (e) => events.push(e.loaded)); },
    });
    assert(typeof ctx.session.prompt === "function", "no prompt()");
    return `progress events: ${events.length}`;
  }],
  ["prompt() returns a string", async (_LM, ctx) => {
    const t = await ctx.session.prompt("Say hello.");
    assert(typeof t === "string" && t.length > 0, "empty response");
    return t.slice(0, 80);
  }],
  ["promptStreaming() yields string chunks", async (_LM, ctx) => {
    let n = 0, text = "";
    for await (const c of ctx.session.promptStreaming("Count to three.")) {
      assert(typeof c === "string", "non-string chunk");
      n++; text += c;
    }
    assert(n > 0, "no chunks");
    return `${n} chunks: ${text.slice(0, 60)}`;
  }],
  ["inputUsage / inputQuota are numbers", async (_LM, ctx) => {
    assert(typeof ctx.session.inputUsage === "number" && typeof ctx.session.inputQuota === "number", "missing");
    assert(ctx.session.inputUsage > 0, "usage did not grow");
    return `${ctx.session.inputUsage} / ${ctx.session.inputQuota}`;
  }],
  ["measureInputUsage() returns a number", async (_LM, ctx) => {
    const n = await ctx.session.measureInputUsage("How many tokens is this?");
    assert(typeof n === "number" && n > 0, `got ${n}`);
    return String(n);
  }],
  ["array-of-messages input", async (_LM, ctx) => {
    const t = await ctx.session.prompt([{ role: "user", content: "Reply with OK." }]);
    assert(typeof t === "string", "not a string");
    return t.slice(0, 40);
  }],
  ["AbortSignal rejects with AbortError", async (_LM, ctx) => {
    const ac = new AbortController();
    const p = ctx.session.prompt("Write a long story about the sea.", { signal: ac.signal });
    ac.abort();
    return expectName(() => p, "AbortError");
  }],
  ["pre-aborted signal on create()", async (LM) => {
    const ac = new AbortController();
    ac.abort();
    return expectName(() => LM.create({ signal: ac.signal }), "AbortError");
  }],
  ["unsupported modality rejects with NotSupportedError", async (LM) =>
    expectName(() => LM.create({ expectedInputs: [{ type: "video" }] }), "NotSupportedError")],
  ["clone() is independent", async (_LM, ctx) => {
    const c = await ctx.session.clone();
    const t = await c.prompt("Reply with one word.");
    c.destroy();
    return t.slice(0, 40);
  }],
  ["destroy() then prompt() rejects with InvalidStateError", async (_LM, ctx) => {
    ctx.session.destroy();
    return expectName(() => ctx.session.prompt("x"), "InvalidStateError");
  }],
];

export async function runChecks(LM, onResult) {
  const ctx = {};
  const results = [];
  for (const [name, fn] of checks) {
    const started = performance.now();
    let r;
    try {
      r = { name, ok: true, detail: String(await fn(LM, ctx) ?? "") };
    } catch (e) {
      r = { name, ok: false, detail: `${e?.name ?? "Error"}: ${e?.message ?? e}` };
    }
    r.ms = Math.round(performance.now() - started);
    results.push(r);
    onResult?.(r);
  }
  return results;
}
