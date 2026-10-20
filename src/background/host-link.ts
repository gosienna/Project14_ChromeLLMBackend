// Ensures the offscreen host exists and keeps a port to it. The host owns the model; the
// service worker only routes. If the host is gone (crash, idle close), it is recreated.

import type { FromHost, ToHost } from "../shared/host-protocol";

const HOST_URL = "offscreen/host.html";

let port: chrome.runtime.Port | null = null;
let connecting: Promise<chrome.runtime.Port> | null = null;
const listeners = new Set<(msg: FromHost) => void>();
const disconnectListeners = new Set<() => void>();
let readyWaiter: (() => void) | null = null;

export function onHostMessage(fn: (msg: FromHost) => void) {
  listeners.add(fn);
}

export function onHostDisconnect(fn: () => void) {
  disconnectListeners.add(fn);
}

/** Called by router.ts when the host announces it has loaded. */
export function hostReady() {
  readyWaiter?.();
  readyWaiter = null;
}

export async function hostExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(HOST_URL)],
  });
  return contexts.length > 0;
}

async function createHost(): Promise<void> {
  const ready = new Promise<void>((resolve) => (readyWaiter = resolve));
  try {
    await chrome.offscreen.createDocument({
      url: HOST_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Hosts the on-device language model runtime (WebGPU/WASM) shared by every approved site",
    });
  } catch (e) {
    // Another call created it concurrently.
    if (!String(e).includes("single offscreen")) throw e;
    readyWaiter = null;
    return;
  }
  await ready;
}

async function connect(): Promise<chrome.runtime.Port> {
  if (!(await hostExists())) await createHost();
  const p = chrome.runtime.connect({ name: "llm-host" });
  p.onMessage.addListener((msg: FromHost) => listeners.forEach((fn) => fn(msg)));
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
    disconnectListeners.forEach((fn) => fn());
  });
  port = p;
  return p;
}

export async function hostPort(): Promise<chrome.runtime.Port> {
  if (port) return port;
  connecting ??= connect().finally(() => (connecting = null));
  return connecting;
}

export async function sendToHost(msg: ToHost): Promise<void> {
  const p = await hostPort();
  try {
    p.postMessage(msg);
  } catch {
    port = null;
    (await hostPort()).postMessage(msg);
  }
}

export async function closeHost(): Promise<void> {
  port?.disconnect();
  port = null;
  if (await hostExists()) await chrome.offscreen.closeDocument();
}
