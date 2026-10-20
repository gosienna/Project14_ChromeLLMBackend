import { abortError, httpError, LLMError } from "../../shared/errors";
import type { ChatMessage, ImageInput } from "../../shared/protocol";
import type { ProviderDef } from "../../shared/providers";
import type { GenerateOptions, GenerateResult } from "../backend";

export interface AdapterConfig {
  provider: ProviderDef;
  model: string;
  apiKey: string;
}

/** Provider adapter: Prompt API messages in, text deltas out, usage and tool calls returned. */
export type Adapter = (
  cfg: AdapterConfig,
  messages: ChatMessage[],
  opts: GenerateOptions,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
) => AsyncGenerator<string, GenerateResult>;

export async function post(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal.aborted) throw abortError();
    throw new LLMError("NetworkError", `Could not reach ${new URL(url).host}: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));
  if (!res.body) throw new LLMError("NetworkError", "Empty response body");
  return res;
}

export function splitSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  return { system, rest: messages.filter((m) => m.role !== "system") };
}

export const dataUrl = (img: ImageInput) => `data:${img.mimeType};base64,${img.data}`;

/** Wrap the adapter's stream so aborts surface as AbortError rather than fetch internals. */
export async function* guard<R>(signal: AbortSignal, gen: AsyncGenerator<string, R>): AsyncGenerator<string, R> {
  try {
    const r = yield* gen;
    if (signal.aborted) throw abortError();
    return r;
  } catch (e) {
    if (signal.aborted) throw abortError();
    throw e;
  }
}
