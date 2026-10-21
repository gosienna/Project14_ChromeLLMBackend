// Abort that does not depend on the engine cooperating. A wedged engine (a stalled wasm
// worker, a GPU hang) may never notice its signal; these helpers stop waiting for it anyway.

import { abortError } from "../shared/errors";

/** Resolves when `signal` aborts. */
function whenAborted(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

/** `promise`, or AbortError as soon as `signal` aborts. */
export async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const first = await Promise.race([promise, whenAborted(signal)]);
  if (first === "aborted" && signal.aborted) throw abortError();
  return first as T;
}

/**
 * Relays `gen`, throwing AbortError as soon as `signal` aborts instead of waiting for `gen` to
 * notice. If `gen` hasn't settled `graceMs` after the abort, it is taken to be stuck and
 * `onStuck` runs (e.g. unloading the engine) before the AbortError is thrown.
 */
export async function* untilAborted<T, R>(gen: AsyncGenerator<T, R>, signal: AbortSignal, graceMs: number, onStuck: () => Promise<void>): AsyncGenerator<T, R> {
  const aborted = whenAborted(signal);
  let finished = false;
  try {
    while (true) {
      const step = gen.next();
      const first = await Promise.race([step, aborted]);
      if (first === "aborted") {
        const settled = step.then(() => "settled" as const, () => "settled" as const);
        const timeout = new Promise<"stuck">((r) => setTimeout(() => r("stuck"), graceMs));
        if ((await Promise.race([settled, timeout])) === "stuck") await onStuck();
        throw abortError();
      }
      if (first.done) {
        finished = true;
        return first.value;
      }
      yield first.value;
    }
  } finally {
    // Let the engine run its own cleanup, without waiting on an engine that may never answer.
    if (!finished) void gen.return(undefined as R).catch(() => {});
  }
}
