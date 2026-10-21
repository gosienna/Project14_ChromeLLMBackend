// Messages between the service worker (router) and the offscreen host. Both are extension
// contexts; the router has already authorized the origin before anything reaches the host.

import type { CatalogModel, DeviceCaps, EngineId } from "./catalog";
import type { PageRequest, PageResponse, Usage } from "./protocol";
import type { ProviderDef } from "./providers";

export type BackendSpec =
  | { kind: "local"; model: CatalogModel; engine: EngineId | "auto"; reasoning: boolean }
  | { kind: "cloud"; provider: ProviderDef; model: string; apiKey: string };

export interface HostRequest {
  type: "req";
  /** Router-scoped request id (unique across tabs). */
  rid: string;
  origin: string;
  /** Router-scoped page connection; its sessions are released when the page goes away. */
  owner: string;
  req: PageRequest;
  /**
   * For create/availability/params/info: the backend to use, then any fallbacks the user
   * allowed for this site, in order. The host uses the first one that is available.
   */
  backends?: Array<{ id: string; spec: BackendSpec }>;
  limits: { maxSessions: number; maxContext: number; maxOutputTokens: number };
  idleUnloadMinutes: number;
  /** Set only for the extension's playground: report raw request/response traces. */
  trace?: boolean;
}

export interface HostResponse {
  type: "res";
  rid: string;
  res: PageResponse;
  /** Reported with the final message of a generation. */
  usage?: Usage & { origin: string; backendId: string; model?: string };
  /** Backend chosen for a session created or cloned by this request. */
  sessionBackend?: string;
}

export type AdminOp =
  | { op: "status" }
  | { op: "download"; model: CatalogModel; engine: EngineId | "auto"; maxContext: number }
  | { op: "deleteModel"; model: CatalogModel }
  | { op: "unload" }
  | { op: "revokeOrigin"; origin: string }
  | { op: "releaseOwner"; owner: string }
  /** The playground's web_search tool. The router adds the key; the page never sees it. */
  | { op: "webSearch"; apiKey: string; query: string; maxResults: number };

export interface HostStatus {
  caps: DeviceCaps;
  loaded: { modelId: string; engine: EngineId } | null;
  downloading: string | null;
  downloaded: string[];
  /** Chrome's built-in Prompt API is present in the host. */
  nano: boolean;
  sessions: Record<string, number>;
  crossOriginIsolated: boolean;
}

export interface HostAdminRequest {
  type: "admin";
  rid: string;
  admin: AdminOp;
}

export interface HostAdminResponse {
  type: "admin-res";
  rid: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface HostProgress {
  type: "admin-progress";
  rid: string;
  loaded: number;
}

export interface HostSessionsChanged {
  type: "sessions";
  sessions: Record<string, number>;
}

/** Sent while work is in flight so the service worker is not stopped as idle. */
export interface HostKeepAlive {
  type: "keepalive";
}

export type FromHost = HostResponse | HostAdminResponse | HostProgress | HostSessionsChanged | HostKeepAlive;
export type ToHost = HostRequest | HostAdminRequest;
