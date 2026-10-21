// Service worker: the trust boundary. Reads the caller's origin from port.sender.origin only,
// applies the consent gate, rate limits and spend caps, ensures the offscreen host exists, and
// routes requests to it. Pages never see keys, other tabs or anything but model output.

import type { BridgeEnvelope } from "../bridge/bridge";
import { findModel, type EngineId } from "../shared/catalog";
import { LLMError, toWireError } from "../shared/errors";
import type { AdminOp, BackendSpec, FromHost, HostRequest, HostStatus } from "../shared/host-protocol";
import { getKey } from "../shared/keystore";
import {
  estimateMessageTokens,
  estimateTokens,
  parsePageRequest,
  type ModelInfo,
  type PageRequest,
  type PageRequestKind,
  type PageResponse,
  type PlaygroundEnvelope,
} from "../shared/protocol";
import {
  appendUsage,
  defaultSite,
  findProvider,
  getSettings,
  getSite,
  getUsage,
  originPattern,
  updateSite,
  type Settings,
  type SiteConfig,
  type UsageEntry,
} from "../shared/settings";
import { askConsent, clearOnceGrants, getConsentRequest, hasOnceGrant, onWindowClosed, settle, type Decision } from "./consent";
import { hostReady, onHostDisconnect, onHostMessage, sendToHost } from "./host-link";
import { TokenRateLimiter, exceedsDailyTokenCap, providerTokensThisMonth, siteTokensToday } from "./limits";
import { configuredLocalModel, listModels, parseModelId } from "./models";
import { consentAvailability, deliversTo, gate } from "./policy";
import { isPermitted, syncRegistrations } from "./registration";

declare const __TEST__: boolean;

// ---- Page connections -----------------------------------------------------

interface PageConn {
  key: string;
  port: chrome.runtime.Port;
  origin: string;
  tabId: number;
}

interface InFlight {
  conn: PageConn;
  id: string;
}

const conns = new Map<string, PageConn>();
const inFlight = new Map<string, InFlight>();
/** sessionId -> backend id, for spend caps. Rebuilt lazily after a worker restart. */
const sessionBackends = new Map<string, string>();
const limiter = new TokenRateLimiter();
let connCounter = 0;
// Unique across worker restarts, since the host outlives the worker.
const bootId = Date.now().toString(36);

const rid = (conn: PageConn, id: string) => `${conn.key}.${id}`;

function reply(conn: PageConn, res: PageResponse) {
  try {
    conn.port.postMessage(res);
  } catch {
    /* page went away */
  }
}

function replyError(conn: PageConn, id: string, e: unknown) {
  reply(conn, { kind: "error", id, ...toWireError(e) });
}

function openConn(port: chrome.runtime.Port, origin: string, tabId: number, onMessage: (conn: PageConn, raw: unknown) => void) {
  const conn: PageConn = { key: `c${bootId}${++connCounter}`, port, origin, tabId };
  conns.set(conn.key, conn);
  port.onMessage.addListener((raw) => onMessage(conn, raw));
  port.onDisconnect.addListener(() => {
    conns.delete(conn.key);
    for (const [k, f] of inFlight) if (f.conn === conn) inFlight.delete(k);
    sendToHost({ type: "admin", rid: `release-${conn.key}`, admin: { op: "releaseOwner", owner: conn.key } }).catch(() => {});
  });
}

const PLAYGROUND_URL = chrome.runtime.getURL("ui/playground.html");
const PLAYGROUND_ORIGIN = new URL(PLAYGROUND_URL).origin;
const PLAYGROUND_KINDS = new Set<PageRequestKind>(["availability", "info", "create", "prompt", "destroy", "abort", "tool-result"]);

chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  if (port.name === "llm-page") {
    // Trust only the browser-reported origin. Top frame only.
    if (!sender?.origin || !sender.tab?.id || sender.frameId !== 0 || !/^https?:/.test(sender.origin)) {
      port.disconnect();
      return;
    }
    openConn(port, sender.origin, sender.tab.id, (conn, raw) => {
      const env = raw as BridgeEnvelope;
      const req = parsePageRequest(env?.req);
      if (!req) return; // schema check again at the boundary
      handlePageRequest(conn, req, env.visible === true).catch((e) => replyError(conn, req.id, e));
    });
  } else if (port.name === "llm-playground") {
    // The extension's own playground tab only; content scripts report the page's URL and origin.
    if (sender?.id !== chrome.runtime.id || !sender.url?.startsWith(PLAYGROUND_URL) || !sender.tab?.id) {
      port.disconnect();
      return;
    }
    openConn(port, PLAYGROUND_ORIGIN, sender.tab.id, (conn, raw) => {
      const env = raw as PlaygroundEnvelope;
      const req = parsePageRequest(env?.req, { images: true });
      if (!req) return;
      if (!PLAYGROUND_KINDS.has(req.kind) || typeof env.backend !== "string") {
        return replyError(conn, req.id, new LLMError("NotSupportedError", `Unsupported playground request ${req.kind}`));
      }
      handlePlaygroundRequest(conn, req, env.backend).catch((e) => replyError(conn, req.id, e));
    });
  }
});

// ---- Backend resolution ---------------------------------------------------

async function backendSpec(id: string, settings: Settings): Promise<BackendSpec> {
  if (id === "local") {
    const model = configuredLocalModel(settings);
    return { kind: "local", model, engine: settings.local.enginePin[model.id] ?? "auto", reasoning: settings.local.reasoning };
  }
  const provider = findProvider(settings, id);
  const cfg = settings.providers[id];
  if (!provider) throw new LLMError("NotSupportedError", `Unknown backend ${id}`);
  if (provider.keyRequired && !cfg?.enabled) throw new LLMError("NotAllowedError", `${provider.name} is not enabled`);
  if (!(await chrome.permissions.contains({ origins: [provider.hostPattern] }))) {
    throw new LLMError("NotAllowedError", `Host permission for ${provider.name} has not been granted`);
  }
  const apiKey = (await getKey(id)) ?? "";
  if (provider.keyRequired && !apiKey) throw new LLMError("NotAllowedError", `No API key set for ${provider.name}`);
  return { kind: "cloud", provider, model: cfg?.model || provider.defaultModel, apiKey };
}

/** The site's backend followed by allowed fallbacks. Never falls back to cloud unless enabled for the site. */
async function backendChain(site: SiteConfig, settings: Settings): Promise<Array<{ id: string; spec: BackendSpec }>> {
  const ids = [site.backend, ...(site.allowFallback ? site.allowedBackends.filter((b) => b !== site.backend) : [])];
  const chain: Array<{ id: string; spec: BackendSpec }> = [];
  let firstError: unknown;
  for (const id of ids) {
    if (!site.allowedBackends.includes(id)) continue;
    try {
      chain.push({ id, spec: await backendSpec(id, settings) });
    } catch (e) {
      firstError ??= e;
    }
  }
  if (!chain.length) throw firstError ?? new LLMError("NotSupportedError", "No backend is configured for this site");
  return chain;
}

/** Models the site may run right now: its allowed backends that are ready (weights, key, permission). */
async function siteModels(site: SiteConfig, settings: Settings): Promise<ModelInfo[]> {
  const host = site.allowedBackends.includes("local") ? ((await admin({ op: "status" }).catch(() => null)) as HostStatus | null) : null;
  const providers = [];
  for (const id of site.allowedBackends) {
    if (id === "local") continue;
    try {
      const spec = await backendSpec(id, settings);
      if (spec.kind === "cloud") providers.push(spec.provider);
    } catch {
      /* not enabled, no key or no permission: not runnable */
    }
  }
  return listModels({ settings, site, host, providers });
}

/** The backend for create({ model }): only an id from the site's own list, and no fallback. */
async function chosenBackend(id: string, site: SiteConfig, settings: Settings): Promise<{ entry: ModelInfo; backends: Array<{ id: string; spec: BackendSpec }> }> {
  const entry = (await siteModels(site, settings)).find((m) => m.id === id);
  const parsed = parseModelId(id);
  if (!entry || !parsed) throw new LLMError("NotSupportedError", `Model ${id} is not available to this site`);
  const base = await backendSpec(entry.backend, settings);
  const spec: BackendSpec =
    base.kind === "local"
      ? { ...base, model: findModel(parsed.model)!, engine: entry.engine as EngineId }
      : { ...base, model: parsed.model };
  return { entry, backends: [{ id: entry.backend, spec }] };
}

function backendName(id: string, settings: Settings): string {
  if (id === "local") return findModel(settings.local.modelId)?.name ?? "local model";
  return findProvider(settings, id)?.name ?? id;
}

// ---- Request handling -----------------------------------------------------

const hostBase = (conn: PageConn, settings: Settings) => ({
  type: "req" as const,
  origin: conn.origin,
  owner: conn.key,
  limits: { maxSessions: settings.limits.maxSessions, maxContext: settings.limits.maxContext, maxOutputTokens: settings.limits.maxOutputTokens },
  idleUnloadMinutes: settings.idleUnloadMinutes,
});

type HostBase = ReturnType<typeof hostBase>;

async function abort(conn: PageConn, req: Extract<PageRequest, { kind: "abort" }>, base: HostBase) {
  inFlight.delete(rid(conn, req.target));
  await sendToHost({ ...base, rid: rid(conn, req.id), req: { ...req, target: rid(conn, req.target) } });
}

/** A tool result for one of this page's own prompts: the target is scoped to the connection like abort's. */
async function toolResult(conn: PageConn, req: Extract<PageRequest, { kind: "tool-result" }>, base: HostBase) {
  // The result becomes model input; count it against the site's per-minute budget.
  limiter.record(conn.origin, estimateTokens(req.result));
  await sendToHost({ ...base, rid: rid(conn, req.id), req: { ...req, target: rid(conn, req.target) } });
}

function checkProviderCap(usage: UsageEntry[], backend: string, est: number, settings: Settings) {
  const cap = settings.providers[backend]?.monthlyTokenCap;
  if (backend !== "local" && cap && providerTokensThisMonth(usage, backend, Date.now()) + est > cap) {
    throw new LLMError("QuotaExceededError", `Monthly token cap for ${backendName(backend, settings)} reached`);
  }
}

async function handlePageRequest(conn: PageConn, req: PageRequest, visible: boolean) {
  const { origin, tabId } = conn;
  const [site, permitted, onceGrant, settings] = await Promise.all([
    getSite(origin),
    isPermitted(origin),
    hasOnceGrant(origin, tabId),
    getSettings(),
  ]);

  const g = gate({ kind: req.kind, site, permitted, onceGrant, visible });
  if (g.action === "deny") throw new LLMError(g.name, g.message);

  const base = hostBase(conn, settings);

  switch (req.kind) {
    case "abort":
      return abort(conn, req, base);

    case "tool-result":
      return toolResult(conn, req, base);

    case "availability": {
      const fixed = consentAvailability(site, permitted, onceGrant);
      if (fixed) return reply(conn, { kind: "result", id: req.id, value: fixed });
      let backends;
      try {
        backends = await backendChain(site!, settings);
      } catch {
        return reply(conn, { kind: "result", id: req.id, value: "unavailable" });
      }
      return forward(conn, req, { ...base, backends });
    }

    case "params":
    case "info":
      return forward(conn, req, { ...base, backends: await backendChain(site ?? defaultSite(origin), settings) });

    case "models": {
      // Answered here: the list depends on keys and permissions, which the host never sees.
      const value = site && site.consent !== "deny" ? await siteModels(site, settings) : [];
      return reply(conn, { kind: "result", id: req.id, value });
    }

    case "create": {
      const { model, ...options } = req.options;
      const chosen = model !== undefined ? await chosenBackend(model, site!, settings) : null;
      const backends = chosen?.backends ?? (await backendChain(site!, settings));
      if (g.action === "ask") {
        const cloud = backends[0].spec.kind === "cloud";
        const decision: Decision = await askConsent({
          origin,
          tabId,
          backend: backends[0].id,
          backendName: !chosen ? backendName(backends[0].id, settings) : cloud ? `${chosen.entry.name} (${chosen.entry.provider})` : chosen.entry.name,
          cloud,
        });
        if (decision === "deny") throw new LLMError("NotAllowedError", "The user denied access to the model");
      }
      return forward(conn, { ...req, options }, { ...base, backends });
    }

    case "prompt":
    case "append": {
      const est = estimateMessageTokens(req.input);
      if (!limiter.allows(origin, est, settings.limits.tokensPerMinute)) {
        throw new LLMError("QuotaExceededError", "Per-minute token limit for this site reached; try again shortly");
      }
      const usage = await getUsage();
      const s = site!;
      if (exceedsDailyTokenCap(siteTokensToday(usage, origin, Date.now()) + est, s.dailyTokenCap, s.dailyTokenUnlimited)) {
        throw new LLMError("QuotaExceededError", "Daily token cap for this site reached");
      }
      checkProviderCap(usage, sessionBackends.get(req.sessionId) ?? s.backend, est, settings);
      limiter.record(origin, est);
      return forward(conn, req, base);
    }

    default:
      return forward(conn, req, base);
  }
}

/**
 * The playground is the extension's own UI, so it names the backend and skips the site consent
 * gate and per-site limits. Keys stay here; provider spend caps still apply.
 */
async function handlePlaygroundRequest(conn: PageConn, req: PageRequest, backend: string) {
  const settings = await getSettings();
  // The playground shows raw requests and responses; web pages never get traces.
  const base = { ...hostBase(conn, settings), trace: true };
  switch (req.kind) {
    case "availability":
    case "info":
    case "create":
      return forward(conn, req, { ...base, backends: [{ id: backend, spec: await backendSpec(backend, settings) }] });
    case "prompt":
      checkProviderCap(await getUsage(), sessionBackends.get(req.sessionId) ?? backend, estimateMessageTokens(req.input), settings);
      return forward(conn, req, base);
    case "abort":
      return abort(conn, req, base);
    case "tool-result":
      return toolResult(conn, req, base);
    default:
      return forward(conn, req, base);
  }
}

async function forward(conn: PageConn, req: PageRequest, base: Omit<HostRequest, "rid" | "req">) {
  const r = rid(conn, req.id);
  if (req.kind !== "destroy") inFlight.set(r, { conn, id: req.id });
  await sendToHost({ ...base, rid: r, req: { ...req, id: r } });
}

// ---- Host messages --------------------------------------------------------

const adminWaiters = new Map<string, (r: { ok: boolean; value?: unknown; error?: string }) => void>();
let lastSessions: Record<string, number> = {};

function updateBadge(sessions: Record<string, number>) {
  lastSessions = sessions;
  const n = Object.values(sessions).reduce((a, b) => a + b, 0);
  chrome.action.setBadgeText({ text: n ? String(n) : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#3b5bdb" }).catch(() => {});
}

onHostMessage((msg: FromHost) => {
  switch (msg.type) {
    case "res": {
      const f = inFlight.get(msg.rid);
      if (msg.usage) {
        const { origin, backendId, model, inputTokens, outputTokens } = msg.usage;
        appendUsage({ origin, backend: backendId, ...(model ? { model } : {}), time: Date.now(), inputTokens, outputTokens }).catch(() => {});
        // Correct the estimate recorded before the request with actual output.
        limiter.record(origin, outputTokens);
      }
      if (!f) return;
      if (msg.sessionBackend && msg.res.kind === "result") {
        const info = msg.res.value as { sessionId?: string };
        if (info?.sessionId) sessionBackends.set(info.sessionId, msg.sessionBackend);
      }
      if (msg.res.kind === "result" || msg.res.kind === "error" || msg.res.kind === "done") inFlight.delete(msg.rid);
      if (!deliversTo(msg.res.kind, f.conn.origin === PLAYGROUND_ORIGIN)) return;
      reply(f.conn, { ...msg.res, id: f.id });
      return;
    }
    case "admin-res":
      adminWaiters.get(msg.rid)?.(msg);
      adminWaiters.delete(msg.rid);
      return;
    case "admin-progress":
      chrome.runtime.sendMessage({ type: "download-progress", rid: msg.rid, loaded: msg.loaded }).catch(() => {});
      return;
    case "sessions":
      updateBadge(msg.sessions);
      return;
  }
});

onHostDisconnect(() => {
  for (const [k, f] of inFlight) {
    replyError(f.conn, f.id, new LLMError("OperationError", "The model host stopped; sessions were lost"));
    inFlight.delete(k);
  }
  sessionBackends.clear();
  updateBadge({});
});

let adminCounter = 0;
export async function admin(op: AdminOp): Promise<unknown> {
  const r = `admin-${++adminCounter}-${Date.now()}`;
  const result = new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => adminWaiters.set(r, resolve));
  await sendToHost({ type: "admin", rid: r, admin: op });
  const res = await result;
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

// ---- Site management ------------------------------------------------------

async function enableSite(origin: string): Promise<void> {
  if (!(await isPermitted(origin))) throw new Error(`Host permission for ${origin} was not granted`);
  await updateSite(origin, (s) => s);
  await syncRegistrations();
}

/** Revocation takes effect immediately: sessions destroyed, ports closed, scripts unregistered. */
async function revokeSite(origin: string, removePermission: boolean): Promise<void> {
  await updateSite(origin, () => null);
  await clearOnceGrants((o) => o === origin);
  limiter.forget(origin);
  for (const c of conns.values()) if (c.origin === origin) c.port.disconnect();
  await admin({ op: "revokeOrigin", origin }).catch(() => {});
  if (removePermission) await chrome.permissions.remove({ origins: [originPattern(origin)] }).catch(() => {});
  await syncRegistrations();
}

async function resetConsent(origin: string): Promise<void> {
  await updateSite(origin, (s) => ({ ...s, consent: undefined }));
  await clearOnceGrants((o) => o === origin);
  for (const c of conns.values()) if (c.origin === origin) c.port.disconnect();
  await admin({ op: "revokeOrigin", origin }).catch(() => {});
}

// ---- Extension-internal messages (UI pages and the host) -------------------

type UIMessage =
  | { type: "host-ready" }
  | { type: "consent:get"; id: string }
  | { type: "consent:decide"; id: string; decision: Decision }
  | { type: "site:enable"; origin: string }
  | { type: "site:revoke"; origin: string }
  | { type: "site:reset-consent"; origin: string }
  | { type: "admin"; admin: AdminOp }
  | { type: "sessions" }
  | { type: "tool:web_search"; args: { query?: unknown; max_results?: unknown } };

chrome.runtime.onMessage.addListener((msg: UIMessage, sender, sendResponse) => {
  // Only extension pages (options, popup, consent, offscreen host) may use these.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
  const done = (p: Promise<unknown>) => {
    p.then((value) => sendResponse({ ok: true, value }), (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true;
  };
  switch (msg.type) {
    case "host-ready":
      hostReady();
      return;
    case "consent:get":
      sendResponse({ ok: true, value: getConsentRequest(msg.id) });
      return;
    case "consent:decide":
      return done(settle(msg.id, msg.decision));
    case "site:enable":
      return done(enableSite(msg.origin));
    case "site:revoke":
      return done(revokeSite(msg.origin, true));
    case "site:reset-consent":
      return done(resetConsent(msg.origin));
    case "admin":
      return done(admin(msg.admin));
    case "sessions":
      sendResponse({ ok: true, value: lastSessions });
      return;
    case "tool:web_search":
      return done(webSearch(msg.args));
  }
});

/** The playground's web_search tool: the key is read here and sent only to the host, which calls Tavily. */
async function webSearch(args: { query?: unknown; max_results?: unknown }) {
  const query = String(args?.query ?? "").trim();
  if (!query) throw new Error("web_search requires a non-empty query");
  const apiKey = await getKey("tavily");
  if (!apiKey) throw new Error("No Tavily API key — add one in the extension's options under Tools");
  if (!(await chrome.permissions.contains({ origins: ["https://api.tavily.com/*"] }))) {
    throw new Error("Permission to reach api.tavily.com has not been granted (options → Tools)");
  }
  const maxResults = Math.min(10, Math.max(1, Number(args?.max_results) || 5));
  return admin({ op: "webSearch", apiKey, query, maxResults });
}

// ---- Lifecycle ------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => void syncRegistrations());
chrome.runtime.onStartup.addListener(() => void syncRegistrations());
chrome.windows.onRemoved.addListener((id) => onWindowClosed(id));
chrome.tabs.onRemoved.addListener((tabId) => void clearOnceGrants((_, t) => t === tabId));

chrome.permissions.onRemoved.addListener(async ({ origins = [] }) => {
  const removed = new Set(origins);
  const { sites } = (await chrome.storage.local.get("sites")) as { sites?: Record<string, SiteConfig> };
  for (const origin of Object.keys(sites ?? {})) {
    if (removed.has(originPattern(origin)) || removed.has("<all_urls>")) await revokeSite(origin, false);
  }
});

let syncTimer: ReturnType<typeof setTimeout> | undefined;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("settings" in changes || "sites" in changes)) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncRegistrations(), 100);
});

if (__TEST__) {
  // Test-only hooks for Playwright; the test build grants localhost host permissions.
  (globalThis as Record<string, unknown>).__test = {
    async enableSite(origin: string, consent?: "always" | "deny", patch: Partial<SiteConfig> = {}) {
      await updateSite(origin, (s) => ({ ...s, consent, ...patch }));
      return syncRegistrations();
    },
    revokeSite: (origin: string) => revokeSite(origin, false),
    getUsage,
    admin,
  };
}
