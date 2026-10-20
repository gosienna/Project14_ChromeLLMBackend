// Collapsible JSON tree for the playground's raw request/response views. Ported from
// Project05's modes/dialogue/raw-json-view.js: chat messages get a role badge, and bulky keys
// (reasoning, raw stream events) start collapsed.

import { h } from "./dom";

export interface TreeOptions {
  /** Levels expanded at first (default 2). */
  expandDepth?: number;
  /** Keys whose values start collapsed regardless of depth. */
  collapsedKeys?: string[];
}

const DEFAULT_COLLAPSED = ["reasoning", "reasoning_content", "thinking", "events"];

export function mountJsonTree(container: HTMLElement, data: unknown, options: TreeOptions = {}): void {
  const ctx = { expandDepth: options.expandDepth ?? 2, collapsed: new Set(options.collapsedKeys ?? DEFAULT_COLLAPSED) };
  container.replaceChildren(node(data, "", 0, true, ctx));
}

interface Ctx {
  expandDepth: number;
  collapsed: Set<string>;
}

function node(value: unknown, key: string, depth: number, root: boolean, ctx: Ctx): HTMLElement {
  if (value === null || typeof value !== "object") return leaf(key, value, root);
  const isArray = Array.isArray(value);
  const entries = isArray ? (value as unknown[]).map((v, i) => [`[${i}]`, v] as const) : Object.entries(value as Record<string, unknown>);
  const role = !isArray && typeof (value as { role?: unknown }).role === "string" ? (value as { role: string }).role : null;
  const collapsed = (!root && ctx.collapsed.has(key)) || depth >= ctx.expandDepth;
  const summary = isArray ? `[${entries.length}]` : `{${entries.length} keys}`;
  const chevron = h("span", { class: "jt-chevron" }, collapsed ? "▸" : "▾");
  const preview = h("span", { class: "jt-preview" }, collapsed ? summary : isArray ? "[" : "{");
  const el = h("div", { class: `jt-node${collapsed ? " collapsed" : ""}`, ...(role ? { "data-role": role } : {}) });
  const row = h("div", { class: "jt-row", role: "button", tabindex: 0 },
    chevron,
    root ? "" : h("span", { class: "jt-key" }, `${key}: `),
    ...(role ? [h("span", { class: `jt-role jt-role-${role}` }, role)] : [preview]));
  const toggle = (e: Event) => {
    e.stopPropagation();
    const now = el.classList.toggle("collapsed");
    chevron.textContent = now ? "▸" : "▾";
    preview.textContent = now ? summary : isArray ? "[" : "{";
  };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") toggle(e);
  });
  el.append(row, h("div", { class: "jt-children" }, ...entries.map(([k, v]) => node(v, k, depth + 1, false, ctx))));
  return el;
}

function leaf(key: string, value: unknown, root: boolean): HTMLElement {
  const text = value === undefined ? "undefined" : JSON.stringify(value);
  const block = typeof value === "string" && (value.includes("\n") || value.length > 120);
  return h("div", { class: "jt-leaf" },
    root ? "" : h("span", { class: "jt-key" }, `${key}: `),
    h("span", { class: `jt-value jt-${value === null ? "null" : typeof value}${block ? " jt-block" : ""}` }, block ? (value as string) : text));
}
