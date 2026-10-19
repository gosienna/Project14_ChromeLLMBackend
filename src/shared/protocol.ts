// Message shapes shared by every layer of the request path:
// page stub -> content-script relay -> service worker -> offscreen host.
// Every hop validates incoming messages with the functions below and drops
// anything that does not match.

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export type Availability = "unavailable" | "downloadable" | "downloading" | "available";

export interface SessionOptions {
  initialPrompts?: ChatMessage[];
  temperature?: number;
  topK?: number;
}

export interface ModelParams {
  defaultTopK: number;
  maxTopK: number;
  defaultTemperature: number;
  maxTemperature: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Omit that distributes over union members. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---- Page -> extension requests -------------------------------------------

export type PageRequest =
  | { kind: "availability"; id: string }
  | { kind: "params"; id: string }
  | { kind: "info"; id: string }
  | { kind: "create"; id: string; options: SessionOptions; monitor: boolean }
  | { kind: "clone"; id: string; sessionId: string }
  | { kind: "prompt"; id: string; sessionId: string; input: ChatMessage[]; stream: boolean }
  | { kind: "append"; id: string; sessionId: string; input: ChatMessage[] }
  | { kind: "measure"; id: string; sessionId: string; input: ChatMessage[] }
  | { kind: "destroy"; id: string; sessionId: string }
  | { kind: "abort"; id: string; target: string };

export type PageRequestKind = PageRequest["kind"];

// ---- Extension -> page responses ------------------------------------------

export interface SessionInfo {
  sessionId: string;
  temperature: number;
  topK: number;
  inputUsage: number;
  inputQuota: number;
}

export type PageResponse =
  | { kind: "result"; id: string; value: unknown }
  | { kind: "error"; id: string; name: string; message: string }
  | { kind: "chunk"; id: string; text: string }
  | { kind: "done"; id: string; inputUsage?: number }
  | { kind: "progress"; id: string; loaded: number };

// ---- Validation -----------------------------------------------------------

const MAX_ID = 64;
const MAX_TEXT = 1_000_000;
const MAX_MESSAGES = 1000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_ID && /^[\w-]+$/.test(v);

const isRole = (v: unknown): v is Role => v === "system" || v === "user" || v === "assistant";

function isMessages(v: unknown): v is ChatMessage[] {
  if (!Array.isArray(v) || v.length > MAX_MESSAGES) return false;
  let total = 0;
  for (const m of v) {
    if (!isObj(m) || !isRole(m.role) || typeof m.content !== "string") return false;
    if (Object.keys(m).some((k) => k !== "role" && k !== "content")) return false;
    total += m.content.length;
  }
  return total <= MAX_TEXT;
}

const isOptNum = (v: unknown, min: number, max: number) =>
  v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max);

function isSessionOptions(v: unknown): v is SessionOptions {
  if (!isObj(v)) return false;
  if (Object.keys(v).some((k) => !["initialPrompts", "temperature", "topK"].includes(k))) return false;
  if (v.initialPrompts !== undefined && !isMessages(v.initialPrompts)) return false;
  return isOptNum(v.temperature, 0, 2) && isOptNum(v.topK, 1, 1000);
}

const FIELDS: Record<PageRequestKind, string[]> = {
  availability: [],
  params: [],
  info: [],
  create: ["options", "monitor"],
  clone: ["sessionId"],
  prompt: ["sessionId", "input", "stream"],
  append: ["sessionId", "input"],
  measure: ["sessionId", "input"],
  destroy: ["sessionId"],
  abort: ["target"],
};

/** Strictly validate a page request. Unknown kinds or extra fields are rejected. */
export function parsePageRequest(v: unknown): PageRequest | null {
  if (!isObj(v) || typeof v.kind !== "string" || !(v.kind in FIELDS) || !isId(v.id)) return null;
  const kind = v.kind as PageRequestKind;
  const allowed = new Set(["kind", "id", ...FIELDS[kind]]);
  if (Object.keys(v).some((k) => !allowed.has(k))) return null;
  for (const f of FIELDS[kind]) if (!(f in v)) return null;

  switch (kind) {
    case "availability":
    case "params":
    case "info":
      return v as PageRequest;
    case "create":
      return isSessionOptions(v.options) && typeof v.monitor === "boolean" ? (v as PageRequest) : null;
    case "clone":
    case "destroy":
      return isId(v.sessionId) ? (v as PageRequest) : null;
    case "prompt":
      return isId(v.sessionId) && isMessages(v.input) && typeof v.stream === "boolean"
        ? (v as PageRequest)
        : null;
    case "append":
    case "measure":
      return isId(v.sessionId) && isMessages(v.input) ? (v as PageRequest) : null;
    case "abort":
      return isId(v.target) ? (v as PageRequest) : null;
  }
}

/** Validate a response before handing it to the page. */
export function parsePageResponse(v: unknown): PageResponse | null {
  if (!isObj(v) || !isId(v.id)) return null;
  switch (v.kind) {
    case "result":
      return v as PageResponse;
    case "error":
      return typeof v.name === "string" && typeof v.message === "string" ? (v as PageResponse) : null;
    case "chunk":
      return typeof v.text === "string" ? (v as PageResponse) : null;
    case "done":
      return v.inputUsage === undefined || typeof v.inputUsage === "number" ? (v as PageResponse) : null;
    case "progress":
      return typeof v.loaded === "number" ? (v as PageResponse) : null;
    default:
      return null;
  }
}

export function randomId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Rough token estimate used where no tokenizer is available (cloud backends, rate limits). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
}
