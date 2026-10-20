// Playground: chat with the configured backends from inside the extension, with image input,
// the extension's own tools (registry in IndexedDB, tools/*) and raw views of every request and
// response (playground/raw.ts). Talks to the router over its own port; the router skips site
// consent here since this is extension UI, but keys still never reach this page.

import { findModel } from "../shared/catalog";
import { findCloudModel } from "../shared/cloud-models";
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BASE64,
  MAX_IMAGES_PER_MESSAGE,
  randomId,
  type Availability,
  type ChatMessage,
  type DistributiveOmit,
  type ImageInput,
  type ImageMime,
  type PageRequest,
  type PageResponse,
  type PlaygroundEnvelope,
  type SessionInfo,
  type ToolDecl,
} from "../shared/protocol";
import { allProviders, getSettings } from "../shared/settings";
import { h, send as uiSend } from "./dom";
import { renderMarkdown } from "./markdown";
import type { Payload } from "./playground/payload";
import { PendingRaw, replyRaw, type TraceEntry } from "./playground/raw";
import { ToolsPanel } from "./playground/tools-panel";
import { declarations, listTools, registryEvents, seedBuiltins, type ToolRecord } from "./tools/registry";
import { runTool } from "./tools/run";

const app = document.getElementById("app")!;

// ---- Port to the router -------------------------------------------------------

interface Pending {
  resolve: (value: unknown) => void;
  reject: (e: Error) => void;
  onChunk?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onProgress?: (loaded: number) => void;
  onTrace?: (t: TraceEntry) => void;
  onToolCall?: (call: Extract<PageResponse, { kind: "tool-call" }>) => void;
}

let port: chrome.runtime.Port | null = null;
const pending = new Map<string, Pending>();

function connect(): chrome.runtime.Port {
  if (port) return port;
  const p = chrome.runtime.connect({ name: "llm-playground" });
  p.onMessage.addListener((res: PageResponse) => {
    const w = pending.get(res.id);
    if (!w) return;
    switch (res.kind) {
      case "chunk":
        return w.onChunk?.(res.text);
      case "reasoning":
        return w.onReasoning?.(res.text);
      case "trace":
        return w.onTrace?.({ round: res.round, trace: res.trace });
      case "tool-call":
        return w.onToolCall?.(res);
      case "progress":
        return w.onProgress?.(res.loaded);
      case "result":
        pending.delete(res.id);
        return w.resolve(res.value);
      case "done":
        pending.delete(res.id);
        return w.resolve(res.inputUsage);
      case "error":
        pending.delete(res.id);
        return w.reject(Object.assign(new Error(res.message), { name: res.name }));
    }
  });
  p.onDisconnect.addListener(() => {
    // The router releases this port's sessions when it goes away.
    port = null;
    session = null;
    for (const w of pending.values()) w.reject(Object.assign(new Error("The extension restarted; the conversation was reset"), { name: "OperationError" }));
    pending.clear();
  });
  return (port = p);
}

function request<T>(req: DistributiveOmit<PageRequest, "id">, handlers: Omit<Pending, "resolve" | "reject"> = {}): { id: string; promise: Promise<T> } {
  const id = randomId();
  const promise = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, ...handlers });
    const env: PlaygroundEnvelope = { backend: backendId, req: { ...req, id } as PageRequest };
    connect().postMessage(env);
  });
  return { id, promise };
}

const send = (req: DistributiveOmit<PageRequest, "id">) => connect().postMessage({ backend: backendId, req: { ...req, id: randomId() } } satisfies PlaygroundEnvelope);

/** The router drops replies to aborted requests, so settle the request here. */
function abort(target: string) {
  send({ kind: "abort", target });
  pending.get(target)?.reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
  pending.delete(target);
}

// ---- State --------------------------------------------------------------------

interface Attachment extends ImageInput {
  url: string;
  name: string;
}

const BACKEND_KEY = "playground.backend";
const MARKDOWN_KEY = "playground.markdown";
let backendId = "local";
let session: SessionInfo | null = null;
let acceptsImages = false;
let attachments: Attachment[] = [];
/** True from submit until the reply finishes; `generating` is the prompt request once sent. */
let busy = false;
let generating: string | null = null;
/** Object URLs shown in the transcript; revoked when the chat is cleared. */
let urls: string[] = [];
/** The conversation's text turns, for the raw preview and for continuing in a new session. */
let transcript: ChatMessage[] = [];
/** The tool registry changed since the session was created. */
let toolsStale = false;

// ---- Elements -----------------------------------------------------------------

const backendSel = h("select", { "aria-label": "Backend", onchange: () => void switchBackend(backendSel.value) });
const status = h("span", { class: "small muted" });
const systemInput = h("textarea", { rows: 2, placeholder: "Optional system prompt", "aria-label": "System prompt", onchange: () => newChat() });
/** Render replies as Markdown and math (on by default; remembered in this browser). */
let renderMd = (() => {
  try {
    return localStorage.getItem(MARKDOWN_KEY) !== "off";
  } catch {
    return true;
  }
})();
const markdownToggle = h("input", { type: "checkbox", checked: renderMd, onchange: () => {
  renderMd = markdownToggle.checked;
  try {
    localStorage.setItem(MARKDOWN_KEY, renderMd ? "on" : "off");
  } catch {
    /* storage unavailable */
  }
  for (const el of log.querySelectorAll<HTMLElement>("[data-md]")) showAnswer(el, el.dataset.md ?? "");
} });

/** Show reply text: rendered Markdown and math, or plain text. The source stays in data-md. */
function showAnswer(el: HTMLElement, text: string) {
  el.dataset.md = text;
  el.classList.toggle("pg-md", renderMd);
  if (renderMd) el.innerHTML = renderMarkdown(text);
  else el.textContent = text;
}

const tempInput = h("input", { type: "number", min: 0, max: 2, step: 0.1, placeholder: "default", "aria-label": "Temperature", onchange: () => newChat() });
const log = h("div", { class: "pg-log", "aria-live": "polite" });
const empty = h("p", { class: "pg-empty muted" }, "Send a message to start a conversation. Attach, paste or drop images to include them.");
const tray = h("div", { class: "pg-tray" });
const fileInput = h("input", { type: "file", accept: IMAGE_MIME_TYPES.join(","), multiple: true, hidden: true, onchange: () => {
  void addFiles([...(fileInput.files ?? [])]);
  fileInput.value = "";
} });
const attachBtn = h("button", { type: "button", onclick: () => fileInput.click() }, "Add image");
const input = h("textarea", { rows: 3, placeholder: "Message", "aria-label": "Message" });
const sendBtn = h("button", { type: "submit", class: "primary" }, "Send");
const usage = h("span", { class: "small muted" });
const toolsPanel = new ToolsPanel();
const toolsBox = h("details", { class: "pg-tools-box" }, h("summary", {}, "Tools"), toolsPanel.element);
const pendingRaw = new PendingRaw(pendingPayload, async () => new Set((await listTools()).map((t) => t.name)));
const note = h("span", { class: "small pg-note", role: "status" });

function flash(text: string) {
  note.textContent = text;
  setTimeout(() => note.textContent === text && (note.textContent = ""), 5000);
}

// ---- Backends -----------------------------------------------------------------

async function loadBackends() {
  const settings = await getSettings();
  const model = findModel(settings.local.modelId);
  const options: Array<[string, string]> = [["local", `Local · ${model?.name ?? settings.local.modelId}`]];
  for (const p of allProviders(settings)) {
    const cfg = settings.providers[p.id];
    const id = cfg?.model || p.defaultModel;
    if (cfg?.enabled) options.push([p.id, `${p.name} · ${findCloudModel(p.id, id)?.name ?? id}`]);
  }
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(BACKEND_KEY);
  } catch {
    /* storage unavailable */
  }
  backendId = options.some(([id]) => id === saved) ? saved! : "local";
  backendSel.replaceChildren(...options.map(([id, label]) => h("option", { value: id, selected: id === backendId }, label)));
}

async function describeBackend() {
  status.textContent = "Checking backend…";
  try {
    const [info, avail] = await Promise.all([
      request<{ name: string; backend: string; images: boolean }>({ kind: "info" }).promise,
      request<Availability>({ kind: "availability" }).promise,
    ]);
    acceptsImages = info.images;
    const note = avail === "downloadable" ? " · downloads on first message" : avail === "downloading" ? " · downloading" : avail === "unavailable" ? " · unavailable on this device" : "";
    status.textContent = `${info.name} on ${info.backend}${note}`;
  } catch (e) {
    acceptsImages = false;
    status.textContent = (e as Error).message;
  }
  attachBtn.title = acceptsImages ? "" : "This backend reads text only. Pick a cloud provider or Chrome's built-in model for images.";
  renderTray();
}

async function switchBackend(id: string) {
  backendId = id;
  try {
    localStorage.setItem(BACKEND_KEY, id);
  } catch {
    /* storage unavailable */
  }
  newChat();
  await describeBackend();
}

// ---- Conversation -------------------------------------------------------------

function newChat() {
  if (generating) abort(generating);
  dropSession();
  for (const u of urls) URL.revokeObjectURL(u);
  urls = [];
  transcript = [];
  log.replaceChildren(empty);
  usage.textContent = "";
  void pendingRaw.refresh();
}

function dropSession() {
  if (session) send({ kind: "destroy", sessionId: session.sessionId });
  session = null;
}

const systemPrompt = (): ChatMessage[] => (systemInput.value.trim() ? [{ role: "system", content: systemInput.value.trim() }] : []);

/** Declarations of the enabled tools, as a session is created with them. */
async function enabledTools(): Promise<ToolDecl[]> {
  return declarations(await listTools());
}

/** What the next Send passes to the backend (shown and editable in the composer's raw panel). */
async function pendingPayload(): Promise<Payload> {
  const tools = await enabledTools();
  return { messages: [...systemPrompt(), ...transcript, { role: "user", content: input.value }], ...(tools.length ? { tools } : {}) };
}

/**
 * The open session, or a new one carrying the system prompt, the conversation so far (when the
 * tools changed mid-chat) and the enabled tools. An edited request supplies its own history and tools.
 */
async function ensureSession(onProgress: (f: number) => void, edited?: Payload): Promise<SessionInfo> {
  if (session) return session;
  const history = edited ? edited.messages.slice(0, -1) : [...systemPrompt(), ...transcript];
  const tools = edited ? (edited.tools ?? []) : await enabledTools();
  const temperature = tempInput.value === "" ? undefined : Math.min(2, Math.max(0, Number(tempInput.value)));
  toolsStale = false;
  session = await request<SessionInfo>(
    {
      kind: "create",
      options: { ...(history.length ? { initialPrompts: history } : {}), ...(temperature === undefined ? {} : { temperature }), ...(tools.length ? { tools } : {}) },
      monitor: true,
    },
    { onProgress },
  ).promise;
  return session;
}

function bubble(role: "user" | "assistant", ...children: Array<Node | string>): HTMLElement {
  empty.remove();
  const el = h("div", { class: `pg-msg pg-${role}` }, ...children);
  log.append(el);
  // A new message always brings the view to the bottom.
  followLog = true;
  scrollLog();
  return el;
}

/** Keep the transcript pinned to its end while the user is there (replies grow after they arrive). */
let followLog = true;
/** The log's size when last measured: scroll events that come with a size change are layout, not the user. */
let logSize = "";
const sizeOf = () => `${log.clientHeight}:${log.scrollHeight}`;
const scrollLog = () => {
  if (followLog) log.scrollTop = log.scrollHeight;
  logSize = sizeOf();
};
log.addEventListener("scroll", () => {
  const size = sizeOf();
  if (size !== logSize) return scrollLog();
  followLog = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
});
// Streaming text, tool cards, raw panels and collapsing details all change the content's height,
// and opening panels elsewhere changes the log's own height.
new MutationObserver(scrollLog).observe(log, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open", "hidden", "class"] });
new ResizeObserver(scrollLog).observe(log);

function notice(text: string) {
  empty.remove();
  log.append(h("p", { class: "pg-notice small muted" }, text));
}

// ---- Tools --------------------------------------------------------------------

/** Tool results sent back to the model are capped (Project05's limits): local models have small contexts. */
const resultLimit = () => (backendId === "local" ? 3000 : 8000);
const capResult = (text: string) => (text.length > resultLimit() ? `${text.slice(0, resultLimit())}\n...[truncated, ${text.length} chars total]` : text);

/** A tool call shown in the reply: arguments, then the result; asks first when the tool requires it. */
function toolCard(name: string, args: Record<string, unknown>) {
  const status = h("span", { class: "small muted" }, "running…");
  const result = h("pre", { class: "pg-tool-result", hidden: true });
  const actions = h("div", { class: "row", hidden: true });
  const el = h("details", { class: "pg-toolcall", open: true },
    h("summary", { class: "small" }, "Tool ", h("code", {}, name), " ", status),
    h("pre", { class: "pg-tool-args" }, JSON.stringify(args, null, 2)),
    actions,
    result);
  return {
    el,
    ask(rec: ToolRecord): Promise<boolean> {
      status.textContent = "waiting for you";
      return new Promise((resolve) => {
        const answer = (ok: boolean) => {
          actions.hidden = true;
          status.textContent = ok ? "running…" : "declined";
          resolve(ok);
        };
        actions.replaceChildren(
          h("span", { class: "small" }, `Run ${rec.name}?`),
          h("button", { type: "button", class: "primary", onclick: () => answer(true) }, "Run"),
          h("button", { type: "button", onclick: () => answer(false) }, "Deny"));
        actions.hidden = false;
      });
    },
    done(text: string, isError: boolean) {
      status.textContent = isError ? "failed" : "done";
      result.textContent = text;
      result.hidden = false;
      result.classList.toggle("warn-text", isError);
      el.open = false;
    },
  };
}

async function webSearch(args: Record<string, unknown>) {
  return uiSend({ type: "tool:web_search", args });
}

/** Run a tool the model called during prompt `target` and send the result back. */
async function handleToolCall(target: string, call: Extract<PageResponse, { kind: "tool-call" }>, before: Element) {
  const card = toolCard(call.name, call.arguments);
  before.before(card.el);
  let text: string;
  let isError = false;
  try {
    text = capResult(await runTool(call.name, call.arguments, { confirm: (rec) => card.ask(rec), webSearch }));
  } catch (e) {
    isError = true;
    text = (e as Error).message;
  }
  card.done(text, isError);
  if (pending.has(target)) send({ kind: "tool-result", target, callId: call.callId, result: text, isError });
}

// ---- Sending ------------------------------------------------------------------

async function submit() {
  if (busy) {
    if (generating) abort(generating);
    return;
  }
  const edited = pendingRaw.override;
  const text = edited ? edited.messages.at(-1)!.content : input.value.trim();
  const images = edited ? [] : attachments;
  if (!text && !images.length) return;
  input.value = "";
  if (!edited) {
    attachments = [];
    renderTray();
  }

  if (edited) {
    // The edited request replaces the conversation: a fresh session from its messages and tools.
    pendingRaw.clearOverride();
    if (generating) abort(generating);
    dropSession();
    log.replaceChildren();
    const history = edited.messages.slice(0, -1);
    const system = history[0]?.role === "system" ? history.shift()! : null;
    systemInput.value = system?.content ?? "";
    transcript = history;
    notice("Sent an edited request: the conversation below starts from it.");
    for (const m of history) {
      const el = h("div", { class: "pg-text" });
      if (m.role === "assistant") showAnswer(el, m.content);
      else el.textContent = m.content;
      bubble(m.role as "user" | "assistant", el);
    }
  } else if (toolsStale && session) {
    // Tools are fixed per session; continue the conversation in one with the new tools.
    dropSession();
    notice("Tools changed: continuing in a new session with the updated tools.");
  }

  urls.push(...images.map((i) => i.url));
  bubble("user",
    ...(images.length ? [h("div", { class: "pg-images" }, ...images.map((i) => h("img", { src: i.url, alt: i.name })))] : []),
    ...(text ? [h("div", { class: "pg-text" }, text)] : []));
  const out = h("div", { class: "pg-text" });
  const raw = replyRaw();
  const reply = bubble("assistant", out, h("div", { class: "row pg-reply-meta" }, raw.toggle), raw.panel);
  reply.classList.add("pg-pending");

  setBusy(true);
  let answer = "";
  let thought = "";
  // Created on the first reasoning chunk; collapsed so the answer stays in view.
  let thinking: { box: HTMLDetailsElement; text: HTMLElement } | null = null;
  // Markdown is re-rendered at most once per frame while the reply streams.
  let frame = 0;
  const paint = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      showAnswer(out, answer);
    });
  };
  try {
    const s = await ensureSession((f) => (out.textContent = f < 1 ? `Loading model… ${Math.round(f * 100)}%` : "Loading model…"), edited ?? undefined);
    out.textContent = "";
    const { id, promise } = request<number | undefined>(
      { kind: "prompt", sessionId: s.sessionId, stream: true, input: [{ role: "user", content: text, ...(images.length ? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) } : {}) }] },
      {
        onChunk: (t) => {
          answer += t;
          paint();
          if (thinking) thinking.box.querySelector("summary")!.textContent = "Thought";
        },
        onReasoning: (t) => {
          if (!thinking) {
            const text = h("div", { class: "pg-text small muted" });
            thinking = { box: h("details", { class: "pg-thinking" }, h("summary", { class: "small muted" }, "Thinking…"), text), text };
            out.before(thinking.box);
          }
          thought += t;
          thinking.text.textContent = thought;
        },
        onTrace: (t) => raw.add(t),
        onToolCall: (call) => void handleToolCall(id, call, out),
      },
    );
    generating = id;
    const inputUsage = await promise;
    if (typeof inputUsage === "number") usage.textContent = `Context ${inputUsage} / ${s.inputQuota} tokens`;
    transcript.push({ role: "user", content: text }, { role: "assistant", content: answer });
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") reply.append(h("div", { class: "small muted" }, "Stopped"));
    else reply.append(h("div", { class: "warn small" }, `${err.name}: ${err.message}`));
    if (!answer) out.remove();
  } finally {
    cancelAnimationFrame(frame);
    if (answer) showAnswer(out, answer);
    generating = null;
    reply.classList.remove("pg-pending");
    setBusy(false);
    void pendingRaw.refresh();
  }
}

function setBusy(on: boolean) {
  busy = on;
  sendBtn.textContent = on ? "Stop" : "Send";
  sendBtn.classList.toggle("primary", !on);
  for (const el of [backendSel, systemInput, tempInput]) el.disabled = on;
}

// ---- Images -------------------------------------------------------------------

/** Long edge cap; larger images are downscaled before upload (providers resize them anyway). */
const MAX_EDGE = 1568;

const isMime = (t: string): t is ImageMime => (IMAGE_MIME_TYPES as readonly string[]).includes(t);

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function readImage(file: File): Promise<Attachment> {
  let blob: Blob = file;
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name} is not an image this browser can read`);
  });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale < 1 || !isMime(file.type)) {
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await canvas.convertToBlob({ type: file.type === "image/png" ? "image/png" : "image/jpeg", quality: 0.9 });
    if (blob.size * 1.37 > MAX_IMAGE_BASE64) blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  }
  bitmap.close();
  const data = await toBase64(blob);
  if (data.length > MAX_IMAGE_BASE64) throw new Error(`${file.name} is too large (max ~5 MB)`);
  return { mimeType: blob.type as ImageMime, data, url: URL.createObjectURL(blob), name: file.name };
}

async function addFiles(files: File[]) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;
  const room = MAX_IMAGES_PER_MESSAGE - attachments.length;
  for (const f of images.slice(0, room)) {
    try {
      attachments.push(await readImage(f));
    } catch (e) {
      flash((e as Error).message);
    }
  }
  if (images.length > room) flash(`Up to ${MAX_IMAGES_PER_MESSAGE} images per message`);
  renderTray();
}

function renderTray() {
  tray.replaceChildren(...attachments.map((a, i) => h("figure", { class: "pg-thumb" },
    h("img", { src: a.url, alt: a.name }),
    h("button", { type: "button", class: "pg-remove", "aria-label": `Remove ${a.name}`, onclick: () => {
      URL.revokeObjectURL(a.url);
      attachments.splice(i, 1);
      renderTray();
    } }, "×"))));
  tray.hidden = !attachments.length;
  const warn = attachments.length > 0 && !acceptsImages;
  tray.classList.toggle("pg-tray-warn", warn);
  if (warn) tray.append(h("p", { class: "small warn" }, "This backend reads text only; sending images will fail."));
}

// ---- Page ---------------------------------------------------------------------

async function main() {
  await Promise.all([loadBackends(), seedBuiltins()]);
  registryEvents.addEventListener("change", () => {
    toolsStale = true;
    void toolsPanel.render();
    void pendingRaw.refresh();
  });
  const form = h("form", { class: "pg-composer", onsubmit: (e) => {
    e.preventDefault();
    void submit();
  } },
    pendingRaw.panel,
    tray,
    input,
    h("div", { class: "row" }, attachBtn, fileInput, pendingRaw.toggle, note, h("span", { class: "pg-spacer" }), usage, sendBtn),
  );
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void pendingRaw.refresh(), 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // Enter never stops a reply; only the Stop button does.
      if (!busy) form.requestSubmit();
    }
  });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void addFiles(files);
    }
  });
  document.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    void addFiles([...(e.dataTransfer?.files ?? [])]);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("settings" in changes) || busy) return;
    const before = backendSel.selectedOptions[0]?.textContent;
    void loadBackends().then(() => {
      // A different backend or model invalidates the open session.
      if (backendSel.selectedOptions[0]?.textContent !== before) newChat();
      return describeBackend();
    });
  });

  app.append(
    h("header", { class: "pg-head" },
      h("div", { class: "row" },
        h("h1", {}, "Playground"),
        h("span", { class: "pg-spacer" }),
        h("a", { href: "options.html", class: "small" }, "Settings")),
      h("div", { class: "row" }, backendSel, status, h("span", { class: "pg-spacer" }), h("button", { type: "button", onclick: () => newChat() }, "New chat")),
      h("details", {},
        h("summary", { class: "small muted" }, "Session options"),
        h("div", { class: "stack", style: "margin-top:8px" },
          systemInput,
          h("label", { class: "small" }, "Temperature ", tempInput),
          h("label", { class: "small" }, markdownToggle, " Render Markdown and math in replies"),
          h("p", { class: "small muted" }, "Changing these starts a new chat. Conversations here are not tied to any website and are not saved."))),
      toolsBox),
    log,
    form,
  );
  log.append(empty);
  renderTray();
  await describeBackend();
  input.focus();
}

main().catch((e) => app.append(h("p", { class: "warn" }, String(e))));
