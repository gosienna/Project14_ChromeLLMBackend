// One contract for every backend, local or cloud: generate(messages, opts, signal).

import type { Availability, ChatMessage, ModelParams, Usage } from "../shared/protocol";

export interface GenerateOptions {
  temperature: number;
  topK: number;
  maxTokens?: number;
}

export interface Backend {
  /** Backend id for the usage log: "local" or a provider id. */
  readonly id: string;
  readonly kind: "local" | "cloud";
  /** Model and engine/provider names reported by window.localLLM.info(). */
  describe(): { name: string; backend: string };
  availability(): Promise<Availability>;
  /** Load or download what is needed. Progress is a fraction 0..1. */
  prepare(onProgress?: (fraction: number) => void): Promise<void>;
  contextWindow(): number;
  params(): ModelParams;
  countTokens(messages: ChatMessage[]): Promise<number>;
  /** Yields text deltas; returns token usage. Must stop promptly when `signal` aborts. */
  generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, Usage>;
}

export const DEFAULT_PARAMS: ModelParams = { defaultTopK: 3, maxTopK: 128, defaultTemperature: 1, maxTemperature: 2 };
