// Main-world stub. Defines a Prompt API-compatible window.LanguageModel on approved origins.
// It holds no model: only request ids and promise/stream bookkeeping. Requests travel to the
// isolated-world relay (bridge.ts) over a MessageChannel set up with a per-page nonce.

import type { ChatMessage, DistributiveOmit, ModelParams, PageRequest, PageResponse, SessionInfo, SessionOptions } from "../shared/protocol";

declare const __OVERRIDE_NATIVE__: boolean;
declare const __VERSION__: string;

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onChunk?: (text: string) => void;
  onProgress?: (loaded: number) => void;
  onDone?: (inputUsage?: number) => void;
};

(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w.__localLLMStub) return;
  Object.defineProperty(w, "__localLLMStub", { value: true });

  const hasNative = "LanguageModel" in w;
  if (hasNative && !__OVERRIDE_NATIVE__) return;

  // ---- Transport ----------------------------------------------------------

  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const pending = new Map<string, Pending>();
  const queue: PageRequest[] = [];
  const candidates: MessagePort[] = [];
  let port: MessagePort | null = null;
  let counter = 0;

  const nextId = () => `r${++counter}-${nonce.slice(0, 8)}`;

  function onPortMessage(this: MessagePort, ev: MessageEvent) {
    const data = ev.data as { nonce?: string; kind?: string } & PageResponse;
    if (!data || data.nonce !== nonce) return;
    if (data.kind === ("hello-ack" as string)) {
      if (port) return;
      port = this;
      for (const p of candidates) if (p !== this) p.close();
      candidates.length = 0;
      for (const msg of queue.splice(0)) port.postMessage({ nonce, msg });
      return;
    }
    if (this !== port) return;
    const p = pending.get(data.id);
    if (!p) return;
    switch (data.kind) {
      case "result":
        pending.delete(data.id);
        p.resolve(data.value);
        break;
      case "error":
        pending.delete(data.id);
        p.reject(new DOMException(data.message, data.name));
        break;
      case "chunk":
        p.onChunk?.(data.text);
        break;
      case "progress":
        p.onProgress?.(data.loaded);
        break;
      case "done":
        pending.delete(data.id);
        p.onDone?.(data.inputUsage);
        p.resolve(undefined);
        break;
    }
  }

  function hello() {
    if (port) return;
    const ch = new MessageChannel();
    ch.port1.onmessage = onPortMessage;
    candidates.push(ch.port1);
    window.postMessage({ __localLLM: "hello", nonce }, location.origin, [ch.port2]);
  }

  window.addEventListener("message", (ev) => {
    if (ev.source === window && (ev.data as { __localLLM?: string })?.__localLLM === "bridge-ready") hello();
  });
  hello();

  function send(msg: PageRequest) {
    if (port) port.postMessage({ nonce, msg });
    else queue.push(msg);
  }

  function request<T>(msg: DistributiveOmit<PageRequest, "id"> & { id?: string }, extra: Partial<Pending> = {}, signal?: AbortSignal): Promise<T> {
    const id = msg.id ?? nextId();
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      const onAbort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        send({ kind: "abort", id: nextId(), target: id });
        reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      pending.set(id, {
        ...extra,
        resolve: (v) => (cleanup(), resolve(v as T)),
        reject: (e) => (cleanup(), reject(e)),
      });
      send({ ...msg, id } as PageRequest);
    });
  }

  // ---- Input normalization -----------------------------------------------

  type PromptInput = string | Array<{ role?: string; content: unknown; prefix?: boolean }>;

  function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (part && typeof part === "object" && (part as { type?: string }).type === "text") return String((part as { value: unknown }).value);
          throw new DOMException("Only text input is supported", "NotSupportedError");
        })
        .join("");
    }
    throw new TypeError("Invalid prompt content");
  }

  function normalize(input: PromptInput): ChatMessage[] {
    if (typeof input === "string") return [{ role: "user", content: input }];
    if (!Array.isArray(input)) throw new TypeError("Prompt input must be a string or an array of messages");
    return input.map((m) => {
      const role = m.role ?? "user";
      if (role !== "user" && role !== "assistant" && role !== "system") throw new TypeError(`Invalid role: ${role}`);
      return { role, content: textOf(m.content) };
    });
  }

  function checkModalities(options: { expectedInputs?: Array<{ type: string }>; expectedOutputs?: Array<{ type: string }> } = {}) {
    for (const e of [...(options.expectedInputs ?? []), ...(options.expectedOutputs ?? [])]) {
      if (e?.type !== "text") throw new DOMException(`Modality "${e?.type}" is not supported`, "NotSupportedError");
    }
  }

  // ---- LanguageModel -----------------------------------------------------

  interface CreateOptions extends SessionOptions {
    signal?: AbortSignal;
    monitor?: (m: EventTarget) => void;
    expectedInputs?: Array<{ type: string }>;
    expectedOutputs?: Array<{ type: string }>;
  }

  class LanguageModel extends EventTarget {
    #info: SessionInfo;
    #destroyed = false;
    #controller = new AbortController();
    onquotaoverflow: ((e: Event) => void) | null = null;

    private constructor(info: SessionInfo) {
      super();
      this.#info = info;
      this.addEventListener("quotaoverflow", (e) => this.onquotaoverflow?.(e));
    }

    static async availability(options: CreateOptions = {}): Promise<string> {
      checkModalities(options);
      return request<string>({ kind: "availability" });
    }

    static async params(): Promise<ModelParams> {
      return request<ModelParams>({ kind: "params" });
    }

    static async create(options: CreateOptions = {}): Promise<LanguageModel> {
      checkModalities(options);
      const monitor = new EventTarget();
      if (typeof options.monitor === "function") options.monitor(monitor);
      const sessionOptions: SessionOptions = {};
      if (options.initialPrompts) {
        sessionOptions.initialPrompts = normalize(options.initialPrompts as PromptInput);
        const sys = sessionOptions.initialPrompts.findIndex((m) => m.role === "system");
        if (sys > 0) throw new TypeError("A system prompt must be the first initial prompt");
      }
      if (options.temperature !== undefined) sessionOptions.temperature = options.temperature;
      if (options.topK !== undefined) sessionOptions.topK = options.topK;
      if ((options.temperature === undefined) !== (options.topK === undefined)) {
        throw new DOMException("temperature and topK must be specified together", "NotSupportedError");
      }
      const info = await request<SessionInfo>(
        { kind: "create", options: sessionOptions, monitor: typeof options.monitor === "function" },
        { onProgress: (loaded) => monitor.dispatchEvent(new ProgressEvent("downloadprogress", { loaded, total: 1 })) },
        options.signal,
      );
      return new LanguageModel(info);
    }

    get inputUsage() { return this.#info.inputUsage; }
    get inputQuota() { return this.#info.inputQuota; }
    get contextUsage() { return this.#info.inputUsage; }
    get contextWindow() { return this.#info.inputQuota; }
    get temperature() { return this.#info.temperature; }
    get topK() { return this.#info.topK; }

    #check() {
      if (this.#destroyed) throw new DOMException("The session has been destroyed", "InvalidStateError");
    }

    #signal(signal?: AbortSignal): AbortSignal {
      return signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
    }

    #setUsage(u?: number) {
      if (typeof u === "number") this.#info.inputUsage = u;
    }

    async prompt(input: PromptInput, options: { signal?: AbortSignal; responseConstraint?: unknown } = {}): Promise<string> {
      this.#check();
      if (options.responseConstraint !== undefined) throw new DOMException("responseConstraint is not supported yet", "NotSupportedError");
      let text = "";
      await request<void>(
        { kind: "prompt", sessionId: this.#info.sessionId, input: normalize(input), stream: false },
        { onChunk: (c) => (text += c), onDone: (u) => this.#setUsage(u) },
        this.#signal(options.signal),
      );
      return text;
    }

    promptStreaming(input: PromptInput, options: { signal?: AbortSignal; responseConstraint?: unknown } = {}): ReadableStream<string> {
      this.#check();
      if (options.responseConstraint !== undefined) throw new DOMException("responseConstraint is not supported yet", "NotSupportedError");
      const messages = normalize(input);
      const id = nextId();
      const signal = this.#signal(options.signal);
      return new ReadableStream<string>({
        start: (controller) => {
          request<void>(
            { kind: "prompt", id, sessionId: this.#info.sessionId, input: messages, stream: true },
            { onChunk: (c) => controller.enqueue(c), onDone: (u) => this.#setUsage(u) },
            signal,
          ).then(() => controller.close(), (e) => controller.error(e));
        },
        cancel: () => {
          if (pending.delete(id)) send({ kind: "abort", id: nextId(), target: id });
        },
      });
    }

    async append(input: PromptInput, options: { signal?: AbortSignal } = {}): Promise<void> {
      this.#check();
      const u = await request<number>({ kind: "append", sessionId: this.#info.sessionId, input: normalize(input) }, {}, this.#signal(options.signal));
      this.#setUsage(u);
    }

    async measureInputUsage(input: PromptInput, options: { signal?: AbortSignal } = {}): Promise<number> {
      this.#check();
      return request<number>({ kind: "measure", sessionId: this.#info.sessionId, input: normalize(input) }, {}, this.#signal(options.signal));
    }

    /** Older name for measureInputUsage, kept for compatibility. */
    countPromptTokens(input: PromptInput) {
      return this.measureInputUsage(input);
    }

    async clone(options: { signal?: AbortSignal } = {}): Promise<LanguageModel> {
      this.#check();
      const info = await request<SessionInfo>({ kind: "clone", sessionId: this.#info.sessionId }, {}, this.#signal(options.signal));
      return new LanguageModel(info);
    }

    destroy(): void {
      if (this.#destroyed) return;
      this.#destroyed = true;
      this.#controller.abort(new DOMException("The session has been destroyed", "AbortError"));
      send({ kind: "destroy", id: nextId(), sessionId: this.#info.sessionId });
    }
  }

  Object.defineProperty(window, "LanguageModel", { value: LanguageModel, writable: true, configurable: true });

  const localLLM = Object.freeze({
    version: __VERSION__,
    overridesNative: hasNative,
    info: () => request<{ name: string; backend: string; version: string }>({ kind: "info" }),
  });
  Object.defineProperty(window, "localLLM", { value: localLLM, writable: false, configurable: true });
  window.dispatchEvent(new Event("localllm:ready"));
})();
