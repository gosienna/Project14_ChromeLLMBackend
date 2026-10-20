import { describe, expect, it } from "vitest";
import { TokenRateLimiter, estimateCost, providerTokensThisMonth, siteTokensToday } from "../src/background/limits";

describe("TokenRateLimiter", () => {
  it("enforces a sliding one-minute window per origin", () => {
    let now = 1_000_000;
    const rl = new TokenRateLimiter(() => now);
    rl.record("a", 900);
    expect(rl.allows("a", 100, 1000)).toBe(true);
    expect(rl.allows("a", 101, 1000)).toBe(false);
    expect(rl.allows("b", 1000, 1000)).toBe(true);
    now += 60_001;
    expect(rl.allows("a", 1000, 1000)).toBe(true);
  });
});

describe("spend caps", () => {
  const now = new Date(2026, 9, 19, 15).getTime();
  const usage = [
    { origin: "https://a.com", backend: "local", time: now - 1000, inputTokens: 10, outputTokens: 5 },
    { origin: "https://a.com", backend: "openai", time: now - 2 * 86_400_000, inputTokens: 100, outputTokens: 50 },
    { origin: "https://b.com", backend: "openai", time: now - 1000, inputTokens: 1, outputTokens: 1 },
    { origin: "https://a.com", backend: "openai", time: new Date(2026, 8, 30).getTime(), inputTokens: 999, outputTokens: 0 },
  ];
  it("counts today's tokens per site", () => expect(siteTokensToday(usage, "https://a.com", now)).toBe(15));
  it("counts this month's tokens per provider", () => expect(providerTokensThisMonth(usage, "openai", now)).toBe(152));
  it("estimates cost for cloud only", () => {
    expect(estimateCost(usage[0])).toBe(0);
    expect(estimateCost({ ...usage[1], inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.1);
  });
});
