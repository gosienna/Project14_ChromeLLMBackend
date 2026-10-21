// Cloud backend: same Backend contract as local engines, using the user's own API key.

import type { BackendSpec } from "../shared/host-protocol";
import { UNLISTED_CONTEXT, findCloudModel, takesCloudImages, type CloudModel } from "../shared/cloud-models";
import { estimateMessageTokens, type ChatMessage, type ModelParams } from "../shared/protocol";
import type { AdapterKind } from "../shared/providers";
import { anthropicAdapter } from "./adapters/anthropic";
import { geminiAdapter } from "./adapters/gemini";
import { openAICompatAdapter } from "./adapters/openai-compat";
import type { Adapter } from "./adapters/types";
import type { Backend, GenerateOptions, GenerateResult } from "./backend";
import { tracedAdapter } from "./trace";

const ADAPTERS: Record<AdapterKind, Adapter> = {
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  "openai-compat": openAICompatAdapter,
};

export class CloudBackend implements Backend {
  readonly kind = "cloud" as const;
  readonly id: string;
  private info?: CloudModel;

  constructor(private spec: Extract<BackendSpec, { kind: "cloud" }>) {
    this.id = spec.provider.id;
    this.info = findCloudModel(spec.provider.id, spec.model);
  }

  describe() {
    return { name: this.spec.model, backend: this.spec.provider.name };
  }

  async availability() {
    return "available" as const;
  }

  async prepare() {}

  contextWindow() {
    return this.info?.contextWindow ?? UNLISTED_CONTEXT;
  }

  acceptsImages() {
    return this.info ? takesCloudImages(this.info) : true;
  }

  toolMode() {
    return this.info?.tools ?? "native";
  }

  params(): ModelParams {
    return { defaultTopK: 40, maxTopK: 128, defaultTemperature: 0.5, maxTemperature: 2 };
  }

  async countTokens(messages: ChatMessage[]) {
    return estimateMessageTokens(messages);
  }

  generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, GenerateResult> {
    const { provider, model, apiKey } = this.spec;
    return tracedAdapter(ADAPTERS[provider.adapter], provider.id)({ provider, model, apiKey }, messages, opts, signal);
  }
}
