// Cloud backend: same Backend contract as local engines, using the user's own API key.

import type { BackendSpec } from "../shared/host-protocol";
import { estimateMessageTokens, type ChatMessage, type ModelParams, type Usage } from "../shared/protocol";
import type { AdapterKind } from "../shared/providers";
import { anthropicAdapter } from "./adapters/anthropic";
import { geminiAdapter } from "./adapters/gemini";
import { openAICompatAdapter } from "./adapters/openai-compat";
import type { Adapter } from "./adapters/types";
import type { Backend, GenerateOptions } from "./backend";

const ADAPTERS: Record<AdapterKind, Adapter> = {
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  "openai-compat": openAICompatAdapter,
};

const CLOUD_CONTEXT = 128_000;

export class CloudBackend implements Backend {
  readonly kind = "cloud" as const;
  readonly id: string;

  constructor(private spec: Extract<BackendSpec, { kind: "cloud" }>) {
    this.id = spec.provider.id;
  }

  describe() {
    return { name: this.spec.model, backend: this.spec.provider.name };
  }

  async availability() {
    return "available" as const;
  }

  async prepare() {}

  contextWindow() {
    return CLOUD_CONTEXT;
  }

  params(): ModelParams {
    return { defaultTopK: 40, maxTopK: 128, defaultTemperature: 1, maxTemperature: 2 };
  }

  async countTokens(messages: ChatMessage[]) {
    return estimateMessageTokens(messages);
  }

  generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, Usage> {
    const { provider, model, apiKey } = this.spec;
    return ADAPTERS[provider.adapter]({ provider, model, apiKey }, messages, opts, signal);
  }
}
