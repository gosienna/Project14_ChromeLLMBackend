// Sandbox page for custom tools (manifest "sandbox"): its CSP allows building functions from
// strings, and its opaque origin has no extension APIs, storage or page access. The playground
// posts { type: "run", id, code, args }; api.callTool() is proxied back to the playground.

type Message = { type?: string; id?: string; callId?: string; code?: string; args?: unknown; result?: unknown; error?: string };

const calls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let counter = 0;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

window.addEventListener("message", async (ev: MessageEvent<Message>) => {
  if (ev.source !== parent) return;
  const m = ev.data;
  if (m?.type === "api-result" && m.callId) {
    const call = calls.get(m.callId);
    calls.delete(m.callId);
    if (m.error !== undefined) call?.reject(new Error(m.error));
    else call?.resolve(m.result);
    return;
  }
  if (m?.type !== "run" || !m.id) return;
  const id = m.id;
  const api = {
    callTool: (name: string, args: unknown = {}) =>
      new Promise((resolve, reject) => {
        const callId = `c${++counter}`;
        calls.set(callId, { resolve, reject });
        parent.postMessage({ type: "api", id, callId, name, args }, "*");
      }),
  };
  try {
    const fn = new AsyncFunction("args", "api", `"use strict";\n${m.code ?? ""}`);
    const result = await fn(m.args ?? {}, api);
    // Only JSON-shaped values go back.
    parent.postMessage({ type: "result", id, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) }, "*");
  } catch (e) {
    parent.postMessage({ type: "result", id, error: e instanceof Error ? e.message : String(e) }, "*");
  }
});
