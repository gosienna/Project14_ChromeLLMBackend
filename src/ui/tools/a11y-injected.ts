// Injected into a page's isolated world by the browser tools (chrome.scripting files) for
// accessibility snapshots and ref-based clicks. Ported from Project05's mcp/tools/a11y/injected.js.

interface A11yNode {
  role: string;
  name: string;
  children: A11yNode[];
  level?: number;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  url?: string;
  ref?: string;
  cursor?: string;
  box?: { x: number; y: number; width: number; height: number };
}

interface SnapshotOptions {
  generation?: number;
  depth?: number;
  boxes?: boolean;
  targetRef?: string;
}

(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.__llmA11yInjected) return;
  g.__llmA11yInjected = true;

  const REF_ATTR = "data-llm-ref";
  const GEN_ATTR = "data-llm-gen";
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "checkbox", "radio", "combobox", "listbox", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "searchbox", "slider", "spinbutton", "switch", "tab", "treeitem",
  ]);
  const STRUCTURE_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "LABEL", "LI", "OPTION"]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "IFRAME"]);

  function isHidden(el: Element): boolean {
    if (el.closest("[aria-hidden=true]") || el.hasAttribute("hidden")) return true;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return true;
    const rect = el.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0;
  }

  function implicitRole(el: Element): string | null {
    const tag = el.tagName;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (tag === "A" && el.hasAttribute("href")) return "link";
    if (tag === "BUTTON") return "button";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return "combobox";
    if (tag === "OPTION") return "option";
    if (tag === "INPUT") {
      const map: Record<string, string> = {
        button: "button", submit: "button", reset: "button", checkbox: "checkbox", radio: "radio", email: "textbox",
        number: "spinbutton", password: "textbox", search: "searchbox", tel: "textbox", text: "textbox", url: "textbox", range: "slider",
      };
      return map[type] ?? "textbox";
    }
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "LI") return "listitem";
    if (tag === "LABEL") return "label";
    return null;
  }

  const getRole = (el: Element) => el.getAttribute("role")?.toLowerCase().split(/\s+/)[0] ?? implicitRole(el);

  function accessibleName(el: HTMLElement): string {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText?.trim() ?? "").filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.id) {
      const label = document.querySelector<HTMLElement>(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return (label.innerText || label.textContent || "").trim();
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    if (el instanceof HTMLInputElement && el.value && ["submit", "button", "reset"].includes(el.type)) return el.value.trim();
    return (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
  }

  function interactable(el: HTMLElement, role: string): boolean {
    if (INTERACTIVE_ROLES.has(role)) return true;
    const tag = el.tagName;
    if ((tag === "A" && el.hasAttribute("href")) || ["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(tag)) return true;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex != null && tabindex !== "-1") return true;
    return getComputedStyle(el).cursor === "pointer";
  }

  function build(el: HTMLElement, refs: { n: number }, options: SnapshotOptions, depth: number, maxDepth: number): A11yNode | null {
    if (depth > maxDepth || SKIP_TAGS.has(el.tagName) || isHidden(el)) return null;
    const role = getRole(el);
    const hasRole = role || STRUCTURE_TAGS.has(el.tagName) || el.hasAttribute("aria-label");
    if (!hasRole && !el.querySelector("a,button,input,textarea,select,[role]")) {
      const children = [...el.children].map((c) => build(c as HTMLElement, refs, options, depth, maxDepth)).filter((n): n is A11yNode => !!n);
      if (!children.length) return null;
      return children.length === 1 ? children[0] : { role: "generic", name: "", children };
    }
    const node: A11yNode = { role: role ?? "generic", name: accessibleName(el), children: [] };
    if (role === "heading") node.level = Number(el.tagName.match(/^H(\d)$/)?.[1]) || undefined;
    if (el.hasAttribute("aria-disabled") || (el as HTMLButtonElement).disabled) node.disabled = true;
    if (el.getAttribute("aria-expanded") === "true") node.expanded = true;
    if (el.getAttribute("aria-selected") === "true") node.selected = true;
    if (el.getAttribute("aria-checked") === "mixed") node.checked = "mixed";
    else if (el.getAttribute("aria-checked") === "true" || (el instanceof HTMLInputElement && el.checked)) node.checked = true;
    if (el.getAttribute("aria-pressed") === "mixed") node.pressed = "mixed";
    else if (el.getAttribute("aria-pressed") === "true") node.pressed = true;
    if (role === "link" && el instanceof HTMLAnchorElement) node.url = el.href;
    if (interactable(el, node.role)) {
      node.ref = `e${++refs.n}`;
      el.setAttribute(REF_ATTR, node.ref);
      if (getComputedStyle(el).cursor === "pointer") node.cursor = "pointer";
    }
    if (options.boxes) {
      const r = el.getBoundingClientRect();
      node.box = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    }
    for (const c of el.children) {
      const n = build(c as HTMLElement, refs, options, depth + 1, maxDepth);
      if (n) node.children.push(n);
    }
    if (!node.name && !node.ref && !node.children.length) return null;
    if (node.role === "generic" && !node.name && node.children.length === 1) return node.children[0];
    return node;
  }

  g.__llmCaptureSnapshot = (options: SnapshotOptions = {}) => {
    const maxDepth = options.depth != null && options.depth >= 0 ? options.depth : 50;
    const root = options.targetRef ? document.querySelector<HTMLElement>(`[${REF_ATTR}="${options.targetRef}"]`) : document.body;
    if (!root) return { ok: false, error: options.targetRef ? `Ref ${options.targetRef} not found — capture a new browser_snapshot` : "Page has no body" };
    const scope: ParentNode = options.targetRef ? root : document;
    if (options.targetRef) root.removeAttribute(REF_ATTR);
    scope.querySelectorAll(`[${REF_ATTR}]`).forEach((el) => el.removeAttribute(REF_ATTR));
    document.documentElement.setAttribute(GEN_ATTR, String(options.generation ?? 0));
    const refs = { n: 0 };
    const nodes = options.targetRef
      ? [build(root, refs, options, 0, maxDepth)].filter(Boolean)
      : [...root.children].map((c) => build(c as HTMLElement, refs, options, 0, maxDepth)).filter(Boolean);
    return { ok: true, url: location.href, title: document.title, generation: options.generation ?? 0, refCount: refs.n, nodes };
  };

  const MODIFIERS: Record<string, { key: string; code: string; keyCode: number }> = {
    Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
    Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
    Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
    Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  };
  const BUTTONS: Record<string, number> = { left: 0, middle: 1, right: 2 };

  g.__llmClickByTarget = (o: { target?: string; generation?: number; doubleClick?: boolean; button?: string; modifiers?: string[] } = {}) => {
    if (!o.target) return { ok: false, error: "target is required" };
    let el: HTMLElement | null;
    const ref = String(o.target).match(/^(?:f\d+)?(e\d+)$/)?.[1];
    if (ref) {
      if (o.generation != null && document.documentElement.getAttribute(GEN_ATTR) !== String(o.generation)) {
        return { ok: false, error: `Ref ${ref} is stale — capture a new browser_snapshot` };
      }
      el = document.querySelector<HTMLElement>(`[${REF_ATTR}="${ref}"]`);
      if (!el) return { ok: false, error: `Ref ${ref} not found — capture a new browser_snapshot` };
    } else {
      try {
        el = document.querySelector<HTMLElement>(o.target);
      } catch {
        return { ok: false, error: `Invalid selector "${o.target}"` };
      }
      if (!el) return { ok: false, error: `No element matched "${o.target}"` };
    }
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const mods = (o.modifiers ?? []).map((m) => MODIFIERS[m]).filter(Boolean);
    const key = (type: string, m: (typeof mods)[number]) => el!.dispatchEvent(new KeyboardEvent(type, { ...m, bubbles: true, cancelable: true }));
    for (const m of mods) key("keydown", m);
    if (o.doubleClick) el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, button: BUTTONS[o.button ?? "left"] ?? 0, view: window }));
    else el.click();
    for (const m of [...mods].reverse()) key("keyup", m);
    return { ok: true };
  };
})();
