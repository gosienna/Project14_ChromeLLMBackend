import { describe, expect, it } from "vitest";
import { TokenRateLimiter, estimateCost, exceedsDailyTokenCap, idleCloseIn, providerTokensThisMonth, siteTokensToday } from "../src/background/limits";

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
  it("treats an unlimited daily cap as never exceeded", () => {
    expect(exceedsDailyTokenCap(15, 10)).toBe(true);
    expect(exceedsDailyTokenCap(15, 200_000)).toBe(false);
    expect(exceedsDailyTokenCap(15, 10, true)).toBe(false);
  });
  it("counts this month's tokens per provider", () => expect(providerTokensThisMonth(usage, "openai", now)).toBe(152));
  it("estimates cost for cloud only", () => {
    expect(estimateCost(usage[0])).toBe(0);
    expect(estimateCost({ ...usage[1], inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.1);
  });
});

describe("idleCloseIn", () => {
  it("closes once the period has passed with nothing in flight", () => {
    expect(idleCloseIn(1000, 1000, false, 25_000)).toBe(25_000);
    expect(idleCloseIn(1000, 21_000, false, 25_000)).toBe(5_000);
    expect(idleCloseIn(1000, 26_000, false, 25_000)).toBe("close");
  });

  it("never closes a busy connection", () => {
    expect(idleCloseIn(0, 1_000_000, true, 25_000)).toBe(25_000);
  });
});
