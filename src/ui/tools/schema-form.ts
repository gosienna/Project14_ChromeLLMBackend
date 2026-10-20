// Tool parameters as editable form rows and back to JSON Schema (Project05's tools/schema.js
// drafts). Only flat object schemas map to rows; anything richer is edited as JSON.

export const PARAM_TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export interface ParamRow {
  name: string;
  type: ParamType;
  description: string;
  required: boolean;
  /** Comma-separated allowed values (string params). */
  enumValues: string;
}

const SIMPLE_KEYS = new Set(["type", "description", "enum", "items"]);

/** Rows for a flat object schema, or null when the schema needs the JSON editor. */
export function schemaToRows(schema: Record<string, unknown>): ParamRow[] | null {
  if (schema.type !== "object") return null;
  if (Object.keys(schema).some((k) => !["type", "properties", "required"].includes(k))) return null;
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const rows: ParamRow[] = [];
  for (const [name, p] of Object.entries(props)) {
    if (!p || typeof p !== "object" || Object.keys(p).some((k) => !SIMPLE_KEYS.has(k))) return null;
    if (!PARAM_TYPES.includes(p.type as ParamType)) return null;
    if (p.items !== undefined && (p.type !== "array" || JSON.stringify(p.items) !== "{}")) return null;
    if (p.enum !== undefined && (p.type !== "string" || !Array.isArray(p.enum) || p.enum.some((v) => typeof v !== "string"))) return null;
    rows.push({
      name,
      type: p.type as ParamType,
      description: typeof p.description === "string" ? p.description : "",
      required: required.has(name),
      enumValues: Array.isArray(p.enum) ? (p.enum as string[]).join(", ") : "",
    });
  }
  return rows;
}

/** JSON Schema for form rows. Rows without a name are skipped. */
export function rowsToSchema(rows: ParamRow[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue;
    const values = r.enumValues.split(",").map((v) => v.trim()).filter(Boolean);
    properties[name] = {
      type: r.type,
      ...(r.description.trim() ? { description: r.description.trim() } : {}),
      ...(r.type === "string" && values.length ? { enum: values } : {}),
      ...(r.type === "array" ? { items: {} } : {}),
    };
    if (r.required) required.push(name);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

export const emptyRow = (): ParamRow => ({ name: "", type: "string", description: "", required: false, enumValues: "" });
