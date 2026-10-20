// The playground's Tools panel: the registry's built-in and custom tools, grouped, with enable
// and "ask before running" switches, an editor (form or JSON Schema, plus code for custom tools),
// and Add / Delete / Reset. Enabling a tool requests the optional permissions it needs.

import { MAX_TOOLS } from "../../shared/protocol";
import { h } from "../dom";
import { findBuiltin, type ToolGroup } from "../tools/builtin";
import { deleteTool, listTools, resetTool, saveTool, type ToolRecord } from "../tools/registry";
import { emptyRow, PARAM_TYPES, rowsToSchema, schemaToRows, type ParamRow } from "../tools/schema-form";

const GROUPS: Array<{ id: ToolGroup; label: string; hint: string }> = [
  { id: "web", label: "Web", hint: "Needs a Tavily API key (options → Tools)." },
  { id: "browser", label: "Browser", hint: "Acts on your open tabs. Enabling asks Chrome for access to pages." },
  { id: "registry", label: "Tool registry", hint: "Lets the model list, create, edit and delete tools here." },
  { id: "custom", label: "Your tools", hint: "Code runs in a sandbox without extension or page access; api.callTool() reaches other enabled tools." },
];

const NEW_TOOL_CODE = "// args: the arguments object. api.callTool(name, args) runs another enabled tool.\nreturn { echo: args };";

/** Permissions the tools need, merged. */
function needsOf(tools: ToolRecord[]): chrome.permissions.Permissions {
  const permissions = new Set<chrome.runtime.ManifestPermission>();
  const origins = new Set<string>();
  for (const t of tools) {
    const n = findBuiltin(t.name)?.needs;
    n?.permissions?.forEach((p) => permissions.add(p));
    n?.origins?.forEach((o) => origins.add(o));
  }
  return { permissions: [...permissions], origins: [...origins] };
}

/** Ask for what enabling `tools` needs; must run inside the click that enables them. */
async function grant(tools: ToolRecord[]): Promise<boolean> {
  const needs = needsOf(tools);
  if (!needs.permissions?.length && !needs.origins?.length) return true;
  if (await chrome.permissions.contains(needs)) return true;
  return chrome.permissions.request(needs);
}

export class ToolsPanel {
  readonly element = h("div", { class: "pg-tools stack" });
  private note = h("p", { class: "small", role: "status" });
  private editing: string | null = null;

  constructor() {
    void this.render();
  }

  private flash(text: string) {
    this.note.textContent = text;
  }

  async render() {
    const tools = await listTools();
    const enabled = tools.filter((t) => t.enabled).length;
    this.element.replaceChildren(
      h("div", { class: "row" },
        h("strong", {}, `Tools · ${enabled} enabled`),
        h("span", { class: "pg-spacer" }),
        h("button", { type: "button", onclick: () => this.addTool() }, "Add tool")),
      enabled > MAX_TOOLS ? h("p", { class: "small warn-text" }, `Only the first ${MAX_TOOLS} enabled tools are offered to the model.`) : "",
      this.note,
      ...(this.editing === "" ? [this.editor(null)] : []),
      ...GROUPS.map((g) => this.group(g, tools.filter((t) => t.group === g.id))),
    );
  }

  private group(g: (typeof GROUPS)[number], tools: ToolRecord[]) {
    const setAll = async (on: boolean) => {
      if (on && !(await grant(tools))) return this.flash("Chrome didn't grant the access these tools need.");
      for (const t of tools) if (t.enabled !== on) await saveTool({ ...t, enabled: on });
    };
    return h("section", { class: "pg-tool-group" },
      h("div", { class: "row" },
        h("h3", {}, g.label),
        h("span", { class: "small muted" }, `${tools.filter((t) => t.enabled).length}/${tools.length}`),
        h("span", { class: "pg-spacer" }),
        tools.length ? h("button", { type: "button", class: "pg-link small", onclick: () => void setAll(true) }, "Enable all") : "",
        tools.length ? h("button", { type: "button", class: "pg-link small", onclick: () => void setAll(false) }, "Disable all") : ""),
      h("p", { class: "small muted" }, g.hint),
      tools.length ? h("ul", { class: "pg-tool-list" }, ...tools.sort((a, b) => a.name.localeCompare(b.name)).map((t) => this.row(t))) : h("p", { class: "small muted" }, "None yet."),
    );
  }

  private row(t: ToolRecord) {
    const enabled = h("input", { type: "checkbox", checked: t.enabled, "aria-label": `Enable ${t.name}`, onchange: async () => {
      if (enabled.checked && !(await grant([t]))) {
        enabled.checked = false;
        return this.flash(`Chrome didn't grant the access ${t.name} needs.`);
      }
      await saveTool({ ...t, enabled: enabled.checked });
    } });
    const confirm = h("input", { type: "checkbox", checked: t.confirm, onchange: () => void saveTool({ ...t, confirm: confirm.checked }) });
    return h("li", { class: "pg-tool" },
      h("div", { class: "row" },
        enabled,
        h("code", {}, t.name),
        t.edited ? h("span", { class: "small muted" }, "edited") : "",
        h("span", { class: "pg-spacer" }),
        h("label", { class: "small" }, confirm, " Ask first"),
        h("button", { type: "button", class: "pg-link small", onclick: () => {
          this.editing = this.editing === t.name ? null : t.name;
          void this.render();
        } }, this.editing === t.name ? "Close" : "Edit")),
      h("p", { class: "small muted pg-tool-desc" }, t.description),
      this.editing === t.name ? this.editor(t) : "");
  }

  private addTool() {
    this.editing = "";
    void this.render();
  }

  /** Edit form for `t`, or for a new custom tool when null. */
  private editor(t: ToolRecord | null): HTMLElement {
    const isNew = !t;
    const custom = isNew || t.kind === "custom";
    const schema = t?.inputSchema ?? { type: "object", properties: {} };
    let rows: ParamRow[] | null = schemaToRows(schema);
    let jsonMode = rows === null;
    const name = h("input", { value: t?.name ?? "", placeholder: "tool_name", disabled: !custom || !isNew, "aria-label": "Tool name" });
    const description = h("textarea", { rows: 3, "aria-label": "Description", placeholder: "What the tool does, for the model" });
    description.value = t?.description ?? "";
    const code = h("textarea", { rows: 8, class: "pg-code", spellcheck: false, "aria-label": "Code" });
    code.value = t?.code ?? NEW_TOOL_CODE;
    const schemaText = h("textarea", { rows: 8, class: "pg-code", spellcheck: false, "aria-label": "Input schema JSON" });
    const params = h("div", { class: "stack" });
    const error = h("p", { class: "small warn-text", role: "alert" });

    const renderParams = () => {
      if (jsonMode || !rows) {
        params.replaceChildren(schemaText);
        return;
      }
      params.replaceChildren(
        ...rows.map((r, i) => h("div", { class: "row pg-param" },
          h("input", { value: r.name, placeholder: "name", "aria-label": "Parameter name", oninput: (e) => (r.name = (e.target as HTMLInputElement).value) }),
          h("select", { "aria-label": "Type", onchange: (e) => (r.type = (e.target as HTMLSelectElement).value as ParamRow["type"]) },
            ...PARAM_TYPES.map((p) => h("option", { value: p, selected: p === r.type }, p))),
          h("input", { value: r.description, placeholder: "description", "aria-label": "Parameter description", oninput: (e) => (r.description = (e.target as HTMLInputElement).value) }),
          h("input", { value: r.enumValues, placeholder: "allowed values, comma-separated", "aria-label": "Allowed values", oninput: (e) => (r.enumValues = (e.target as HTMLInputElement).value) }),
          h("label", { class: "small" }, h("input", { type: "checkbox", checked: r.required, onchange: (e) => (r.required = (e.target as HTMLInputElement).checked) }), " required"),
          h("button", { type: "button", class: "pg-link small", "aria-label": "Remove parameter", onclick: () => {
            rows!.splice(i, 1);
            renderParams();
          } }, "×"))),
        h("button", { type: "button", class: "pg-link small", onclick: () => {
          rows!.push(emptyRow());
          renderParams();
        } }, "Add parameter"));
    };
    schemaText.value = JSON.stringify(schema, null, 2);
    renderParams();

    const modeBtn = h("button", { type: "button", class: "pg-link small", onclick: () => {
      if (jsonMode) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(schemaText.value);
        } catch (e) {
          error.textContent = `Invalid JSON: ${(e as Error).message}`;
          return;
        }
        const r = schemaToRows(parsed as Record<string, unknown>);
        if (!r) {
          error.textContent = "This schema is too rich for the form; keep editing it as JSON.";
          return;
        }
        rows = r;
      } else {
        schemaText.value = JSON.stringify(rowsToSchema(rows ?? []), null, 2);
      }
      jsonMode = !jsonMode;
      error.textContent = "";
      modeBtn.textContent = jsonMode ? "Edit as form" : "Edit as JSON Schema";
      renderParams();
    } }, jsonMode ? "Edit as form" : "Edit as JSON Schema");

    const save = async () => {
      let inputSchema: Record<string, unknown>;
      if (jsonMode) {
        try {
          inputSchema = JSON.parse(schemaText.value);
        } catch (e) {
          error.textContent = `Invalid schema JSON: ${(e as Error).message}`;
          return;
        }
      } else inputSchema = rowsToSchema(rows ?? []);
      const base: ToolRecord = t ?? { name: "", description: "", inputSchema, kind: "custom", group: "custom", enabled: true, confirm: true, updatedAt: 0 };
      const rec: ToolRecord = {
        ...base,
        name: isNew ? name.value.trim() : base.name,
        description: description.value,
        inputSchema,
        ...(custom ? { code: code.value } : {}),
      };
      if (!custom && (rec.description !== base.description || JSON.stringify(inputSchema) !== JSON.stringify(base.inputSchema))) rec.edited = true;
      // Edited code asks before it runs again.
      if (custom && !isNew && rec.code !== base.code) rec.confirm = true;
      try {
        await saveTool(rec, isNew);
        this.editing = null;
        this.flash(`Saved ${rec.name}. Changes apply from your next message.`);
        void this.render();
      } catch (e) {
        error.textContent = (e as Error).message;
      }
    };

    return h("div", { class: "pg-tool-editor stack" },
      custom ? h("label", { class: "small" }, "Name ", name) : "",
      h("label", { class: "small stack" }, "Description", description),
      h("div", { class: "row" }, h("span", { class: "small" }, "Parameters"), h("span", { class: "pg-spacer" }), modeBtn),
      params,
      custom ? h("label", { class: "small stack" }, "Code (async function body with args and api)", code) : "",
      error,
      h("div", { class: "row" },
        h("button", { type: "button", class: "primary", onclick: () => void save() }, isNew ? "Create" : "Save"),
        h("button", { type: "button", onclick: () => {
          this.editing = null;
          void this.render();
        } }, "Cancel"),
        h("span", { class: "pg-spacer" }),
        t?.kind === "builtin" ? h("button", { type: "button", onclick: async () => {
          await resetTool(t.name);
          this.editing = null;
          this.flash(`Reset ${t.name} to its default.`);
        } }, "Reset to default") : "",
        t?.kind === "custom" ? h("button", { type: "button", class: "danger", onclick: async () => {
          await deleteTool(t.name);
          this.editing = null;
          this.flash(`Deleted ${t.name}.`);
        } }, "Delete") : ""),
    );
  }
}
