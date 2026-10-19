// Per-origin rate limiting and spend caps. Pure logic, unit-tested without chrome APIs.

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

export function providerTokensThisMonth(usage: UsageEntry[], backend: string, now: number): number {
  const since = startOfMonth(now);
  return usage.filter((e) => e.backend === backend && e.time >= since).reduce((s, e) => s + total(e), 0);
}

/** Rough cost estimate in USD per million tokens (input, output) for the usage log. */
export const PRICE_HINTS: Record<string, [number, number]> = {
  anthropic: [1, 5],
  openai: [0.15, 0.6],
  gemini: [0.3, 2.5],
  xai: [0.3, 0.5],
  deepseek: [0.27, 1.1],
  openrouter: [1, 3],
};

export function estimateCost(e: UsageEntry): number {
  const p = PRICE_HINTS[e.backend];
  if (!p) return 0;
  return (e.inputTokens * p[0] + e.outputTokens * p[1]) / 1_000_000;
}
