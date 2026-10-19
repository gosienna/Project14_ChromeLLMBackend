// Tiny DOM helpers for the extension's UI pages.

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<Node | string | null | false>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" && "value" in el) (el as HTMLInputElement).value = String(v);
    else if (k === "checked") (el as HTMLInputElement).checked = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== false) el.append(c);
  return el;
}

export async function send<T = unknown>(msg: object): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; value?: T; error?: string } | undefined;
  if (!res) throw new Error("No response from the extension");
  if (!res.ok) throw new Error(res.error);
  return res.value as T;
}

export function fmtTime(t: number): string {
  return new Date(t).toLocaleString();
}

export function fmtMB(bytes: number): string {
  return `${(bytes / 2 ** 20).toFixed(0)} MB`;
}
