// Isolated-world content script relay: page <-> extension.
// Accepts one MessageChannel handshake from its own window, checks the per-page nonce and the
// message schema, and forwards requests over a long-lived chrome.runtime port. The service
// worker derives the origin from the port sender, never from message contents.

import { parsePageRequest, parsePageResponse, type PageRequest } from "../shared/protocol";

export interface BridgeEnvelope {
  req: PageRequest;
  /** Observed by the content script, not claimed by the page. */
  visible: boolean;
}

(() => {
  let pagePort: MessagePort | null = null;
  let nonce = "";
  let runtimePort: chrome.runtime.Port | null = null;
  const inFlight = new Set<string>();

  function toPage(msg: object) {
    pagePort?.postMessage({ ...msg, nonce });
  }

  function connect(): chrome.runtime.Port {
    if (runtimePort) return runtimePort;
    const p = chrome.runtime.connect({ name: "llm-page" });
    p.onMessage.addListener((raw) => {
      const res = parsePageResponse(raw);
      if (!res) return;
      if (res.kind === "result" || res.kind === "error" || res.kind === "done") inFlight.delete(res.id);
      toPage(res);
    });
    p.onDisconnect.addListener(() => {
      runtimePort = null;
      for (const id of inFlight) toPage({ kind: "error", id, name: "OperationError", message: "The extension disconnected; retry the request" });
      inFlight.clear();
    });
    runtimePort = p;
    return p;
  }

  function onPageMessage(ev: MessageEvent) {
    const data = ev.data as { nonce?: unknown; msg?: unknown };
    if (!data || data.nonce !== nonce) return;
    const req = parsePageRequest(data.msg);
    if (!req) return; // drop unknown or malformed messages
    if (req.kind !== "abort" && req.kind !== "destroy") inFlight.add(req.id);
    const envelope: BridgeEnvelope = { req, visible: document.visibilityState === "visible" };
    try {
      connect().postMessage(envelope);
    } catch {
      runtimePort = null;
      inFlight.delete(req.id);
      toPage({ kind: "error", id: req.id, name: "OperationError", message: "The extension is unavailable" });
    }
  }

  window.addEventListener("message", (ev) => {
    if (pagePort || ev.source !== window || ev.origin !== location.origin) return;
    const data = ev.data as { __localLLM?: unknown; nonce?: unknown };
    if (data?.__localLLM !== "hello" || typeof data.nonce !== "string" || !/^[0-9a-f]{32}$/.test(data.nonce)) return;
    const port = ev.ports[0];
    if (!port) return;
    pagePort = port;
    nonce = data.nonce;
    port.onmessage = onPageMessage;
    toPage({ kind: "hello-ack" });
  });

  window.postMessage({ __localLLM: "bridge-ready" }, location.origin);
})();
