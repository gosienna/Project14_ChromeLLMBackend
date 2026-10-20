// Console capture for the browser tools: DevTools-style console messages from a tab via
// chrome.debugger (optional permission). Ported from Project05's mcp/tools/console-capture.js.

import { resolveTabId } from "./browser";

const PROTOCOL_VERSION = "1.3";
const RING_CAP = 500;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_CHARS = 14000;
const LEVEL_RANK: Record<string, number> = { debug: 0, log: 1, info: 2, warn: 3, error: 4, exception: 4 };

interface Entry {
  type: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

const tabs = new Map<number, { attached: boolean; messages: Entry[] }>();
let listening = false;

const state = (tabId: number) => {
  let s = tabs.get(tabId);
  if (!s) tabs.set(tabId, (s = { attached: false, messages: [] }));
  return s;
};

function push(tabId: number, entry: Entry) {
  const s = state(tabId);
  s.messages.push(entry);
  if (s.messages.length > RING_CAP) s.messages.splice(0, s.messages.length - RING_CAP);
}

interface RemoteObject {
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  type?: string;
  subtype?: string;
}

function text(o: RemoteObject | undefined): string {
  if (!o) return "undefined";
  if (o.value !== undefined) return typeof o.value === "string" ? o.value : JSON.stringify(o.value);
  if (o.description) return o.description;
  if (o.unserializableValue) return o.unserializableValue;
  if (o.type === "object" && o.subtype === "null") return "null";
  return o.type ? `[${o.type}]` : "";
}

function level(type: unknown): string {
  const t = String(type ?? "log").toLowerCase();
  if (t === "warning") return "warn";
  if (t === "assert") return "error";
  return LEVEL_RANK[t] != null ? t : "log";
}

function listen() {
  if (listening) return;
  listening = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId == null || !tabs.get(tabId)?.attached) return;
    const p = (params ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (method === "Runtime.consoleAPICalled") {
      const frame = p.stackTrace?.callFrames?.[0];
      push(tabId, { type: level(p.type), text: (p.args ?? []).map(text).join(" "), timestamp: p.timestamp ?? Date.now(), url: frame?.url, lineNumber: frame?.lineNumber });
    } else if (method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails ?? {};
      const stack = d.stackTrace?.callFrames?.slice(0, 8).map((f: any) => `  at ${f.functionName || "(anonymous)"} (${f.url}:${f.lineNumber}:${f.columnNumber})`).join("\n"); // eslint-disable-line @typescript-eslint/no-explicit-any
      const message = text(d.exception) || d.text || "Uncaught exception";
      push(tabId, { type: "exception", text: stack ? `${message}\n${stack}` : message, timestamp: p.timestamp ?? Date.now(), url: d.url, lineNumber: d.lineNumber });
    } else if (method === "Log.entryAdded") {
      const e = p.entry ?? {};
      push(tabId, { type: level(e.level), text: e.text ?? "", timestamp: e.timestamp ?? Date.now(), url: e.url, lineNumber: e.lineNumber });
    }
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId != null) state(source.tabId).attached = false;
  });
  chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
}

async function attach(tabId: number) {
  listen();
  const s = state(tabId);
  if (s.attached) return s;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (e) {
    if (!/already attached/i.test(String((e as Error).message))) throw e;
  }
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Log.enable");
  s.attached = true;
  return s;
}

export async function get_console_messages(args: Record<string, unknown>) {
  const tabId = await resolveTabId(args);
  const s = await attach(tabId);
  const min = LEVEL_RANK[level(args.level ?? "debug")] ?? 0;
  const filtered = s.messages.filter((m) => (LEVEL_RANK[m.type] ?? 1) >= min);
  const limit = Math.min(Math.max(Number(args.maxEntries) || DEFAULT_MAX_ENTRIES, 1), RING_CAP);
  let messages = filtered.slice(-limit);
  if (args.clear) s.messages = [];
  const maxChars = Number(args.maxChars) > 0 ? Number(args.maxChars) : DEFAULT_MAX_CHARS;
  // Keep the newest messages that fit.
  while (messages.length > 1 && JSON.stringify(messages).length > maxChars) messages = messages.slice(Math.ceil(messages.length / 4));
  return { tabId, messages, totalBuffered: filtered.length, returned: messages.length };
}

export async function clear_console_messages(args: Record<string, unknown>) {
  const tabId = await resolveTabId(args);
  state(tabId).messages = [];
  return { ok: true, tabId };
}
