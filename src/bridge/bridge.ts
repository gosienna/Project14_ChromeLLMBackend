// Isolated-world content script relay: page <-> extension.
// Accepts one MessageChannel handshake from its own window, checks the per-page nonce and the
// message schema, and forwards requests over a long-lived chrome.runtime port. The service
// worker derives the origin from the port sender, never from message contents.

import { parsePageRequest, parsePageResponse, parsePortNotice, type PageRequest } from "../shared/protocol";

export interface BridgeEnvelope {
  req: PageRequest;
  /** Observed by the content script, not claimed by the page. */
  visible: boolean;
}

/** How long a new port may go without the router's `connected` before it is given up. */
const CONNECT_TIMEOUT_MS = 5_000;

/** Why the port closed, as the page's `localllm:closed` event reports it. */
type CloseReason = "idle" | "disconnected" | "unresponsive";

const CLOSE_MESSAGES: Record<CloseReason, string> = {
  idle: "The model service closed after being idle; retry the request",
  disconnected: "The extension disconnected; retry the request",
  unresponsive: "The extension did not answer; reload the page",
};

(() => {
  let pagePort: MessagePort | null = null;
  let nonce = "";
  let runtimePort: chrome.runtime.Port | null = null;
  const inFlight = new Set<string>();

  function toPage(msg: object) {
    pagePort?.postMessage({ ...msg, nonce });
  }

  /** The port is gone: fail what it carried and tell the page. The next request opens a new one. */
  function closed(p: chrome.runtime.Port, reason: CloseReason) {
    if (p !== runtimePort) return;
    runtimePort = null;
    for (const id of inFlight) toPage({ kind: "error", id, name: "OperationError", message: CLOSE_MESSAGES[reason] });
    inFlight.clear();
    toPage({ kind: "closed", reason });
  }

  function connect(): chrome.runtime.Port {
    if (runtimePort) return runtimePort;
    const p = chrome.runtime.connect({ name: "llm-page" });
    let reason: CloseReason = "disconnected";
    const unanswered = setTimeout(() => {
      closed(p, "unresponsive");
      p.disconnect();
    }, CONNECT_TIMEOUT_MS);
    p.onMessage.addListener((raw) => {
      const notice = parsePortNotice(raw);
      if (notice?.kind === "connected") return clearTimeout(unanswered);
      if (notice?.kind === "closed") {
        reason = notice.reason;
        return;
      }
      const res = parsePageResponse(raw);
      if (!res) return;
      if (res.kind === "result" || res.kind === "error" || res.kind === "done") inFlight.delete(res.id);
      toPage(res);
    });
    p.onDisconnect.addListener(() => {
      clearTimeout(unanswered);
      closed(p, reason);
    });
    runtimePort = p;
    return p;
  }

  function onPageMessage(ev: MessageEvent) {
    const data = ev.data as { nonce?: unknown; msg?: unknown };
    if (!data || data.nonce !== nonce) return;
    const req = parsePageRequest(data.msg);
    if (!req) return; // drop unknown or malformed messages
    // abort, destroy and tool-result get no reply of their own.
    if (req.kind !== "abort" && req.kind !== "destroy" && req.kind !== "tool-result") inFlight.add(req.id);
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
