// Raw views for the playground, following Project05's Dialogue mode: each reply's Raw panel shows
// every generation round's exact request, rendered prompt and response; the composer's panel shows
// the pending request as a tree or as editable JSON that the next Send uses.

import { h } from "../dom";
import { mountJsonTree } from "../json-tree";
import { parsePayload, serializePayload, type Payload } from "./payload";

export interface TraceEntry {
  round: number;
  trace: { engine: string; request: unknown; prompt?: string; response?: unknown };
}

/** The Raw toggle and panel under one reply. Traces arrive as rounds finish. */
export function replyRaw(): { toggle: HTMLButtonElement; panel: HTMLElement; add(t: TraceEntry): void } {
  const traces: TraceEntry[] = [];
  let selected = 0;
  const tabs = h("div", { class: "pg-raw-tabs", role: "tablist" });
  const body = h("div", { class: "pg-raw-body" });
  const panel = h("div", { class: "pg-raw", hidden: true }, tabs, body);
  const toggle = h("button", { type: "button", class: "pg-link small", hidden: true, "aria-expanded": "false", onclick: () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    toggle.textContent = panel.hidden ? "Raw" : "Hide raw";
    if (!panel.hidden) render();
  } }, "Raw");

  function section(title: string, content: Node) {
    return h("section", { class: "pg-raw-section" }, h("h4", { class: "small muted" }, title), content);
  }

  function render() {
    tabs.replaceChildren(...traces.map((t, i) => h("button", {
      type: "button",
      role: "tab",
      class: `pg-raw-tab${i === selected ? " active" : ""}`,
      "aria-selected": String(i === selected),
      onclick: () => {
        selected = i;
        render();
      },
    }, traces.length > 1 ? `Round ${t.round + 1}` : "Generation")));
    tabs.hidden = traces.length < 2;
    const t = traces[selected];
    if (!t) return body.replaceChildren();
    const request = h("div", { class: "pg-tree" });
    const response = h("div", { class: "pg-tree" });
    mountJsonTree(request, t.trace.request, { expandDepth: 3 });
    mountJsonTree(response, t.trace.response ?? null);
    body.replaceChildren(
      h("p", { class: "small muted" }, `Sent to ${t.trace.engine}`),
      section("Request", request),
      ...(t.trace.prompt ? [section("Rendered prompt", h("pre", { class: "pg-prompt" }, t.trace.prompt))] : []),
      section("Response", response),
    );
  }

  return {
    toggle,
    panel,
    add(t) {
      traces.push(t);
      toggle.hidden = false;
      if (!panel.hidden) render();
    },
  };
}

/** The composer's raw panel: pending request as a tree, or edited JSON used on the next Send. */
export class PendingRaw {
  readonly toggle: HTMLButtonElement;
  readonly panel: HTMLElement;
  private tree = h("div", { class: "pg-tree" });
  private editor = h("textarea", { class: "pg-json-edit", rows: 14, spellcheck: false, "aria-label": "Request JSON", hidden: true });
  private status = h("span", { class: "small", role: "status" });
  private editBtn = h("button", { type: "button" }, "Edit JSON");
  private applyBtn = h("button", { type: "button", class: "primary", hidden: true }, "Apply");
  private cancelBtn = h("button", { type: "button", hidden: true }, "Cancel");
  private editing = false;
  private dirty = false;
  /** An applied edit, used by the next Send. */
  override: Payload | null = null;

  constructor(private pending: () => Promise<Payload>, private knownTools: () => Promise<Set<string>>) {
    this.panel = h("div", { class: "pg-raw pg-pending-raw", hidden: true },
      h("div", { class: "row" },
        h("strong", { class: "small" }, "Next request"),
        this.status,
        h("span", { class: "pg-spacer" }),
        this.editBtn, this.applyBtn, this.cancelBtn),
      h("p", { class: "small muted" }, "Messages and tools as the backend receives them; each reply's Raw view shows the exact engine or provider payload."),
      this.tree,
      this.editor);
    this.toggle = h("button", { type: "button", "aria-expanded": "false", onclick: () => {
      this.panel.hidden = !this.panel.hidden;
      this.toggle.setAttribute("aria-expanded", String(!this.panel.hidden));
      this.toggle.textContent = this.panel.hidden ? "Show raw" : "Hide raw";
      void this.refresh();
    } }, "Show raw");
    this.editBtn.onclick = () => void this.setEditing(!this.editing);
    this.applyBtn.onclick = () => void this.apply();
    this.cancelBtn.onclick = () => this.clearOverride();
    this.editor.oninput = () => {
      this.dirty = true;
      if (this.status.classList.contains("warn-text")) this.setStatus("");
    };
  }

  private setStatus(text: string, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle("warn-text", error);
  }

  private async setEditing(on: boolean) {
    this.editing = on;
    this.editor.hidden = !on;
    this.tree.hidden = on;
    this.applyBtn.hidden = this.cancelBtn.hidden = !on;
    this.editBtn.textContent = on ? "Tree view" : "Edit JSON";
    if (on && !this.dirty) {
      const payload = this.override ?? (await this.pending());
      // Typing may have started while the payload was being built; never overwrite it.
      if (!this.dirty) this.editor.value = serializePayload(payload);
    }
    if (on) this.editor.focus();
    else await this.refresh();
  }

  /** Re-render from the current conversation, unless an edit is in progress or applied. */
  async refresh() {
    if (this.panel.hidden) return;
    const payload = this.override ?? (await this.pending());
    if (this.editing) {
      if (!this.dirty && document.activeElement !== this.editor) this.editor.value = serializePayload(payload);
      return;
    }
    mountJsonTree(this.tree, payload, { expandDepth: 3 });
  }

  private async apply() {
    const parsed = parsePayload(this.editor.value, await this.knownTools());
    if ("error" in parsed) return this.setStatus(parsed.error, true);
    this.override = parsed.payload;
    this.dirty = false;
    this.setStatus("Custom request — used on Send");
    await this.setEditing(false);
  }

  /** Drop an applied or in-progress edit (also after the edited request was sent). */
  clearOverride() {
    this.override = null;
    this.dirty = false;
    this.setStatus("");
    void this.setEditing(false);
  }
}
