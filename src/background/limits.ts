// Per-origin rate limiting and spend caps. Pure logic, unit-tested without chrome APIs.

import { cloudCost } from "../shared/cloud-models";
import { BUILTIN_PROVIDERS } from "../shared/providers";
import type { UsageEntry } from "../shared/settings";

const MINUTE = 60_000;

/** Sliding one-minute token window per origin. */
export class TokenRateLimiter {
  private events = new Map<string, Array<{ t: number; n: number }>>();

  constructor(private now: () => number = Date.now) {}

  private window(origin: string) {
    const cutoff = this.now() - MINUTE;
    const list = (this.events.get(origin) ?? []).filter((e) => e.t > cutoff);
    this.events.set(origin, list);
    return list;
  }

  used(origin: string): number {
    return this.window(origin).reduce((s, e) => s + e.n, 0);
  }

  /** True if spending `tokens` more now stays within `perMinute`. */
  allows(origin: string, tokens: number, perMinute: number): boolean {
    return this.used(origin) + tokens <= perMinute;
  }

  record(origin: string, tokens: number): void {
    this.window(origin).push({ t: this.now(), n: tokens });
  }

  forget(origin: string): void {
    this.events.delete(origin);
  }
}

/**
 * When to close an idle page connection: "close" now, or the ms to wait before checking again.
 * A connection with requests in flight is never idle; it is checked again a full period later.
 */
export function idleCloseIn(lastActivity: number, now: number, busy: boolean, idleMs: number): number | "close" {
  if (busy) return idleMs;
  const left = lastActivity + idleMs - now;
  return left <= 0 ? "close" : left;
}

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfMonth(now: number): number {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const total = (e: UsageEntry) => e.inputTokens + e.outputTokens;

export function siteTokensToday(usage: UsageEntry[], origin: string, now: number): number {
  const since = startOfDay(now);
  return usage.filter((e) => e.origin === origin && e.time >= since).reduce((s, e) => s + total(e), 0);
}

/** True when today's usage plus the next estimate is over the site cap. Unlimited sites never exceed it. */
export function exceedsDailyTokenCap(used: number, cap: number, unlimited = false): boolean {
  return !unlimited && used > cap;
}

export function providerTokensThisMonth(usage: UsageEntry[], backend: string, now: number): number {
  const since = startOfMonth(now);
  return usage.filter((e) => e.backend === backend && e.time >= since).reduce((s, e) => s + total(e), 0);
}

/**
 * Rough USD cost for the usage log at the model's base list price (cloud-models.ts). Entries
 * logged before the model was recorded are priced as the provider's default model; local,
 * custom endpoints and unlisted models count as 0.
 */
export function estimateCost(e: UsageEntry): number {
  const fallback = BUILTIN_PROVIDERS.find((p) => p.id === e.backend)?.defaultModel;
  return cloudCost(e.backend, e.model ?? fallback, e.inputTokens, e.outputTokens) ?? 0;
}
