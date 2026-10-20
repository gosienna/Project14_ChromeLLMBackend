import type { CatalogModel, DeviceCaps, EngineId } from "../../shared/catalog";
import type { ChatMessage } from "../../shared/protocol";
import type { GenerateOptions, GenerateResult } from "../backend";

/** An in-browser inference engine. Only one is loaded at a time, in the offscreen host. */
export interface LocalEngine {
  readonly id: EngineId;
  load(model: CatalogModel, caps: DeviceCaps, onProgress: (fraction: number) => void): Promise<void>;
  unload(): Promise<void>;
  countTokens(messages: ChatMessage[]): Promise<number>;
  generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, GenerateResult>;
  /** Delete this model's cached weights. */
  deleteCache(model: CatalogModel): Promise<void>;
}

export const vendorUrl = (path: string) => chrome.runtime.getURL(`vendor/${path}`);
