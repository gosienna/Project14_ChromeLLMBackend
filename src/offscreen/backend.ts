// One contract for every backend, local or cloud: generate(messages, opts, signal).

import type { Availability, ChatMessage, ModelParams, ToolCall, ToolDecl, Usage } from "../shared/protocol";

export interface GenerateOptions {
  temperature: number;
  topK: number;
  maxTokens?: number;
  /** Reasoning models only: false asks the model to skip or shorten its thinking. */
  reasoning?: boolean;
  /** Receives a reasoning model's thinking, which is kept out of the yielded answer. */
  onReasoning?: (text: string) => void;
  /** Tools the model may call this turn (native backends; see tools/with-tools.ts for the rest). */
  tools?: ToolDecl[];
  /** Playground only: receives what was sent to the model and what came back, once per generation. */
  onTrace?: (trace: Trace) => void;
}

/** One generation as the model saw it: the exact request payload and the raw response. */
export interface Trace {
  /** Engine or provider that ran it, e.g. "wllama", "anthropic". */
  engine: string;
  /** The payload sent: a provider's JSON body (never headers, so never keys) or an engine's call arguments. */
  request: unknown;
  /** The rendered prompt string, where the engine exposes it (Transformers.js). */
  prompt?: string;
  /** What came back: text, reasoning, tool calls, usage, and raw stream events for cloud providers. */
  response?: unknown;
}

/** What a generation returns: token usage, plus any tool calls the model made instead of (or after) text. */
export type GenerateResult = Usage & { toolCalls?: ToolCall[] };

/**
 * "native": the backend's own tool API reads GenerateOptions.tools and returns toolCalls.
 * "prompted": tools are described in the prompt and calls parsed from the reply (tools/prompted.ts).
 */
export type ToolMode = "native" | "prompted";

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
  /** Prompt cap when it is smaller than the context window. Absent: the whole window may be input. */
  maxInput?(): number | undefined;
  /** Output cap when the model cannot fill the context still free. Absent means no extra cap. */
  maxOutput?(): number | undefined;
  /** Whether user turns may carry images. Cloud models that lack vision fail at the provider. */
  acceptsImages(): boolean;
  params(): ModelParams;
  countTokens(messages: ChatMessage[]): Promise<number>;
  toolMode(): ToolMode;
  /** Yields text deltas; returns token usage and tool calls. Must stop promptly when `signal` aborts. */
  generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, GenerateResult>;
}

export const DEFAULT_PARAMS: ModelParams = { defaultTopK: 3, maxTopK: 128, defaultTemperature: 0.5, maxTemperature: 2 };
