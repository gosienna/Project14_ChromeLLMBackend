// Browser tools for the playground, ported from Project05's MCP tools (mcp/tools/browser.js,
// mcp/tools/a11y/*). They run in the playground page, which has chrome.tabs and chrome.scripting;
// page access comes from optional permissions the user grants in the Tools panel.

type Args = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PageFn = (...args: any[]) => unknown;

const DEFAULT_TEXT_CHARS = 14000;
const DEFAULT_HTML_CHARS = 14000;
const DEFAULT_FETCH_CHARS = 12000;
const MODIFY_ELEMENT_MAX = 100;
const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;
/** Pages the tools may act on. Chrome hides the URL of tabs the extension can't access. */
const WEB_PAGE = /^(https?|file):/i;
const INJECTED_FILE = "ui/a11y-injected.js";

const num = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

function truncate(text: string, maxChars: unknown, fallback: number): string {
  const limit = num(maxChars, fallback);
  if (!text || text.length <= limit) return text || "";
  return `${text.slice(0, limit)}\n...[truncated — ${text.length.toLocaleString()} chars total, showing first ${limit.toLocaleString()}]`;
}

/**
 * The tab a tool acts on: `args.tabId`, else the most recently used web page. The playground is
 * itself a tab, so "the active tab" would be the playground; only http(s) and file pages count.
 */
export async function resolveTabId(args: Args): Promise<number> {
  if (args.tabId != null) return Number(args.tabId);
  const tabs = (await chrome.tabs.query({})).filter((t) => t.id != null && WEB_PAGE.test(t.url ?? t.pendingUrl ?? ""));
  tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const tab = tabs[0];
  if (!tab?.id) throw new Error("No web page the browser tools can access is open — open one, pass tabId, or allow page access in the Tools panel");
  return tab.id;
}

async function assertRunnable(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`Tab ${tabId} not found`);
  }
  const url = tab.url ?? tab.pendingUrl ?? "";
  if (RESTRICTED.test(url)) throw new Error(`Cannot run browser tools on restricted page: ${url}`);
}

async function runInTab<T>(args: Args, func: PageFn, fnArgs: unknown[] = [], world: "ISOLATED" | "MAIN" = "ISOLATED"): Promise<T> {
  const tabId = await resolveTabId(args);
  await assertRunnable(tabId);
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world, func, args: fnArgs });
  return res?.result as T;
}

// ---- Accessibility snapshot (Playwright MCP-style YAML refs) -----------------

interface SnapNode {
  role: string;
  name?: string;
  level?: number;
  checked?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean | "mixed";
  ref?: string;
  cursor?: string;
  box?: { x: number; y: number; width: number; height: number };
  url?: string;
  text?: string;
  children?: SnapNode[];
}

/** Snapshot generation per tab, so clicks on refs from an older snapshot are refused. */
const generations = new Map<number, number>();

export function renderSnapshotYaml(nodes: SnapNode[], options: { depth?: number; boxes?: boolean } = {}): string {
  const lines: string[] = [];
  const maxDepth = options.depth != null && options.depth >= 0 ? options.depth : undefined;
  const visit = (node: SnapNode, depth: number) => {
    if (maxDepth != null && depth > maxDepth) return;
    let key = node.role;
    if (node.name) key += ` ${JSON.stringify(node.name)}`;
    const attrs: string[] = [];
    if (node.level != null) attrs.push(`level=${node.level}`);
    if (node.checked === true) attrs.push("checked");
    else if (node.checked === "mixed") attrs.push("checked=mixed");
    if (node.disabled) attrs.push("disabled");
    if (node.expanded) attrs.push("expanded");
    if (node.selected) attrs.push("selected");
    if (node.pressed === true) attrs.push("pressed");
    else if (node.pressed === "mixed") attrs.push("pressed=mixed");
    if (node.ref) {
      attrs.push(`ref=${node.ref}`);
      if (node.cursor === "pointer") attrs.push("cursor=pointer");
    }
    if (options.boxes && node.box) attrs.push(`box=${node.box.x},${node.box.y},${node.box.width},${node.box.height}`);
    if (node.url) attrs.push(`url=${JSON.stringify(node.url)}`);
    for (const a of attrs) key += ` [${a}]`;
    lines.push(`${"  ".repeat(depth)}- ${key}`);
    for (const t of String(node.text ?? "").split("\n")) if (t.trim()) lines.push(`${"  ".repeat(depth + 1)}- text: ${JSON.stringify(t)}`);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  for (const n of nodes) visit(n, 0);
  return lines.join("\n");
}

async function ensureInjected(args: Args): Promise<number> {
  const tabId = await resolveTabId(args);
  await assertRunnable(tabId);
  await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", files: [INJECTED_FILE] });
  return tabId;
}

const refOf = (target: unknown) => (typeof target === "string" ? target.match(/^(?:f\d+)?(e\d+)$/)?.[1] : undefined);

export async function browser_snapshot(args: Args) {
  const tabId = await ensureInjected(args);
  const generation = (generations.get(tabId) ?? 0) + 1;
  generations.set(tabId, generation);
  const raw = await runInTab<{ ok: boolean; url?: string; title?: string; refCount?: number; nodes?: SnapNode[]; error?: string }>(
    { tabId },
    (opts) => (globalThis as unknown as { __llmCaptureSnapshot: (o: unknown) => unknown }).__llmCaptureSnapshot(opts),
    [{ generation, depth: args.depth, boxes: !!args.boxes, targetRef: refOf(args.target) }],
  );
  if (!raw?.ok) return raw;
  const yaml = renderSnapshotYaml(raw.nodes ?? [], { depth: args.depth as number | undefined, boxes: !!args.boxes });
  return { url: raw.url, title: raw.title, snapshot: truncate(yaml, args.maxChars, DEFAULT_TEXT_CHARS), refCount: raw.refCount, generation };
}

export async function browser_click(args: Args) {
  if (!args.target) return { ok: false, error: "target is required" };
  const tabId = await ensureInjected(args);
  return runInTab(
    { tabId },
    (opts) => (globalThis as unknown as { __llmClickByTarget: (o: unknown) => unknown }).__llmClickByTarget(opts),
    [{
      target: args.target,
      generation: refOf(args.target) ? generations.get(tabId) : undefined,
      doubleClick: !!args.doubleClick,
      button: args.button ?? "left",
      modifiers: Array.isArray(args.modifiers) ? args.modifiers : [],
    }],
  );
}

// ---- Page reading and actions -------------------------------------------------

export async function read_page(args: Args) {
  const text = await runInTab<string>(args, () => document.body?.innerText ?? "");
  return truncate(text ?? "", args.maxChars, DEFAULT_TEXT_CHARS);
}

export async function get_page_html(args: Args) {
  const raw = await runInTab<{ ok: boolean; html?: string; url?: string; error?: string }>(
    args,
    (sel: string | null) => {
      if (sel) {
        const el = document.querySelector(sel);
        return el ? { ok: true, html: el.outerHTML, url: location.href } : { ok: false, error: `No element matched "${sel}"` };
      }
      return { ok: true, html: document.documentElement.outerHTML, url: location.href };
    },
    [typeof args.selector === "string" ? args.selector : null],
  );
  if (!raw?.ok) return raw;
  const limit = num(args.maxChars, DEFAULT_HTML_CHARS);
  const html = raw.html ?? "";
  return html.length > limit
    ? { ok: true, html: html.slice(0, limit), url: raw.url, truncated: true, totalChars: html.length, shownChars: limit }
    : { ok: true, html, url: raw.url };
}

export async function get_links(args: Args) {
  return runInTab(args, () =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .slice(0, 200)
      .map((a) => ({ text: a.innerText.trim().slice(0, 120), href: a.href })),
  );
}

export async function list_tabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
}

export async function open_tab(args: Args) {
  const tab = await chrome.tabs.create({ url: String(args.url ?? ""), active: false });
  return { id: tab.id, url: tab.pendingUrl ?? tab.url };
}

export async function navigate(args: Args) {
  await chrome.tabs.update(await resolveTabId(args), { url: String(args.url ?? "") });
  return { ok: true };
}

export async function click(args: Args) {
  return runInTab(
    args,
    (sel: string) => {
      let el = document.querySelector<HTMLElement>(sel);
      el ??= Array.from(document.querySelectorAll<HTMLElement>("a, button, [role='button'], input[type=submit]")).find((n) =>
        n.innerText?.trim().toLowerCase().includes(sel.trim().toLowerCase()),
      ) ?? null;
      if (!el) return { ok: false, error: `No element matched "${sel}"` };
      el.scrollIntoView({ block: "center" });
      el.click();
      return { ok: true };
    },
    [String(args.selector ?? "")],
  );
}

export async function type_text(args: Args) {
  return runInTab(
    args,
    (sel: string, value: string) => {
      const el = document.querySelector<HTMLInputElement>(sel);
      if (!el) return { ok: false, error: `No element matched "${sel}"` };
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    },
    [String(args.selector ?? ""), String(args.text ?? "")],
  );
}

export async function scroll(args: Args) {
  return runInTab(
    args,
    (dir: string) => {
      window.scrollBy(0, dir === "up" ? -window.innerHeight * 0.9 : window.innerHeight * 0.9);
      return { ok: true, scrollY: window.scrollY };
    },
    [args.direction === "up" ? "up" : "down"],
  );
}

export async function modify_element(args: Args) {
  const { selector, styles, text, innerHTML } = args;
  if (typeof selector !== "string" || !selector) return { ok: false, error: "selector is required" };
  const style = styles && typeof styles === "object" && !Array.isArray(styles) ? styles : undefined;
  if (!style && text == null && innerHTML == null) return { ok: false, error: "Provide at least one of styles, text, or innerHTML" };
  return runInTab(
    args,
    (sel: string, edit: { styles?: Record<string, string>; text?: string; innerHTML?: string }, all: boolean, max: number) => {
      const apply = (el: HTMLElement) => {
        if (edit.styles) Object.assign(el.style, edit.styles);
        if (edit.text != null) el.textContent = String(edit.text);
        if (edit.innerHTML != null) el.innerHTML = String(edit.innerHTML);
      };
      const nodes = all ? Array.from(document.querySelectorAll<HTMLElement>(sel)).slice(0, max) : [document.querySelector<HTMLElement>(sel)].filter((n): n is HTMLElement => !!n);
      if (!nodes.length) return { ok: false, error: `No element matched "${sel}"` };
      nodes.forEach(apply);
      return { ok: true, matched: nodes.length, updated: nodes.length };
    },
    [selector, { styles: style, text: text ?? undefined, innerHTML: innerHTML ?? undefined }, !!args.all, MODIFY_ELEMENT_MAX],
  );
}

/** Runs in the page's MAIN world, where the page's own CSP decides whether eval is allowed. */
function runUserScriptInPage(source: string, callArgs: unknown[]) {
  try {
    const fn = (0, eval)(`(${source})`);
    if (typeof fn !== "function") return { __executeScriptError: "script must evaluate to a function" };
    return fn(...callArgs);
  } catch (e) {
    return { __executeScriptError: e instanceof Error ? e.message : String(e) };
  }
}

export async function execute_script(args: Args) {
  if (typeof args.script !== "string" || !args.script.trim()) throw new Error("execute_script requires a non-empty script string");
  const result = await runInTab<unknown>(args, runUserScriptInPage, [args.script, Array.isArray(args.args) ? args.args : []], "MAIN");
  if (result && typeof result === "object" && "__executeScriptError" in result) {
    throw new Error(`execute_script failed: ${(result as { __executeScriptError: string }).__executeScriptError}`);
  }
  return result;
}

export function wait(args: Args) {
  return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), Math.min(num(args.ms, 1000), 15000)));
}

export async function fetch_url(args: Args) {
  const res = await fetch(String(args.url ?? ""));
  const text = await res.text();
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(stripped, args.maxChars, DEFAULT_FETCH_CHARS);
}

/** Save a remote file to Downloads (chrome.downloads), and wait for it to finish. */
export async function download_file(args: Args) {
  let url: URL;
  try {
    url = new URL(String(args.url ?? ""));
  } catch {
    return { ok: false, error: `Invalid URL: ${args.url}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Only http/https URLs are supported" };
  const id = await chrome.downloads.download({
    url: url.href,
    saveAs: !!args.saveAs,
    conflictAction: "uniquify",
    ...(typeof args.filename === "string" && args.filename.trim() ? { filename: args.filename.trim() } : {}),
  });
  const timeout = Math.min(Math.max(Number(args.timeoutMs) || 120000, 5000), 300000);
  return new Promise((resolve) => {
    const finish = (r: unknown) => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(r);
    };
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (item?.state === "complete") finish({ ok: true, downloadId: id, filename: item.filename, url: item.url, fileSize: item.fileSize });
      else if (item?.state === "interrupted") finish({ ok: false, downloadId: id, error: item.error ?? "Download interrupted" });
    };
    const onChanged = (d: chrome.downloads.DownloadDelta) => {
      if (d.id === id && d.state?.current) void check();
    };
    const timer = setTimeout(() => finish({ ok: false, downloadId: id, error: "Download timed out" }), timeout);
    chrome.downloads.onChanged.addListener(onChanged);
    void check();
  });
}
