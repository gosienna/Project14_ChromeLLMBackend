// Runs registry tools for the playground: built-ins in this page, custom tools in the sandbox page
// (ui/tool-sandbox.html: opaque origin, no extension APIs), each after the enabled and
// "ask before running" checks.

import { findBuiltin, type ToolContext } from "./builtin";
import { registryTools } from "./meta";
import { getTool, type ToolRecord } from "./registry";

type Args = Record<string, unknown>;

export interface RunOptions {
  /** Ask the user to approve a run; false declines it. */
  confirm(rec: ToolRecord, args: Args): Promise<boolean>;
  webSearch(args: Args): Promise<unknown>;
}

/** Custom tools calling tools calling tools: stop before it loops. */
const MAX_DEPTH = 4;
const SANDBOX_TIMEOUT_MS = 30_000;

/** Run a tool and return its result as text for the model. Throws if it can't or mustn't run. */
export async function runTool(name: string, args: Args, opts: RunOptions, depth = 0): Promise<string> {
  return (await runToolWithValue(name, args, opts, depth)).text;
}

/** runTool, also returning the tool's value before it became text (the playground shows images from it). */
export async function runToolWithValue(name: string, args: Args, opts: RunOptions, depth = 0): Promise<{ text: string; value: unknown }> {
  if (depth > MAX_DEPTH) throw new Error("Too many nested tool calls");
  const rec = await getTool(name);
  if (!rec?.enabled) throw new Error(`Tool "${name}" is not enabled`);
  if (rec.confirm && !(await opts.confirm(rec, args))) throw new Error("The user declined to run this tool");
  let value: unknown;
  if (rec.kind === "builtin") {
    const b = findBuiltin(name);
    if (!b) throw new Error(`Built-in tool "${name}" has no implementation`);
    const ctx: ToolContext = { webSearch: opts.webSearch, registry: registryTools };
    value = await b.run(args, ctx);
  } else {
    value = await runInSandbox(rec.code ?? "", args, (n, a) => runTool(n, a, opts, depth + 1));
  }
  return { text: typeof value === "string" ? value : (JSON.stringify(value) ?? "null"), value };
}

// ---- Sandbox ------------------------------------------------------------------

let frame: HTMLIFrameElement | null = null;
let frameReady: Promise<Window> | null = null;
const runs = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; callTool: (name: string, args: Args) => Promise<string> }>();
let counter = 0;

function sandbox(): Promise<Window> {
  return (frameReady ??= new Promise((resolve, reject) => {
    frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("ui/tool-sandbox.html");
    frame.hidden = true;
    frame.onload = () => resolve(frame!.contentWindow!);
    frame.onerror = () => reject(new Error("Could not start the tool sandbox"));
    document.body.append(frame);
    window.addEventListener("message", onSandboxMessage);
  }));
}

function onSandboxMessage(ev: MessageEvent) {
  if (!frame || ev.source !== frame.contentWindow) return;
  const m = ev.data as { type?: string; id?: string; callId?: string; name?: string; args?: Args; result?: unknown; error?: string };
  const run = m.id ? runs.get(m.id) : undefined;
  if (!run) return;
  if (m.type === "api") {
    run.callTool(String(m.name), m.args ?? {}).then(
      (result) => frame?.contentWindow?.postMessage({ type: "api-result", id: m.id, callId: m.callId, result }, "*"),
      (e: Error) => frame?.contentWindow?.postMessage({ type: "api-result", id: m.id, callId: m.callId, error: e.message }, "*"),
    );
  } else if (m.type === "result") {
    runs.delete(m.id!);
    if (m.error !== undefined) run.reject(new Error(m.error));
    else run.resolve(m.result);
  }
}

/** Run a custom tool's code in the sandbox page; `callTool` serves its api.callTool(). */
export async function runInSandbox(code: string, args: Args, callTool: (name: string, args: Args) => Promise<string>): Promise<unknown> {
  const win = await sandbox();
  const id = `run${++counter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runs.delete(id);
      reject(new Error(`Tool code did not finish within ${SANDBOX_TIMEOUT_MS / 1000} s`));
    }, SANDBOX_TIMEOUT_MS);
    runs.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
      callTool,
    });
    // The sandbox's origin is opaque, so "*" is the only target that reaches it; it holds no secrets.
    win.postMessage({ type: "run", id, code, args }, "*");
  });
}
