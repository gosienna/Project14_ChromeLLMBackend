// Raw request/response traces for the playground's raw view. Backends report what they sent;
// these helpers add what came back and shrink images and binary data before the trace is posted.

import { parseSSE } from "./adapters/sse";
import type { Adapter } from "./adapters/types";
import type { GenerateOptions, GenerateResult, Trace } from "./backend";

/** Raw stream events kept per cloud trace. */
const MAX_EVENTS = 500;
/** Strings longer than this that look like base64 (images) are replaced by a size note. */
const MAX_INLINE = 2000;

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

/** Copy of `v` with images, binary data and long base64 strings replaced by short placeholders. */
export function sanitizeTrace(v: unknown, depth = 0): unknown {
  if (depth > 40) return "…";
  if (typeof v === "string") {
    if (v.length > MAX_INLINE && /^(data:[\w/+.-]+;base64,)?[A-Za-z0-9+/=]+$/.test(v.slice(0, 4000))) return `<base64 · ${kb(v.length * 0.75)}>`;
    return v;
  }
  if (v instanceof ArrayBuffer) return `<binary · ${kb(v.byteLength)}>`;
  if (ArrayBuffer.isView(v)) return `<binary · ${kb(v.byteLength)}>`;
  if (typeof Blob !== "undefined" && v instanceof Blob) return `<blob · ${kb(v.size)}>`;
  if (Array.isArray(v)) return v.map((x) => sanitizeTrace(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x !== "function") out[k] = sanitizeTrace(x, depth + 1);
    return out;
  }
  return v;
}

/**
 * Wrap a generation so that, when tracing is on, the backend's reported request is completed with
 * the response (text, reasoning, tool calls, usage, or the error) and emitted once at the end.
 */
export function withResponseTrace(
  opts: GenerateOptions,
  run: (opts: GenerateOptions) => AsyncGenerator<string, GenerateResult>,
): AsyncGenerator<string, GenerateResult> {
  const emit = opts.onTrace;
  if (!emit) return run(opts);
  return (async function* () {
    let reported: Partial<Trace> = {};
    let text = "";
    let reasoning = "";
    let result: GenerateResult | undefined;
    let error: string | undefined;
    const inner: GenerateOptions = {
      ...opts,
      onTrace: (t) => (reported = { ...reported, ...t }),
      onReasoning: (r) => {
        reasoning += r;
        opts.onReasoning?.(r);
      },
    };
    try {
      const gen = run(inner);
      let step = await gen.next();
      while (!step.done) {
        text += step.value;
        yield step.value;
        step = await gen.next();
      }
      result = step.value;
      return result;
    } catch (e) {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw e;
    } finally {
      emit({
        engine: reported.engine ?? "unknown",
        request: reported.request,
        ...(reported.prompt ? { prompt: reported.prompt } : {}),
        response: { ...(reported.response as object), text, ...(reasoning ? { reasoning } : {}), ...result, ...(error ? { error } : {}) },
      });
    }
  })();
}

/** Trace a cloud adapter: the posted JSON body and the raw SSE events, via a fetch that records both. */
export function tracedAdapter(adapter: Adapter, engine: string): Adapter {
  return (cfg, messages, opts, signal, fetchImpl = fetch) => {
    if (!opts.onTrace) return adapter(cfg, messages, opts, signal, fetchImpl);
    return withResponseTrace(opts, (inner) => {
      const events: unknown[] = [];
      let collecting: Promise<void> = Promise.resolve();
      const recording = (async (url: string, init?: RequestInit) => {
        let request: unknown = init?.body;
        try {
          request = JSON.parse(String(init?.body));
        } catch {
          /* not JSON; keep as is */
        }
        inner.onTrace?.({ engine, request });
        const res = await fetchImpl(url, init);
        if (!res.ok || !res.body) return res;
        const [mine, copy] = res.body.tee();
        collecting = (async () => {
          for await (const ev of parseSSE(copy)) {
            if (events.length >= MAX_EVENTS) break;
            try {
              events.push(JSON.parse(ev.data));
            } catch {
              events.push(ev.data);
            }
          }
        })().catch(() => {});
        return new Response(mine, { status: res.status, headers: res.headers });
      }) as typeof fetch;
      return (async function* () {
        try {
          return yield* adapter(cfg, messages, inner, signal, recording);
        } finally {
          // The copy finishes with the stream; don't wait long if the read was cut short.
          await Promise.race([collecting, new Promise((r) => setTimeout(r, 200))]);
          inner.onTrace?.({ engine, response: { events } } as Trace);
        }
      })();
    });
  };
}
