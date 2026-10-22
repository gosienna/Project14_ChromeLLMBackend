import { describe, expect, it } from "vitest";
import { runSearch, type SearchDeps } from "../src/background/search";
import { googleSearchUrl, normalizeGoogleResults, tavilyFallback } from "../src/shared/search";

const hit = { title: "T", url: "https://example.com/", snippet: "s", score: 0.9 };

function deps(over: Partial<SearchDeps> = {}): SearchDeps & { googleCalls: number } {
  const d = {
    googleCalls: 0,
    tavilyKey: async () => "tvly-key",
    tavilyPermitted: async () => true,
    tavily: async (_k: string, query: string) => ({ ok: true as const, query, results: [hit] }),
    googlePermitted: async () => true,
    google: async () => {
      d.googleCalls++;
      return [{ ...hit, url: "https://g.example/", score: null }];
    },
    ...over,
  };
  return d;
}

describe("tavilyFallback", () => {
  it("falls back on setup, auth, quota and server failures", () => {
    for (const why of ["nokey", "nopermission", "locked", "network", 401, 403, 429, 432, 433, 500, 503] as const) {
      expect(tavilyFallback(why)).toBe(true);
    }
  });
  it("reports malformed requests instead", () => {
    expect(tavilyFallback(400)).toBe(false);
    expect(tavilyFallback(422)).toBe(false);
  });
});

describe("runSearch", () => {
  it("uses Tavily when it works", async () => {
    const d = deps();
    expect(await runSearch(" cats ", 5, d)).toEqual({ query: "cats", provider: "tavily", results: [hit] });
    expect(d.googleCalls).toBe(0);
  });

  it("falls back to Google without a key, when locked, or on quota", async () => {
    expect((await runSearch("q", 5, deps({ tavilyKey: async () => null }))).note).toMatch(/No Tavily API key/);
    expect((await runSearch("q", 5, deps({ tavilyKey: async () => { throw new Error("locked"); } }))).provider).toBe("google");
    const quota = await runSearch("q", 5, deps({ tavily: async () => ({ ok: false, status: 432, message: "Tavily: plan limit" }) }));
    expect(quota).toMatchObject({ provider: "google", note: "Tavily usage limit reached; results from Google" });
  });

  it("fails when neither provider is usable, or the query is bad", async () => {
    await expect(runSearch("q", 5, deps({ tavilyKey: async () => null, googlePermitted: async () => false }))).rejects.toMatchObject({ name: "NotAllowedError" });
    await expect(runSearch("q", 5, deps({ tavily: async () => ({ ok: false, status: 400, message: "Tavily: bad" }) }))).rejects.toMatchObject({ name: "DataError" });
    await expect(runSearch("  ", 5, deps())).rejects.toMatchObject({ name: "DataError" });
  });
});

describe("normalizeGoogleResults", () => {
  it("unwraps redirects, drops Google links and duplicates, trims to max", () => {
    const raw = {
      blocked: false,
      items: [
        { href: "https://www.google.com/url?q=https://a.example/page&sa=U", title: " A  page ", snippet: "first\n snippet" },
        { href: "https://a.example/page#frag", title: "A again", snippet: "" },
        { href: "https://maps.google.com/x", title: "Maps", snippet: "" },
        { href: "https://b.example/", title: "B", snippet: "x".repeat(400) },
        { href: "javascript:void(0)", title: "J", snippet: "" },
        { href: "https://c.example/", title: "C", snippet: "" },
      ],
    };
    const out = normalizeGoogleResults(raw, 2);
    expect(out).toEqual([
      { title: "A page", url: "https://a.example/page", snippet: "first snippet", score: null },
      { title: "B", url: "https://b.example/", snippet: "x".repeat(300), score: null },
    ]);
  });

  it("builds the search url", () => {
    expect(googleSearchUrl("a b&c", 5)).toBe("https://www.google.com/search?q=a+b%26c&num=8&hl=en");
  });
});
