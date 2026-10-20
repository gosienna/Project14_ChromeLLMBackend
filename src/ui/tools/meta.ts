// Registry tools: let the model list, load, create, edit and delete tools in the registry.
// Same validation as the Tools panel; built-ins can be edited or disabled but not deleted.

import type { ToolContext } from "./builtin";
import { deleteTool, getTool, listTools, saveTool, type ToolRecord } from "./registry";

type Args = Record<string, unknown>;

const NEXT_CHAT = "It can be used from the next chat.";
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const schema = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

async function load(name: unknown): Promise<ToolRecord> {
  const rec = await getTool(String(name ?? ""));
  if (!rec) throw new Error(`No tool named "${name}"`);
  return rec;
}

export const registryTools: ToolContext["registry"] = {
  async list(args: Args) {
    const tools = await listTools();
    return tools
      .filter((t) => !args.group || t.group === args.group)
      .map(({ name, description, kind, group, enabled }) => ({ name, description, kind, group, enabled }));
  },

  async get(args: Args) {
    const { name, description, inputSchema, kind, group, enabled, confirm, code } = await load(args.name);
    return { name, description, inputSchema, kind, group, enabled, askBeforeRunning: confirm, ...(code ? { code } : {}) };
  },

  async create(args: Args) {
    const rec: ToolRecord = {
      name: String(args.name ?? ""),
      description: String(args.description ?? ""),
      inputSchema: schema(args.inputSchema) ?? { type: "object", properties: {} },
      kind: "custom",
      group: "custom",
      enabled: true,
      // Model-written code always asks before it runs.
      confirm: true,
      code: String(args.code ?? ""),
      updatedAt: 0,
    };
    await saveTool(rec, true);
    return { ok: true, name: rec.name, note: `Saved. ${NEXT_CHAT}` };
  },

  async update(args: Args) {
    const rec = await load(args.name);
    const next: ToolRecord = { ...rec };
    if (str(args.description) !== undefined) next.description = str(args.description)!;
    if (schema(args.inputSchema)) next.inputSchema = schema(args.inputSchema)!;
    if (typeof args.enabled === "boolean") next.enabled = args.enabled;
    if (rec.kind === "custom") {
      if (str(args.code) !== undefined) next.code = str(args.code);
      // Changed code asks again before it runs.
      if (next.code !== rec.code) next.confirm = true;
    } else {
      if (args.code !== undefined) throw new Error(`"${rec.name}" is built in; its code can't be changed`);
      if (next.description !== rec.description || next.inputSchema !== rec.inputSchema) next.edited = true;
    }
    await saveTool(next);
    return { ok: true, name: rec.name, note: `Updated. ${NEXT_CHAT}` };
  },

  async remove(args: Args) {
    await deleteTool(String(args.name ?? ""));
    return { ok: true, name: args.name, note: "Deleted." };
  },
};
