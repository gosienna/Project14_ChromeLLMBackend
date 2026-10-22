// Gives a session's backend tool calling. Native backends read GenerateOptions.tools themselves;
// for the rest, the conversation is rewritten with tool instructions and calls are parsed from
// the reply (prompted.ts).

import type { ChatMessage } from "../../shared/protocol";
import type { Backend, GenerateOptions, GenerateResult } from "../backend";
import { promptedMessages, ToolCallParser } from "./prompted";

export function withTools(backend: Backend): Backend {
  return backend.toolMode() === "native" ? backend : new PromptedTools(backend);
}

class PromptedTools implements Backend {
  constructor(private inner: Backend) {}

  get id() {
    return this.inner.id;
  }

  get kind() {
    return this.inner.kind;
  }

  describe() {
    return this.inner.describe();
  }

  availability() {
    return this.inner.availability();
  }

  prepare(onProgress?: (fraction: number) => void) {
    return this.inner.prepare(onProgress);
  }

  contextWindow() {
    return this.inner.contextWindow();
  }

  maxInput() {
    return this.inner.maxInput?.();
  }

  maxOutput() {
    return this.inner.maxOutput?.();
  }

  acceptsImages() {
    return this.inner.acceptsImages();
  }

  params() {
    return this.inner.params();
  }

  toolMode() {
    return "prompted" as const;
  }

  countTokens(messages: ChatMessage[]) {
    return this.inner.countTokens(promptedMessages(messages));
  }

  async *generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, GenerateResult> {
    const { tools, ...rest } = opts;
    // History may hold tool turns even when tools are withheld (the host's last round).
    const gen = this.inner.generate(promptedMessages(messages, tools), rest, signal);
    const parser = tools?.length ? new ToolCallParser(tools) : null;
    let step = await gen.next();
    while (!step.done) {
      const text = parser ? parser.push(step.value) : step.value;
      if (text) yield text;
      step = await gen.next();
    }
    if (!parser) return step.value;
    const { text, toolCalls } = parser.finish();
    if (text) yield text;
    return toolCalls.length ? { ...step.value, toolCalls } : step.value;
  }
}
