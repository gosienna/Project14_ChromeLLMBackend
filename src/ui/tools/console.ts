// Console capture for the playground's browser tools.
//
// Chrome refuses `debugger` as an optional permission, and a required `debugger`
// permission is outside this extension's purpose (a language model for approved
// sites). The hook below is installed with chrome.scripting, which the extension
// already has, the first time a console tool runs on a tab. Only messages after
// that are visible. The two injected functions must not reference anything
// outside their own bodies: Chrome evaluates them in the page.

import { resolveTabId } from "./browser";

const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;
const RING_CAP = 500;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_CHARS = 14000;

export interface ConsoleMsg {
  type: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

export interface ConsoleReadSpec {
  level: string;
  maxEntries: number;
  clear: boolean;
  maxChars: number;
}

interface ConsoleBuf {
  messages: ConsoleMsg[];
}

async function assertRunnable(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`Tab ${tabId} not found`);
  }
  const url = tab.url ?? tab.pendingUrl ?? "";
  if (RESTRICTED.test(url)) throw new Error(`Cannot read the console on a restricted page: ${url}`);
}

/** Installed in the page's MAIN world. Idempotent. */
export function installConsoleBuffer(): void {
  const g = globalThis as typeof globalThis & { __localLlmConsole?: ConsoleBuf };
  if (g.__localLlmConsole) return;
  const messages: ConsoleMsg[] = [];
  g.__localLlmConsole = { messages };
  const cap = 500;
  const push = (entry: ConsoleMsg) => {
    messages.push(entry);
    if (messages.length > cap) messages.splice(0, messages.length - cap);
  };
  const format = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || v.message;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  const levels = ["debug", "log", "info", "warn", "error"] as const;
  for (const type of levels) {
    const orig = console[type].bind(console);
    console[type] = (...args: unknown[]) => {
      push({ type, text: args.map(format).join(" "), timestamp: Date.now() });
      return orig(...args);
    };
  }
  globalThis.addEventListener("error", (e) => {
    const ev = e as ErrorEvent;
    const err = ev.error;
    const text = err instanceof Error ? err.stack || err.message : ev.message;
    push({ type: "exception", text, timestamp: Date.now(), url: ev.filename, lineNumber: ev.lineno });
  });
  globalThis.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    const text = reason instanceof Error ? reason.stack || reason.message : format(reason);
    push({ type: "exception", text, timestamp: Date.now() });
  });
}

/** Reads the page's buffer. Self-contained so Chrome can run it in the page. */
export function readConsoleBuffer(spec: ConsoleReadSpec): { messages: ConsoleMsg[]; totalBuffered: number; returned: number } {
  const g = globalThis as typeof globalThis & { __localLlmConsole?: ConsoleBuf };
  const rank: Record<string, number> = { debug: 0, log: 1, info: 2, warn: 3, error: 4, exception: 4 };
  const min = rank[spec.level] ?? 0;
  const all = g.__localLlmConsole?.messages ?? [];
  const filtered = all.filter((m) => (rank[m.type] ?? 1) >= min);
  const limit = Math.min(Math.max(spec.maxEntries || 100, 1), 500);
  let messages = filtered.slice(-limit);
  if (spec.clear && g.__localLlmConsole) g.__localLlmConsole.messages = [];
  const maxChars = spec.maxChars > 0 ? spec.maxChars : 14000;
  while (messages.length > 1 && JSON.stringify(messages).length > maxChars) messages = messages.slice(Math.ceil(messages.length / 4));
  return { messages, totalBuffered: filtered.length, returned: messages.length };
}

/** Clears the page's buffer. Self-contained so Chrome can run it in the page. */
export function clearConsoleBuffer(): { ok: true } {
  const g = globalThis as typeof globalThis & { __localLlmConsole?: ConsoleBuf };
  if (g.__localLlmConsole) g.__localLlmConsole.messages = [];
  return { ok: true };
}

function specFrom(args: Record<string, unknown>): ConsoleReadSpec {
  const level = String(args.level ?? "debug").toLowerCase();
  return {
    level: ["debug", "log", "info", "warn", "error"].includes(level) ? level : "debug",
    maxEntries: Math.min(Math.max(Number(args.maxEntries) || DEFAULT_MAX_ENTRIES, 1), RING_CAP),
    clear: args.clear === true,
    maxChars: Number(args.maxChars) > 0 ? Number(args.maxChars) : DEFAULT_MAX_CHARS,
  };
}

async function inTab<R>(tabId: number, func: (...args: any[]) => R, fnArgs: unknown[] = []): Promise<R> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args: fnArgs });
  return res?.result as R;
}

export async function get_console_messages(args: Record<string, unknown>) {
  const tabId = await resolveTabId(args);
  await assertRunnable(tabId);
  try {
    await inTab(tabId, installConsoleBuffer);
    const read = await inTab(tabId, readConsoleBuffer, [specFrom(args)]);
    return { tabId, ...read };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not read the console on tab ${tabId}. Allow page access in the Tools panel. ${detail}`);
  }
}

export async function clear_console_messages(args: Record<string, unknown>) {
  const tabId = await resolveTabId(args);
  await assertRunnable(tabId);
  try {
    const cleared = await inTab(tabId, clearConsoleBuffer);
    return { ...cleared, tabId };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not clear the console on tab ${tabId}. Allow page access in the Tools panel. ${detail}`);
  }
}
