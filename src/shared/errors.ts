// Errors crossing the extension boundary use the Prompt API's DOMException names.

export type LLMErrorName =
  | "AbortError"
  | "QuotaExceededError"
  | "NetworkError"
  | "NotAllowedError"
  | "NotSupportedError"
  | "InvalidStateError"
  | "OperationError"
  | "DataError";

export class LLMError extends Error {
  constructor(public override name: LLMErrorName, message: string) {
    super(message);
  }
}

export function toWireError(e: unknown): { name: string; message: string } {
  if (e instanceof LLMError) return { name: e.name, message: e.message };
  if (e instanceof DOMException) return { name: e.name, message: e.message };
  if (e instanceof Error && e.name === "AbortError") return { name: "AbortError", message: e.message };
  return { name: "OperationError", message: e instanceof Error ? e.message : String(e) };
}

/** Map an HTTP status from a cloud provider to a Prompt API error. */
export function httpError(status: number, body: string): LLMError {
  const detail = body.slice(0, 300);
  if (status === 401 || status === 403) return new LLMError("NotAllowedError", `Provider rejected the API key (${status}): ${detail}`);
  if (status === 429) return new LLMError("QuotaExceededError", `Provider rate limit or quota exceeded: ${detail}`);
  if (status === 400 || status === 413 || status === 422) return new LLMError("DataError", `Provider rejected the request (${status}): ${detail}`);
  return new LLMError("NetworkError", `Provider error ${status}: ${detail}`);
}

export function abortError(message = "The operation was aborted"): LLMError {
  return new LLMError("AbortError", message);
}
