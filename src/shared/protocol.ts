// Message shapes shared by every layer of the request path:
// page stub -> content-script relay -> service worker -> offscreen host.
// Every hop validates incoming messages with the functions below and drops
// anything that does not match.

/** Roles a page may send. The host's history also holds "tool" turns (see ChatMessage). */
export type Role = "system" | "user" | "assistant";

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

/** Base64-encoded image. Only the extension's own playground page may send these. */
export interface ImageInput {
  mimeType: ImageMime;
  data: string;
}

export interface ChatMessage {
  role: Role | "tool";
  content: string;
  /** User turns only. Pages never send images; parsePageRequest rejects them by default. */
  images?: ImageInput[];
  /** Assistant turns: tools the model asked for. Host history only; pages never send these. */
  toolCalls?: ToolCall[];
  /** Tool turns: the call this result answers, and the tool's name. */
  toolCallId?: string;
  name?: string;
}

/** A tool a page offers, as declared in LanguageModel.create({ tools }). `execute` stays in the page. */
export interface ToolDecl {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  inputSchema: Record<string, unknown>;
}

/** A tool call the model made. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Provider data that must be sent back with the call (Gemini thought signatures). */
  signature?: string;
}

export type Availability = "unavailable" | "downloadable" | "downloading" | "available";

export interface SessionOptions {
  initialPrompts?: ChatMessage[];
  temperature?: number;
  topK?: number;
  tools?: ToolDecl[];
  /**
   * A ModelInfo id from localLLM.models(). The router accepts only ids in the list it builds for
   * the site itself, and removes the field before the request reaches the host.
   */
  model?: string;
  /**
   * Non-standard: deliver the model's thinking to the page as `reasoning` responses (the polyfill's
   * `onReasoning` prompt option). The router removes the field before the request reaches the host.
   */
  reasoning?: boolean;
}

/** USD per million tokens, as in shared/cloud-models.ts. Local models cost 0. */
export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
  /** Higher rates for the whole request once the prompt exceeds `above` tokens. */
  long?: { above: number; input: number; output: number };
  note?: string;
  /** Date the price was checked (cloud only). */
  asOf?: string;
}

/** A model a site can run right now, as localLLM.models() reports it. */
export interface ModelInfo {
  /** "local:<catalog id>" or "<provider id>:<provider's model id>"; pass to create({ model }). */
  id: string;
  name: string;
  /** "local" or a provider id. */
  backend: string;
  /** "Local" or the provider's name. */
  provider: string;
  /** Local models: the engine that runs it ("transformers" | "webllm" | "wllama" | "nano" | "dummy"). */
  engine?: string;
  /** What create() uses without a `model`. */
  default: boolean;
  /** What the model takes: "text", "image", "audio", "video", "pdf". Pages send text only. */
  input: string[];
  output: string[];
  /** The model's maximum context in tokens. */
  contextWindow: number;
  /** Context a session gets: the smaller of the model's input cap and the user's limit. */
  inputQuota: number;
  /** Longest reply a session allows: the model's own limit where stated, the user's limit and inputQuota. */
  maxOutputTokens: number;
  /** Thinks before answering: "hybrid" can be told not to, "always" cannot. */
  reasoning?: "hybrid" | "always";
  tools: "native" | "prompted";
  /** Null when unknown or set by a router's choice of model. */
  price: ModelPrice | null;
  /** Local download size. */
  sizeMB?: number;
  /** Older but still served. */
  legacy?: boolean;
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
  /** Models the site may run right now (ModelInfo[]). */
  | { kind: "models"; id: string }
  | { kind: "create"; id: string; options: SessionOptions; monitor: boolean }
  | { kind: "clone"; id: string; sessionId: string }
  | { kind: "prompt"; id: string; sessionId: string; input: ChatMessage[]; stream: boolean }
  | { kind: "append"; id: string; sessionId: string; input: ChatMessage[] }
  | { kind: "measure"; id: string; sessionId: string; input: ChatMessage[] }
  | { kind: "destroy"; id: string; sessionId: string }
  | { kind: "abort"; id: string; target: string }
  /** The page ran a tool the model called during prompt `target`. */
  | { kind: "tool-result"; id: string; target: string; callId: string; result: string; isError: boolean }
  /** Web search (Tavily, falling back to a Google results tab). Only for sites with web search on. */
  | { kind: "search"; id: string; query: string; maxResults: number; includeImages: boolean }
  /** Download an image this origin's own search returned. Same switch as search. */
  | { kind: "fetch-image"; id: string; url: string };

export type PageRequestKind = PageRequest["kind"];

/** Extension playground page -> router. Extension UI, so it may name the backend to test. */
export interface PlaygroundEnvelope {
  backend: string;
  req: PageRequest;
}

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
  /** A reasoning model's thinking. The router forwards it to the playground and to sessions created with reasoning: true. */
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "done"; id: string; inputUsage?: number }
  | { kind: "progress"; id: string; loaded: number }
  /** Playground only: one generation's request and response, for the raw view. `round` counts tool rounds. */
  | { kind: "trace"; id: string; round: number; trace: { engine: string; request: unknown; prompt?: string; response?: unknown } }
  /** The model wants the page to run a tool; the page answers with a tool-result request. */
  | { kind: "tool-call"; id: string; callId: string; name: string; arguments: Record<string, unknown> };

export type PageResponseKind = PageResponse["kind"];

/**
 * Router -> bridge messages about the port itself, not about a request. `connected` is the
 * first message on every page port; `closed` comes right before the router closes an idle one.
 */
export type PortNotice = { kind: "connected" } | { kind: "closed"; reason: "idle" };

// ---- Validation -----------------------------------------------------------

const MAX_ID = 64;
const MAX_TEXT = 1_000_000;
const MAX_MESSAGES = 1000;
/** Base64 length of a ~5 MB image, the smallest per-image limit among the cloud providers. */
export const MAX_IMAGE_BASE64 = 7_000_000;
export const MAX_IMAGES_PER_MESSAGE = 8;
export const MAX_TOOLS = 32;
const MAX_TOOL_DESCRIPTION = 4096;
const MAX_TOOL_SCHEMA = 65_536;
const MAX_MODEL_ID = 256;
export const MAX_SEARCH_QUERY = 500;
export const MAX_SEARCH_RESULTS = 10;
export const MAX_URL = 2048;
export const TOOL_NAME = /^[A-Za-z_][\w-]{0,63}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_ID && /^[\w-]+$/.test(v);

const isRole = (v: unknown): v is Role => v === "system" || v === "user" || v === "assistant";

function isImage(v: unknown): v is ImageInput {
  if (!isObj(v) || Object.keys(v).some((k) => k !== "mimeType" && k !== "data")) return false;
  return (IMAGE_MIME_TYPES as readonly unknown[]).includes(v.mimeType) &&
    typeof v.data === "string" && v.data.length > 0 && v.data.length <= MAX_IMAGE_BASE64 && /^[A-Za-z0-9+/]+={0,2}$/.test(v.data);
}

function isMessages(v: unknown, images: boolean): v is ChatMessage[] {
  if (!Array.isArray(v) || v.length > MAX_MESSAGES) return false;
  let total = 0;
  for (const m of v) {
    if (!isObj(m) || !isRole(m.role) || typeof m.content !== "string") return false;
    if (Object.keys(m).some((k) => k !== "role" && k !== "content" && !(images && k === "images"))) return false;
    if (m.images !== undefined) {
      if (m.role !== "user" || !Array.isArray(m.images) || m.images.length > MAX_IMAGES_PER_MESSAGE || !m.images.every(isImage)) return false;
    }
    total += m.content.length;
  }
  return total <= MAX_TEXT;
}

const isOptNum = (v: unknown, min: number, max: number) =>
  v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max);

function jsonSize(v: unknown): number {
  try {
    return JSON.stringify(v).length;
  } catch {
    return Infinity;
  }
}

function isTools(v: unknown): v is ToolDecl[] {
  if (!Array.isArray(v) || v.length > MAX_TOOLS) return false;
  const names = new Set<string>();
  for (const t of v) {
    if (!isObj(t) || Object.keys(t).some((k) => k !== "name" && k !== "description" && k !== "inputSchema")) return false;
    if (typeof t.name !== "string" || !TOOL_NAME.test(t.name) || names.has(t.name)) return false;
    if (typeof t.description !== "string" || t.description.length > MAX_TOOL_DESCRIPTION) return false;
    if (!isObj(t.inputSchema) || jsonSize(t.inputSchema) > MAX_TOOL_SCHEMA) return false;
    names.add(t.name);
  }
  return true;
}

/** Only compared against the router's own list, so the check is about size and printable text. */
const isModelId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_MODEL_ID && !/[\u0000-\u001f\u007f]/.test(v);

function isSessionOptions(v: unknown): v is SessionOptions {
  if (!isObj(v)) return false;
  if (Object.keys(v).some((k) => !["initialPrompts", "temperature", "topK", "tools", "model", "reasoning"].includes(k))) return false;
  if (v.initialPrompts !== undefined && !isMessages(v.initialPrompts, false)) return false;
  if (v.tools !== undefined && !isTools(v.tools)) return false;
  if (v.model !== undefined && !isModelId(v.model)) return false;
  if (v.reasoning !== undefined && typeof v.reasoning !== "boolean") return false;
  return isOptNum(v.temperature, 0, 2) && isOptNum(v.topK, 1, 1000);
}

const FIELDS: Record<PageRequestKind, string[]> = {
  availability: [],
  params: [],
  info: [],
  models: [],
  create: ["options", "monitor"],
  clone: ["sessionId"],
  prompt: ["sessionId", "input", "stream"],
  append: ["sessionId", "input"],
  measure: ["sessionId", "input"],
  destroy: ["sessionId"],
  abort: ["target"],
  "tool-result": ["target", "callId", "result", "isError"],
  search: ["query", "maxResults", "includeImages"],
  "fetch-image": ["url"],
};

/**
 * Strictly validate a page request. Unknown kinds or extra fields are rejected. `images` allows
 * image attachments on prompt/append/measure input; only the extension's playground sets it.
 */
export function parsePageRequest(v: unknown, { images = false }: { images?: boolean } = {}): PageRequest | null {
  if (!isObj(v) || typeof v.kind !== "string" || !(v.kind in FIELDS) || !isId(v.id)) return null;
  const kind = v.kind as PageRequestKind;
  const allowed = new Set(["kind", "id", ...FIELDS[kind]]);
  if (Object.keys(v).some((k) => !allowed.has(k))) return null;
  for (const f of FIELDS[kind]) if (!(f in v)) return null;

  switch (kind) {
    case "availability":
    case "params":
    case "info":
    case "models":
      return v as PageRequest;
    case "create":
      return isSessionOptions(v.options) && typeof v.monitor === "boolean" ? (v as PageRequest) : null;
    case "clone":
    case "destroy":
      return isId(v.sessionId) ? (v as PageRequest) : null;
    case "prompt":
      return isId(v.sessionId) && isMessages(v.input, images) && typeof v.stream === "boolean"
        ? (v as PageRequest)
        : null;
    case "append":
    case "measure":
      return isId(v.sessionId) && isMessages(v.input, images) ? (v as PageRequest) : null;
    case "abort":
      return isId(v.target) ? (v as PageRequest) : null;
    case "tool-result":
      return isId(v.target) && isId(v.callId) && typeof v.result === "string" && v.result.length <= MAX_TEXT && typeof v.isError === "boolean"
        ? (v as PageRequest)
        : null;
    case "search":
      return typeof v.query === "string" && v.query.trim().length > 0 && v.query.length <= MAX_SEARCH_QUERY &&
        Number.isInteger(v.maxResults) && (v.maxResults as number) >= 1 && (v.maxResults as number) <= MAX_SEARCH_RESULTS &&
        typeof v.includeImages === "boolean"
        ? (v as PageRequest)
        : null;
    case "fetch-image":
      return typeof v.url === "string" && v.url.length <= MAX_URL && /^https?:\/\/[^\s]+$/i.test(v.url) ? (v as PageRequest) : null;
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
    case "reasoning":
      return typeof v.text === "string" ? (v as PageResponse) : null;
    case "done":
      return v.inputUsage === undefined || typeof v.inputUsage === "number" ? (v as PageResponse) : null;
    case "progress":
      return typeof v.loaded === "number" ? (v as PageResponse) : null;
    case "tool-call":
      return isId(v.callId) && typeof v.name === "string" && isObj(v.arguments) ? (v as PageResponse) : null;
    default:
      return null;
  }
}

export function parsePortNotice(v: unknown): PortNotice | null {
  if (!isObj(v)) return null;
  const keys = Object.keys(v).sort().join(",");
  if (v.kind === "connected" && keys === "kind") return { kind: "connected" };
  if (v.kind === "closed" && keys === "kind,reason" && v.reason === "idle") return { kind: "closed", reason: "idle" };
  return null;
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

/** Flat per-image estimate (providers bill roughly 250–1600 tokens depending on size). */
export const IMAGE_TOKEN_ESTIMATE = 1000;

export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (n, m) => n + estimateTokens(m.content) + 4 + (m.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0),
    0,
  );
}
