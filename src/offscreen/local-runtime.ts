// Local model lifecycle in the offscreen host: capability probe, engine auto-selection, lazy
// load, one loaded model at a time, FIFO generation queue and idle unload.

import { autoSelectEngine, canRun, type CatalogModel, type DeviceCaps, type EngineId } from "../shared/catalog";
import type { Availability, ChatMessage, ModelParams, Usage } from "../shared/protocol";
import { DEFAULT_PARAMS, type Backend, type GenerateOptions } from "./backend";
import { DummyEngine } from "./engines/dummy";
import { NanoEngine, nanoSupported } from "./engines/nano";
import type { LocalEngine } from "./engines/types";

const DOWNLOADED_KEY = "downloadedModels";

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

export class LocalRuntime {
  caps: DeviceCaps = { webgpu: false, maxBufferMB: 0 };
  private current: { model: CatalogModel; engine: LocalEngine } | null = null;
  private loading: { key: string; promise: Promise<LocalEngine>; listeners: Set<(f: number) => void> } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private active = 0;

  async probe(): Promise<DeviceCaps> {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ limits: { maxStorageBufferBindingSize: number } } | null> } }).gpu;
      const adapter = await gpu?.requestAdapter();
      this.caps = adapter
        ? { webgpu: true, maxBufferMB: Math.round(adapter.limits.maxStorageBufferBindingSize / 2 ** 20) }
        : { webgpu: false, maxBufferMB: 0 };
    } catch {
      this.caps = { webgpu: false, maxBufferMB: 0 };
    }
    return this.caps;
  }

  resolveEngine(model: CatalogModel, pin: EngineId | "auto"): EngineId | null {
    if (pin !== "auto") return canRun(model, pin, this.caps) ? pin : null;
    return autoSelectEngine(model, this.caps);
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

  /** Load (downloading if needed) the model, unloading any other one first. */
  async ensure(model: CatalogModel, pin: EngineId | "auto", onProgress?: (f: number) => void): Promise<LocalEngine> {
    const engineId = this.resolveEngine(model, pin);
    if (!engineId) throw new DOMException(`${model.name} cannot run on this device`, "NotSupportedError");
    const key = `${engineId}:${model.id}`;
    if (this.current && this.current.model.id === model.id && this.current.engine.id === engineId) return this.current.engine;
    if (this.loading?.key === key) {
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
      await engine.load(model, this.caps, (f) => listeners.forEach((l) => l(f)));
      this.current = { model, engine };
      this.setDownloaded(key, true);
      return engine;
    })();
    this.loading = { key, promise, listeners };
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

  async deleteModel(model: CatalogModel): Promise<void> {
    for (const id of ["transformers", "webllm", "wllama"] as EngineId[]) {
      if (!canRun(model, id, { webgpu: true, maxBufferMB: Infinity })) continue;
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

  /** FIFO: one local generation at a time. */
  async *exclusive<T, R>(run: () => AsyncGenerator<T, R>, idleMinutes: number): AsyncGenerator<T, R> {
    let release!: () => void;
    const turn = new Promise<void>((r) => (release = r));
    const prev = this.queue;
    this.queue = prev.then(() => turn);
    await prev.catch(() => {});
    this.active++;
    clearTimeout(this.idleTimer);
    try {
      return yield* run();
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
  ) {}

  describe() {
    return { name: this.model.name, backend: this.runtime.resolveEngine(this.model, this.pin) ?? "unavailable" };
  }

  async availability() {
    return this.runtime.availability(this.model, this.pin);
  }

  async prepare(onProgress?: (f: number) => void) {
    await this.runtime.ensure(this.model, this.pin, onProgress);
    this.runtime.touch(this.idleMinutes);
  }

  contextWindow() {
    return this.model.contextWindow;
  }

  params(): ModelParams {
    return DEFAULT_PARAMS;
  }

  async countTokens(messages: ChatMessage[]) {
    const engine = await this.runtime.ensure(this.model, this.pin);
    return engine.countTokens(messages);
  }

  generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, Usage> {
    const runtime = this.runtime;
    const model = this.model;
    const pin = this.pin;
    return runtime.exclusive(async function* () {
      const engine = await runtime.ensure(model, pin);
      return yield* engine.generate(messages, opts, signal);
    }, this.idleMinutes);
  }
}
