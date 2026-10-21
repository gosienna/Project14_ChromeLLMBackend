// Local model lifecycle in the offscreen host: capability probe, engine auto-selection, lazy
// load, one loaded model at a time, FIFO generation queue and idle unload.

import { ALL_CAPS, canRun, contextLimit, resolveEngine, takesImages, toolMode, type CatalogModel, type DeviceCaps, type EngineId } from "../shared/catalog";
import type { Availability, ChatMessage, ModelParams } from "../shared/protocol";
import { DEFAULT_PARAMS, type Backend, type GenerateOptions, type GenerateResult } from "./backend";
import { DummyEngine } from "./engines/dummy";
import { NanoEngine, nanoSupported } from "./engines/nano";
import type { LocalEngine } from "./engines/types";
import { withResponseTrace } from "./trace";
import { removeLegacyStorage } from "./model-store";
import { raceAbort, untilAborted } from "./abortable";

const DOWNLOADED_KEY = "downloadedModels";
/** Where downloaded weights live; a different value means they were stored the old way. */
const STORAGE_KEY = "modelStorage";
const STORAGE = "indexeddb";
/** How long an aborted generation may take to stop before its engine is treated as stuck. */
const ABORT_GRACE_MS = 5_000;
/** How long a stuck engine gets to unload before the next one loads anyway. */
const UNLOAD_GRACE_MS = 5_000;

function createEngine(id: EngineId): Promise<LocalEngine> | LocalEngine {
  switch (id) {
    case "transformers":
      return import("./engines/transformers").then((m) => new m.TransformersEngine());
    case "webllm":
      return import("./engines/webllm").then((m) => new m.WebLLMEngine());
    case "wllama":
      return import("./engines/wllama").then((m) => new m.WllamaEngine());
    case "nano":
      return new NanoEngine();
    case "dummy":
      return new DummyEngine();
  }
}

// Same checks as wllama's isSupportJSPI / isSupportMem64, without loading wllama.
function supportsJspi(): boolean {
  return !!(WebAssembly as unknown as { Suspending?: unknown }).Suspending;
}

function supportsMem64(): boolean {
  try {
    new WebAssembly.Memory({ address: "i64", initial: 1n } as unknown as WebAssembly.MemoryDescriptor);
    return true;
  } catch {
    return false;
  }
}

export class LocalRuntime {
  caps: DeviceCaps = { webgpu: false, maxBufferMB: 0, jspi: false, mem64: false };
  private current: { model: CatalogModel; engine: LocalEngine; nCtx: number } | null = null;
  private loading: { key: string; nCtx: number; promise: Promise<LocalEngine>; listeners: Set<(f: number) => void> } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private active = 0;

  async probe(): Promise<DeviceCaps> {
    const wasm = { jspi: supportsJspi(), mem64: supportsMem64() };
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ limits: { maxStorageBufferBindingSize: number } } | null> } }).gpu;
      const adapter = await gpu?.requestAdapter();
      this.caps = adapter
        ? { webgpu: true, maxBufferMB: Math.round(adapter.limits.maxStorageBufferBindingSize / 2 ** 20), ...wasm }
        : { webgpu: false, maxBufferMB: 0, ...wasm };
    } catch {
      this.caps = { webgpu: false, maxBufferMB: 0, ...wasm };
    }
    return this.caps;
  }

  /** One-time move to IndexedDB: drop the old copies and the list that described them. */
  async migrateStorage(): Promise<void> {
    if (localStorage.getItem(STORAGE_KEY) === STORAGE) return;
    await removeLegacyStorage();
    localStorage.removeItem(DOWNLOADED_KEY);
    localStorage.setItem(STORAGE_KEY, STORAGE);
  }

  resolveEngine(model: CatalogModel, pin: EngineId | "auto"): EngineId | null {
    return resolveEngine(model, pin, this.caps);
  }

  get loaded() {
    return this.current ? { modelId: this.current.model.id, engine: this.current.engine.id } : null;
  }

  get downloadingKey() {
    return this.loading?.key ?? null;
  }

  downloaded(): string[] {
    try {
      return JSON.parse(localStorage.getItem(DOWNLOADED_KEY) ?? "[]");
    } catch {
      return [];
    }
  }

  private setDownloaded(key: string, on: boolean) {
    const set = new Set(this.downloaded());
    if (on) set.add(key);
    else set.delete(key);
    localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...set]));
  }

  availability(model: CatalogModel, pin: EngineId | "auto"): Availability {
    const engine = this.resolveEngine(model, pin);
    if (!engine) return "unavailable";
    if (engine === "nano" && !nanoSupported()) return "unavailable";
    const key = `${engine}:${model.id}`;
    if (this.loading?.key === key) return "downloading";
    if (engine === "dummy" || this.downloaded().includes(key)) return "available";
    return "downloadable";
  }

  /** Context a load would allocate: the user's limit, capped to what the model and build allow. */
  contextSize(model: CatalogModel, pin: EngineId | "auto", maxContext: number): number {
    const engine = this.resolveEngine(model, pin);
    return Math.min(maxContext, engine ? contextLimit(model, engine) : model.contextWindow);
  }

  /**
   * Load (downloading if needed) the model with a `maxContext`-token context, unloading any other
   * one first. A loaded model with a different context is reloaded: the KV cache is sized at load.
   */
  async ensure(model: CatalogModel, pin: EngineId | "auto", maxContext: number, onProgress?: (f: number) => void): Promise<LocalEngine> {
    const engineId = this.resolveEngine(model, pin);
    if (!engineId) throw new DOMException(`${model.name} cannot run on this device`, "NotSupportedError");
    const key = `${engineId}:${model.id}`;
    const nCtx = this.contextSize(model, pin, maxContext);
    const c = this.current;
    if (c && c.model.id === model.id && c.engine.id === engineId && c.nCtx === nCtx) return c.engine;
    if (this.loading?.key === key && this.loading.nCtx === nCtx) {
      if (onProgress) this.loading.listeners.add(onProgress);
      return this.loading.promise;
    }
    await this.loading?.promise.catch(() => {});
    const listeners = new Set<(f: number) => void>(onProgress ? [onProgress] : []);
    const promise = (async () => {
      // Switching models mid-generation is rare (one global model setting); the old
      // engine's in-flight generation fails and the page gets an error.
      await this.unload();
      const engine = await createEngine(engineId);
      await engine.load(model, this.caps, (f) => listeners.forEach((l) => l(f)), nCtx);
      this.current = { model, engine, nCtx };
      this.setDownloaded(key, true);
      return engine;
    })();
    this.loading = { key, nCtx, promise, listeners };
    try {
      return await promise;
    } finally {
      if (this.loading?.promise === promise) this.loading = null;
    }
  }

  async unload(): Promise<void> {
    const c = this.current;
    this.current = null;
    clearTimeout(this.idleTimer);
    await c?.engine.unload();
  }

  /** Drop an engine that didn't stop when aborted, so it can't hold the FIFO. The next generation loads a fresh one. */
  private async abandon(): Promise<void> {
    const c = this.current;
    if (!c) return;
    this.current = null;
    console.warn(`[local] ${c.engine.id}:${c.model.id} did not stop after abort; unloading it`);
    // A wedged engine may never finish unloading either.
    await Promise.race([c.engine.unload().catch(() => {}), new Promise((r) => setTimeout(r, UNLOAD_GRACE_MS))]);
  }

  async deleteModel(model: CatalogModel): Promise<void> {
    for (const id of ["transformers", "webllm", "wllama"] as EngineId[]) {
      if (!canRun(model, id, ALL_CAPS)) continue;
      if (this.current?.model.id === model.id) await this.unload();
      const engine = await createEngine(id);
      await engine.deleteCache(model).catch(() => {});
      this.setDownloaded(`${id}:${model.id}`, false);
    }
  }

  /** Restart the idle timer; unloading frees GPU memory. */
  touch(idleMinutes: number) {
    clearTimeout(this.idleTimer);
    if (this.active > 0 || idleMinutes <= 0) return;
    this.idleTimer = setTimeout(() => void this.unload(), idleMinutes * 60_000);
  }

  /**
   * Wait for this caller's turn on the FIFO; call the returned function to pass it on. If `signal`
   * aborts while waiting, the caller leaves the line with AbortError.
   */
  private async turn(signal?: AbortSignal): Promise<() => void> {
    let release!: () => void;
    const turn = new Promise<void>((r) => (release = r));
    const prev = this.queue.catch(() => {});
    this.queue = prev.then(() => turn);
    try {
      await (signal ? raceAbort(prev, signal) : prev);
    } catch (e) {
      // Our place in line passes straight on once the caller before us is done.
      void prev.then(release);
      throw e;
    }
    return release;
  }

  /** Whether `ensure` would return the loaded engine as is. */
  isLoaded(model: CatalogModel, pin: EngineId | "auto", maxContext: number): boolean {
    const c = this.current;
    return !!c && c.model.id === model.id && c.engine.id === this.resolveEngine(model, pin) && c.nCtx === this.contextSize(model, pin, maxContext);
  }

  /**
   * `ensure` outside a generation. Sites can use different local models, so loading another one
   * waits its turn on the FIFO rather than unloading a model mid-generation.
   */
  async ensureQueued(model: CatalogModel, pin: EngineId | "auto", maxContext: number, onProgress?: (f: number) => void): Promise<LocalEngine> {
    if (this.isLoaded(model, pin, maxContext)) return this.ensure(model, pin, maxContext, onProgress);
    const release = await this.turn();
    try {
      return await this.ensure(model, pin, maxContext, onProgress);
    } finally {
      release();
    }
  }

  /**
   * FIFO: one local generation at a time. Abort releases the turn even if the engine ignores
   * `signal`; an engine still busy after the grace period is unloaded.
   */
  async *exclusive<T, R>(run: () => AsyncGenerator<T, R>, idleMinutes: number, signal: AbortSignal): AsyncGenerator<T, R> {
    const release = await this.turn(signal);
    this.active++;
    clearTimeout(this.idleTimer);
    try {
      return yield* untilAborted(run(), signal, ABORT_GRACE_MS, () => this.abandon());
    } finally {
      this.active--;
      release();
      this.touch(idleMinutes);
    }
  }
}

export class LocalBackend implements Backend {
  readonly id = "local";
  readonly kind = "local" as const;

  constructor(
    private runtime: LocalRuntime,
    readonly model: CatalogModel,
    private pin: EngineId | "auto",
    private idleMinutes: number,
    /** The user's "Max context tokens"; the model loads with this, capped to its own limit. */
    private maxContext: number,
    /** Let reasoning models think; off asks them to skip or shorten it. */
    private reasoning = true,
  ) {}

  describe() {
    return { name: this.model.name, backend: this.runtime.resolveEngine(this.model, this.pin) ?? "unavailable" };
  }

  async availability() {
    return this.runtime.availability(this.model, this.pin);
  }

  async prepare(onProgress?: (f: number) => void) {
    await this.runtime.ensureQueued(this.model, this.pin, this.maxContext, onProgress);
    this.runtime.touch(this.idleMinutes);
  }

  contextWindow() {
    return this.runtime.contextSize(this.model, this.pin, this.maxContext);
  }

  acceptsImages() {
    const engine = this.runtime.resolveEngine(this.model, this.pin);
    return engine !== null && takesImages(this.model, engine);
  }

  params(): ModelParams {
    return DEFAULT_PARAMS;
  }

  toolMode() {
    const engine = this.runtime.resolveEngine(this.model, this.pin);
    return engine ? toolMode(this.model, engine) : "prompted";
  }

  async countTokens(messages: ChatMessage[]) {
    const engine = await this.runtime.ensureQueued(this.model, this.pin, this.maxContext);
    return engine.countTokens(messages);
  }

  generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, GenerateResult> {
    const runtime = this.runtime;
    const model = this.model;
    const pin = this.pin;
    const maxContext = this.maxContext;
    const withReasoning = { ...opts, reasoning: this.reasoning };
    return runtime.exclusive(async function* () {
      const engine = await runtime.ensure(model, pin, maxContext);
      // Engines report their request; the wrapper adds the response for the playground's raw view.
      return yield* withResponseTrace(withReasoning, (o) => engine.generate(messages, o, signal));
    }, this.idleMinutes, signal);
  }
}
