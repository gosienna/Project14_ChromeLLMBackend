// The playground's tool registry in IndexedDB: the extension's built-in tools, seeded as defaults,
// and tools the user (or the model, through the registry tools) creates. Built-in implementations
// live in code (builtin.ts); a stored record holds what can be edited: description, schema,
// enabled and "ask before running".

import { MAX_TOOLS, TOOL_NAME, type ToolDecl } from "../../shared/protocol";
import { BUILTIN_TOOLS, findBuiltin, type ToolGroup } from "./builtin";

const DB_NAME = "local-llm-tools";
const STORE = "tools";
const MAX_DESCRIPTION = 4096;
const MAX_SCHEMA = 65_536;
const MAX_CODE = 65_536;

export interface ToolRecord {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: "builtin" | "custom";
  group: ToolGroup;
  enabled: boolean;
  /** Ask the user before each run. */
  confirm: boolean;
  /** Custom tools: async function body run in the sandbox with `args` and `api`. */
  code?: string;
  /** A built-in whose description or schema the user changed; not refreshed from code. */
  edited?: boolean;
  updatedAt: number;
}

/** Fires "change" whenever the registry is written, so the Tools panel and session can update. */
export const registryEvents = new EventTarget();
const changed = () => registryEvents.dispatchEvent(new Event("change"));

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "name" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  }));
}

function request<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        let value: T;
        if (req) req.onsuccess = () => (value = req.result);
        tx.oncomplete = () => resolve(value);
        tx.onerror = tx.onabort = () => reject(tx.error);
      }),
  );
}

const fromBuiltin = (b: (typeof BUILTIN_TOOLS)[number], prev?: ToolRecord): ToolRecord => ({
  name: b.name,
  description: prev?.edited ? prev.description : b.description,
  inputSchema: prev?.edited ? prev.inputSchema : b.inputSchema,
  kind: "builtin",
  group: b.group,
  // Built-ins start disabled: browser tools need permissions, web search needs a key.
  enabled: prev?.enabled ?? false,
  confirm: prev?.confirm ?? b.confirm,
  ...(prev?.edited ? { edited: true } : {}),
  updatedAt: prev?.updatedAt ?? Date.now(),
});

/** Add built-ins that are missing and refresh unedited ones from code. Idempotent. */
export async function seedBuiltins(): Promise<void> {
  const existing = new Map((await listTools()).map((t) => [t.name, t]));
  const records = BUILTIN_TOOLS.map((b) => fromBuiltin(b, existing.get(b.name)));
  await request("readwrite", (s) => {
    for (const r of records) s.put(r);
  });
  changed();
}

export async function listTools(): Promise<ToolRecord[]> {
  const all = await request<ToolRecord[]>("readonly", (s) => s.getAll());
  return all ?? [];
}

export async function getTool(name: string): Promise<ToolRecord | undefined> {
  return request<ToolRecord | undefined>("readonly", (s) => s.get(name));
}

/** A reason `rec` is invalid, or null. `isNew` refuses names already taken. */
export async function validateTool(rec: Partial<ToolRecord>, isNew: boolean): Promise<string | null> {
  if (typeof rec.name !== "string" || !TOOL_NAME.test(rec.name)) return "Name must be letters, digits, _ or - (max 64), starting with a letter or _";
  if (typeof rec.description !== "string" || rec.description.length > MAX_DESCRIPTION) return `Description must be text of at most ${MAX_DESCRIPTION} characters`;
  if (!rec.inputSchema || typeof rec.inputSchema !== "object" || Array.isArray(rec.inputSchema)) return "inputSchema must be a JSON Schema object";
  if (JSON.stringify(rec.inputSchema).length > MAX_SCHEMA) return "inputSchema is too large (max 64 KB)";
  if (rec.kind === "custom" && (typeof rec.code !== "string" || !rec.code.trim() || rec.code.length > MAX_CODE)) return "Custom tools need code (max 64 KB)";
  if (isNew) {
    if (findBuiltin(rec.name)) return `"${rec.name}" is a built-in tool name`;
    if (await getTool(rec.name)) return `A tool named "${rec.name}" already exists`;
    if ((await listTools()).length >= 200) return "The registry is full (200 tools)";
  }
  return null;
}

/** Save a tool, refusing invalid ones. Returns the stored record. */
export async function saveTool(rec: ToolRecord, isNew = false): Promise<ToolRecord> {
  const error = await validateTool(rec, isNew);
  if (error) throw new Error(error);
  const stored = { ...rec, updatedAt: Date.now() };
  await request("readwrite", (s) => s.put(stored));
  changed();
  return stored;
}

export async function deleteTool(name: string): Promise<void> {
  const rec = await getTool(name);
  if (!rec) throw new Error(`No tool named "${name}"`);
  if (rec.kind === "builtin") throw new Error(`"${name}" is built in; disable it instead`);
  await request("readwrite", (s) => s.delete(name));
  changed();
}

/** Restore a built-in's description, schema and confirm default. */
export async function resetTool(name: string): Promise<ToolRecord> {
  const b = findBuiltin(name);
  if (!b) throw new Error(`"${name}" is not a built-in tool`);
  const prev = await getTool(name);
  const rec = { ...fromBuiltin(b), enabled: prev?.enabled ?? false, updatedAt: Date.now() };
  await request("readwrite", (s) => s.put(rec));
  changed();
  return rec;
}

/** What a session is created with: the enabled tools' declarations (at most MAX_TOOLS). */
export function declarations(tools: ToolRecord[]): ToolDecl[] {
  return tools
    .filter((t) => t.enabled)
    .slice(0, MAX_TOOLS)
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}
