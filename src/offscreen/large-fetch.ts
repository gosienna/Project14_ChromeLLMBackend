// Chrome fails a single fetch whose body is larger than 2 GiB (signed 32-bit length).
// MedGemma 27B Q4 is about 15 GiB in one GGUF, so that fetch dies before any byte is stored.
// A HEAD still reports the real size. Above the limit, the body is read as Range slices.

/** Largest body Chrome will deliver from one response. */
export const CHROME_SINGLE_BODY_MAX = 2 ** 31 - 1;

/** Each Range stays well under that limit. */
export const RANGE_BYTES = 512 * 2 ** 20;

const GGUF = /\.gguf$/i;

export function isGgufUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    const hf = host === "huggingface.co" || host.endsWith(".hf.co") || host.endsWith(".huggingface.co");
    return hf && GGUF.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function headerValue(input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return headers.get(name);
}

function mergedHeaders(input: RequestInfo | URL, init: RequestInit | undefined, range: string): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  headers.set("Range", range);
  return headers;
}

/** Bytes declared by a HEAD or a 206 Content-Range, or 0 when the host did not say. */
export function declaredSize(res: Response): number {
  const range = res.headers.get("content-range");
  const total = range?.match(/\/(\d+)\s*$/)?.[1];
  const raw = total ?? res.headers.get("x-linked-size") ?? (res.status === 206 ? null : res.headers.get("content-length"));
  const n = Number(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function rangedStream(base: typeof fetch, url: string, total: number, input: RequestInfo | URL, init: RequestInit | undefined, rangeBytes: number): ReadableStream<Uint8Array> {
  let offset = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (!reader) {
          if (offset >= total) {
            controller.close();
            return;
          }
          const end = Math.min(total, offset + rangeBytes) - 1;
          const res = await base(url, { signal, headers: mergedHeaders(input, init, `bytes=${offset}-${end}`) });
          if (res.status === 200) {
            await res.body?.cancel();
            throw new Error("The file host ignored the range request, so this model cannot be downloaded.");
          }
          if (res.status !== 206 || !res.body) {
            throw new Error(`Download failed at byte ${offset} of ${total}: HTTP ${res.status}`);
          }
          reader = res.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        offset += value.byteLength;
        controller.enqueue(value);
        return;
      }
    },
    cancel() {
      return reader?.cancel();
    },
  });
}

export interface LargeFetchLimits {
  maxSingleBody?: number;
  rangeBytes?: number;
}

/**
 * Fetch `input`. A GGUF larger than Chrome's single-response limit comes back as one stream
 * stitched from Range requests. Anything else is `base` unchanged.
 */
export async function fetchMaybeRanged(input: RequestInfo | URL, init: RequestInit | undefined, base: typeof fetch, limits: LargeFetchLimits = {}): Promise<Response> {
  const maxSingleBody = limits.maxSingleBody ?? CHROME_SINGLE_BODY_MAX;
  const rangeBytes = limits.rangeBytes ?? RANGE_BYTES;
  const url = requestUrl(input);
  const method = methodOf(input, init);
  if (!isGgufUrl(url) || (method !== "GET" && method !== "HEAD") || headerValue(input, init, "range")) {
    return base(input, init);
  }

  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  let total = 0;
  let head: Response | null = null;
  try {
    head = await base(url, { method: "HEAD", signal });
    total = declaredSize(head);
  } catch {
    head = null;
  }
  if (!total) {
    try {
      const probe = await base(url, { signal, headers: mergedHeaders(input, init, "bytes=0-0") });
      total = declaredSize(probe);
      await probe.body?.cancel();
    } catch {
      total = 0;
    }
  }
  if (!total || total <= maxSingleBody) {
    if (method === "HEAD" && head) return head;
    return base(input, init);
  }

  const headers = new Headers({ "content-length": String(total), "accept-ranges": "bytes" });
  if (method === "HEAD") return new Response(null, { status: 200, headers });
  console.info(`[download] ${Math.ceil(total / rangeBytes)} ranges for ${total} bytes`);
  return new Response(rangedStream(base, url, total, input, init, rangeBytes), { status: 200, headers });
}

let installed = false;

/** Replace global fetch once, in the offscreen host, before any model download. */
export function installLargeFetch(): void {
  if (installed) return;
  installed = true;
  const base = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => fetchMaybeRanged(input, init, base);
}
