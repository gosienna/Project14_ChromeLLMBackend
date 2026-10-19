// Offscreen host: owns the model. One WebGPU device, at most one loaded local model, the
// session map (chat history keyed by session id) and the generation loop. Streams tokens back
// to the service worker by request id. Shared by every tab and site.

import { toWireError, LLMError } from "../shared/errors";
import type { AdminOp, BackendSpec, FromHost, HostRequest, HostStatus, ToHost } from "../shared/host-protocol";
import { randomId, type ChatMessage, type DistributiveOmit, type PageResponse, type SessionInfo } from "../shared/protocol";
import type { Backend } from "./backend";
import { CloudBackend } from "./cloud-backend";
import { LocalBackend, LocalRuntime } from "./local-runtime";

declare const __VERSION__: string;

interface Session {
  id: string;
  origin: string;
  owner: string;
  backendId: string;
  backend: Backend;
  history: ChatMessage[];
  temperature: number;
  topK: number;
  quota: number;
  usage: number;
  running: Set<AbortController>;
  /** Prompts on one session run in order so history stays consistent. */
  chain: Promise<unknown>;
}

const runtime = new LocalRuntime();
const capsReady = runtime.probe();
const sessions = new Map<string, Session>();
const running = new Map<string, AbortController>();
let port: chrome.runtime.Port | null = null;
let busy = 0;

function post(msg: FromHost) {
  try {
    port?.postMessage(msg);
  } catch {
    /* worker restarting; it reconnects */
  }
}

const respond = (rid: string, res: DistributiveOmit<PageResponse, "id">, extra: Partial<Extract<FromHost, { type: "res" }>> = {}) =>
  post({ type: "res", rid, res: { ...res, id: rid } as PageResponse, ...extra });

function sessionCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sessions.values()) counts[s.origin] = (counts[s.origin] ?? 0) + 1;
  return counts;
}

const sessionsChanged = () => post({ type: "sessions", sessions: sessionCounts() });

// Keep the service worker alive while work is in flight (model downloads can be long and silent).
setInterval(() => {
  if (busy > 0 || runtime.downloadingKey) post({ type: "keepalive" });
}, 20_000);

function makeBackend(spec: BackendSpec, idleMinutes: number): Backend {
  return spec.kind === "local" ? new LocalBackend(runtime, spec.model, spec.engine, idleMinutes) : new CloudBackend(spec);
}

async function pickBackend(req: HostRequest): Promise<{ id: string; backend: Backend } | null> {
  await capsReady;
  for (const { id, spec } of req.backends ?? []) {
    const backend = makeBackend(spec, req.idleUnloadMinutes);
    if ((await backend.availability()) !== "unavailable") return { id, backend };
  }
  return null;
}

function getSession(req: HostRequest, sessionId: string): Session {
  const s = sessions.get(sessionId);
  // Sessions are bound to the origin that created them.
  if (!s || s.origin !== req.origin) throw new LLMError("InvalidStateError", "Unknown or destroyed session");
  // After a service worker restart the page reconnects under a new owner id.
  s.owner = req.owner;
  return s;
}

const info = (s: Session): SessionInfo => ({ sessionId: s.id, temperature: s.temperature, topK: s.topK, inputUsage: s.usage, inputQuota: s.quota });

function destroySession(s: Session) {
  for (const c of s.running) c.abort();
  sessions.delete(s.id);
}

/** Drop the oldest non-system turns until the conversation fits the quota. */
async function fitToQuota(s: Session, messages: ChatMessage[]): Promise<{ messages: ChatMessage[]; tokens: number }> {
  let msgs = messages;
  let tokens = await s.backend.countTokens(msgs);
  while (tokens > s.quota) {
    const i = msgs.findIndex((m, idx) => m.role !== "system" && idx < msgs.length - 1);
    if (i < 0) throw new LLMError("QuotaExceededError", `Input (${tokens} tokens) exceeds the session quota (${s.quota})`);
    msgs = msgs.filter((_, idx) => idx !== i);
    tokens = await s.backend.countTokens(msgs);
  }
  return { messages: msgs, tokens };
}

async function handle(req: HostRequest): Promise<void> {
  const { rid } = req;
  const r = req.req;
  switch (r.kind) {
    case "availability": {
      const picked = await pickBackend(req);
      return respond(rid, { kind: "result", value: picked ? await picked.backend.availability() : "unavailable" });
    }
    case "params": {
      const picked = await pickBackend(req);
      if (!picked) throw new LLMError("NotSupportedError", "No backend available");
      return respond(rid, { kind: "result", value: picked.backend.params() });
    }
    case "info": {
      const picked = await pickBackend(req);
      const d = picked?.backend.describe() ?? { name: "none", backend: "unavailable" };
      return respond(rid, { kind: "result", value: { ...d, version: __VERSION__ } });
    }
    case "create": {
      if ((sessionCounts()[req.origin] ?? 0) >= req.limits.maxSessions) {
        throw new LLMError("QuotaExceededError", `This site already has ${req.limits.maxSessions} open sessions; destroy one first`);
      }
      const picked = await pickBackend(req);
      if (!picked) throw new LLMError("NotSupportedError", "The model is unavailable on this device");
      const { backend } = picked;
      const controller = new AbortController();
      running.set(rid, controller);
      try {
        const progress = (f: number) => r.monitor && respond(rid, { kind: "progress", loaded: f });
        progress(0);
        await backend.prepare(progress);
        progress(1);
      } finally {
        running.delete(rid);
      }
      if (controller.signal.aborted) throw new LLMError("AbortError", "Aborted");
      const p = backend.params();
      const history = r.options.initialPrompts ?? [];
      const s: Session = {
        id: randomId(),
        origin: req.origin,
        owner: req.owner,
        backendId: picked.id,
        backend,
        history,
        temperature: r.options.temperature ?? p.defaultTemperature,
        topK: Math.min(r.options.topK ?? p.defaultTopK, p.maxTopK),
        quota: Math.min(backend.contextWindow(), req.limits.maxContext),
        usage: history.length ? await backend.countTokens(history) : 0,
        running: new Set(),
        chain: Promise.resolve(),
      };
      if (s.usage > s.quota) throw new LLMError("QuotaExceededError", "Initial prompts exceed the context window");
      sessions.set(s.id, s);
      sessionsChanged();
      return respond(rid, { kind: "result", value: info(s) }, { sessionBackend: s.backendId });
    }
    case "clone": {
      const src = getSession(req, r.sessionId);
      if ((sessionCounts()[req.origin] ?? 0) >= req.limits.maxSessions) {
        throw new LLMError("QuotaExceededError", "Too many open sessions for this site");
      }
      const s: Session = { ...src, id: randomId(), owner: req.owner, history: [...src.history], running: new Set(), chain: Promise.resolve() };
      sessions.set(s.id, s);
      sessionsChanged();
      return respond(rid, { kind: "result", value: info(s) }, { sessionBackend: s.backendId });
    }
    case "prompt": {
      const s = getSession(req, r.sessionId);
      const controller = new AbortController();
      running.set(rid, controller);
      s.running.add(controller);
      const run = async () => {
        if (controller.signal.aborted) throw new LLMError("AbortError", "Aborted");
        const { messages, tokens } = await fitToQuota(s, [...s.history, ...r.input]);
        const gen = s.backend.generate(messages, { temperature: s.temperature, topK: s.topK, maxTokens: Math.max(16, s.quota - tokens) }, controller.signal);
        let out = "";
        let step = await gen.next();
        while (!step.done) {
          out += step.value;
          respond(rid, { kind: "chunk", text: step.value });
          step = await gen.next();
        }
        const usage = step.value;
        s.history = [...messages, { role: "assistant", content: out }];
        s.usage = tokens + usage.outputTokens;
        respond(rid, { kind: "done", inputUsage: s.usage }, { usage: { ...usage, origin: s.origin, backendId: s.backendId } });
      };
      const p = s.chain.then(run, run);
      s.chain = p.catch(() => {});
      try {
        await p;
      } finally {
        running.delete(rid);
        s.running.delete(controller);
      }
      return;
    }
    case "append": {
      const s = getSession(req, r.sessionId);
      const { messages, tokens } = await fitToQuota(s, [...s.history, ...r.input]);
      s.history = messages;
      s.usage = tokens;
      return respond(rid, { kind: "result", value: s.usage });
    }
    case "measure": {
      const s = getSession(req, r.sessionId);
      return respond(rid, { kind: "result", value: await s.backend.countTokens(r.input) });
    }
    case "destroy": {
      const s = sessions.get(r.sessionId);
      if (s && s.origin === req.origin) {
        destroySession(s);
        sessionsChanged();
      }
      return;
    }
    case "abort":
      running.get(r.target)?.abort();
      return;
  }
}

async function handleAdmin(rid: string, op: AdminOp): Promise<unknown> {
  await capsReady;
  switch (op.op) {
    case "status": {
      const status: HostStatus = {
        caps: runtime.caps,
        loaded: runtime.loaded,
        downloading: runtime.downloadingKey,
        downloaded: runtime.downloaded(),
        sessions: sessionCounts(),
        crossOriginIsolated: self.crossOriginIsolated,
      };
      return status;
    }
    case "download":
      busy++;
      try {
        await runtime.ensure(op.model, op.engine, (loaded) => post({ type: "admin-progress", rid, loaded }));
        runtime.touch(10);
      } finally {
        busy--;
      }
      return runtime.loaded;
    case "deleteModel":
      await runtime.deleteModel(op.model);
      return null;
    case "unload":
      await runtime.unload();
      return null;
    case "revokeOrigin":
      for (const s of [...sessions.values()]) if (s.origin === op.origin) destroySession(s);
      sessionsChanged();
      return null;
    case "releaseOwner":
      for (const s of [...sessions.values()]) if (s.owner === op.owner) destroySession(s);
      sessionsChanged();
      return null;
  }
}

chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== "llm-host") return;
  port = p;
  p.onMessage.addListener((msg: ToHost) => {
    if (msg.type === "req") {
      busy++;
      handle(msg)
        .catch((e) => respond(msg.rid, { kind: "error", ...toWireError(e) }))
        .finally(() => busy--);
    } else if (msg.type === "admin") {
      handleAdmin(msg.rid, msg.admin).then(
        (value) => post({ type: "admin-res", rid: msg.rid, ok: true, value }),
        (e) => post({ type: "admin-res", rid: msg.rid, ok: false, error: String(e?.message ?? e) }),
      );
    }
  });
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
  });
  sessionsChanged();
});

chrome.runtime.sendMessage({ type: "host-ready" }).catch(() => {});
