// Web-chat backend: sessions stay in the host; generation is delegated to the service worker,
// which owns chrome.windows / chrome.scripting.

import type { BackendSpec } from "../shared/host-protocol";
import { estimateMessageTokens, type ChatMessage, type ModelParams } from "../shared/protocol";
import { flattenWebUiPrompt } from "../shared/webui-prompt";
import type { Backend, GenerateOptions, GenerateResult } from "./backend";
import { DEFAULT_PARAMS } from "./backend";

type WebUiRunner = (
  providerId: string,
  prompt: string,
  signal: AbortSignal,
  onDelta: (fullText: string) => void,
) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

/** Injected by host.ts so this module does not talk to chrome.runtime itself. */
let runner: WebUiRunner | null = null;

export function setWebUiRunner(fn: WebUiRunner) {
  runner = fn;
}

export class WebUiBackend implements Backend {
  readonly kind = "webui" as const;
  readonly id: string;

  constructor(private spec: Extract<BackendSpec, { kind: "webui" }>) {
    this.id = spec.providerId;
  }

  describe() {
    return { name: this.spec.model, backend: this.spec.name };
  }

  async availability() {
    return "available" as const;
  }

  async prepare() {}

  contextWindow() {
    return this.spec.contextWindow;
  }

  acceptsImages() {
    return false;
  }

  toolMode() {
    return "prompted" as const;
  }

  params(): ModelParams {
    return DEFAULT_PARAMS;
  }

  async countTokens(messages: ChatMessage[]) {
    return estimateMessageTokens(messages);
  }

  generate(messages: ChatMessage[], opts: GenerateOptions, signal: AbortSignal): AsyncGenerator<string, GenerateResult> {
    if (!runner) throw new Error("Web UI runner is not wired");
    const prompt = flattenWebUiPrompt(messages);
    opts.onTrace?.({ engine: this.spec.providerId, request: { prompt } });
    const run = runner;
    const providerId = this.spec.providerId;
    return streamWebUi(async (onDelta) => {
      const result = await run(providerId, prompt, signal, onDelta);
      opts.onTrace?.({ engine: providerId, request: { prompt }, response: { text: result.text } });
      return result;
    });
  }
}

/** Yield progressive text suffixes while a push-based run completes. */
export async function* streamWebUi(
  run: (onDelta: (full: string) => void) => Promise<{ text: string; inputTokens: number; outputTokens: number }>,
): AsyncGenerator<string, GenerateResult> {
  let emitted = 0;
  let pending = "";
  let hasPending = false;
  let notify: (() => void) | null = null;
  let finished: { text: string; inputTokens: number; outputTokens: number } | null = null;
  let failed: unknown = null;

  const wake = () => {
    notify?.();
    notify = null;
  };

  const work = run((full) => {
    pending = full;
    hasPending = true;
    wake();
  }).then(
    (r) => {
      finished = r;
      pending = r.text;
      hasPending = true;
      wake();
    },
    (e) => {
      failed = e;
      wake();
    },
  );

  while (!finished && !failed) {
    if (hasPending && pending.length > emitted) {
      const next = pending.slice(emitted);
      emitted = pending.length;
      hasPending = false;
      yield next;
      continue;
    }
    await new Promise<void>((r) => {
      notify = r;
    });
  }
  await work;
  if (failed) throw failed;
  if (hasPending && pending.length > emitted) yield pending.slice(emitted);
  return { inputTokens: finished!.inputTokens, outputTokens: finished!.outputTokens };
}
