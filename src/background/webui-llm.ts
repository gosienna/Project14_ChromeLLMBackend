// Web-chat LLM backends: open the provider site in a minimized window, submit the prompt with
// chrome.scripting, poll for the assistant reply, then close the window. One generation at a time.

import { LLMError } from "../shared/errors";
import {
  chatgptFillAndSend,
  chatgptRead,
  claudeFillAndSend,
  claudeRead,
  geminiFillAndSend,
  geminiRead,
  type WebUiBlocked,
  type WebUiDriverId,
  type WebUiOk,
  type WebUiRead,
} from "../shared/webui-drivers";
import { findWebUiProvider, type WebUiProviderDef } from "../shared/webui-providers";

const LOAD_TIMEOUT_MS = 30_000;
const GENERATE_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 500;
const STABLE_POLLS = 3;

export interface WebUiGenerateOpts {
  providerId: string;
  prompt: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface WebUiGenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

type FillFn = (prompt: string) => WebUiBlocked | WebUiOk;
type ReadFn = () => WebUiBlocked | WebUiRead;

const DRIVERS: Record<WebUiDriverId, { fill: FillFn; read: ReadFn }> = {
  "chatgpt-web": { fill: chatgptFillAndSend, read: chatgptRead },
  "gemini-web": { fill: geminiFillAndSend, read: geminiRead },
  "claude-web": { fill: claudeFillAndSend, read: claudeRead },
};

let queue: Promise<unknown> = Promise.resolve();

/** Test hook: when set, skip the real window and return this text for every prompt. */
let stub: ((prompt: string, providerId: string) => string | Promise<string>) | null = null;

export function setWebUiStub(fn: ((prompt: string, providerId: string) => string | Promise<string>) | null) {
  stub = fn;
}

export async function webuiPermitted(providerId: string): Promise<boolean> {
  if (stub) return true; // e2e stub: never open a real provider tab
  const p = findWebUiProvider(providerId);
  if (!p) return false;
  return chrome.permissions.contains({ origins: [p.hostPattern] });
}

export function webuiGenerate(opts: WebUiGenerateOpts): Promise<WebUiGenerateResult> {
  const run = queue.then(() => generateNow(opts));
  queue = run.catch(() => {});
  return run;
}

async function generateNow(opts: WebUiGenerateOpts): Promise<WebUiGenerateResult> {
  const prompt = opts.prompt.trim();
  if (!prompt) throw new LLMError("DataError", "web chat prompt is empty");
  const provider = findWebUiProvider(opts.providerId);
  if (!provider) throw new LLMError("NotSupportedError", `Unknown web chat backend ${opts.providerId}`);
  if (stub) {
    const text = await stub(prompt, opts.providerId);
    opts.onDelta?.(text);
    return { text, inputTokens: estimate(prompt), outputTokens: estimate(text) };
  }
  if (!(await webuiPermitted(opts.providerId))) {
    throw new LLMError("NotAllowedError", `Host permission for ${provider.name} has not been granted`);
  }
  throwIfAborted(opts.signal);
  return runInWindow(provider, prompt, opts.signal, opts.onDelta);
}

async function runInWindow(
  provider: WebUiProviderDef,
  prompt: string,
  signal: AbortSignal | undefined,
  onDelta?: (text: string) => void,
): Promise<WebUiGenerateResult> {
  const driver = DRIVERS[provider.id as WebUiDriverId];
  if (!driver) throw new LLMError("NotSupportedError", `No driver for ${provider.id}`);

  const win = await chrome.windows.create({
    url: provider.startUrl,
    state: "minimized",
    focused: false,
    type: "normal",
  });
  const tabId = win?.tabs?.[0]?.id;
  try {
    if (tabId === undefined) throw new LLMError("OperationError", `Could not open a ${provider.name} window`);
    await loaded(tabId, signal);
    throwIfAborted(signal);

    const [fillRes] = await chrome.scripting.executeScript({
      target: { tabId },
      func: driver.fill,
      args: [prompt],
    });
    const filled = fillRes?.result as WebUiBlocked | WebUiOk | undefined;
    if (!filled || filled.blocked) {
      throw new LLMError(
        "NetworkError",
        `${provider.name} needs a signed-in Chrome session (or the page layout changed). Open ${provider.startUrl} once in Chrome and try again.`,
      );
    }

    const started = Date.now();
    let last = "";
    let stable = 0;
    while (Date.now() - started < GENERATE_TIMEOUT_MS) {
      throwIfAborted(signal);
      await sleep(POLL_MS, signal);
      const [readRes] = await chrome.scripting.executeScript({ target: { tabId }, func: driver.read });
      const read = readRes?.result as WebUiBlocked | WebUiRead | undefined;
      if (!read || read.blocked) {
        throw new LLMError(
          "NetworkError",
          `${provider.name} asked for verification or sign-in. Open ${provider.startUrl} once in Chrome and try again.`,
        );
      }
      if (read.text !== last) {
        last = read.text;
        stable = 0;
        onDelta?.(last);
      } else if (read.text) {
        stable++;
      }
      if (read.done && stable >= STABLE_POLLS) break;
    }
    if (!last) {
      throw new LLMError("NetworkError", `${provider.name} did not return a reply in time`);
    }
    return { text: last, inputTokens: estimate(prompt), outputTokens: estimate(last) };
  } finally {
    if (win?.id !== undefined) await chrome.windows.remove(win.id).catch(() => {});
  }
}

function estimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new LLMError("AbortError", "The operation was aborted");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LLMError("AbortError", "The operation was aborted"));
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new LLMError("AbortError", "The operation was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function loaded(tabId: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      done();
      reject(new LLMError("NetworkError", "Web chat page did not load in time"));
    }, LOAD_TIMEOUT_MS);
    const onAbort = () => {
      done();
      reject(new LLMError("AbortError", "The operation was aborted"));
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") {
        done();
        resolve();
      }
    };
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      signal?.removeEventListener("abort", onAbort);
    };
    chrome.tabs.onUpdated.addListener(listener);
    signal?.addEventListener("abort", onAbort, { once: true });
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") {
        done();
        resolve();
      }
    }, () => {});
  });
}
