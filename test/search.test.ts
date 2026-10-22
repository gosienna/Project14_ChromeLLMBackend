import { describe, expect, it } from "vitest";
import { runSearch, type SearchDeps } from "../src/background/search";
import { googleImagesUrl, googleSearchUrl, normalizeGoogleImages, normalizeGoogleResults, tavilyFallback } from "../src/shared/search";

const hit = { title: "T", url: "https://example.com/", snippet: "s", score: 0.9 };

const pic = { url: "https://img.example/cat.jpg", description: "A cat" };

function deps(over: Partial<SearchDeps> = {}): SearchDeps & { googleCalls: number; flags: boolean[] } {
  const d = {
    googleCalls: 0,
    flags: [] as boolean[],
    tavilyKey: async () => "tvly-key",
    tavilyPermitted: async () => true,
    tavily: async (_k: string, query: string, _n: number, images: boolean) => {
      d.flags.push(images);
      return { ok: true as const, query, results: [hit], ...(images ? { images: [pic] } : {}) };
    },
    googlePermitted: async () => true,
    google: async (_q: string, _n: number, images: boolean) => {
      d.googleCalls++;
      d.flags.push(images);
      return { results: [{ ...hit, url: "https://g.example/", score: null }], ...(images ? { images: [pic] } : {}) };
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

describe("runSearch with images", () => {
  it("asks Tavily for images only when requested", async () => {
    const d = deps();
    expect(await runSearch("cats", 5, d, { includeImages: true })).toEqual({ query: "cats", provider: "tavily", results: [hit], images: [pic] });
    expect((await runSearch("cats", 5, d)).images).toBeUndefined();
    expect(d.flags).toEqual([true, false]);
  });

  it("gets images from Google on fallback, and keeps the results when the Images tab fails", async () => {
    const noKey = { tavilyKey: async () => null };
    const g = deps(noKey);
    expect(await runSearch("cats", 5, g, { includeImages: true })).toMatchObject({ provider: "google", images: [pic], note: "No Tavily API key; results from Google" });
    expect(g.flags).toEqual([true]);
    const failed = await runSearch("cats", 5, deps({ ...noKey, google: async () => ({ results: [hit], images: null }) }), { includeImages: true });
    expect(failed).toEqual({
      query: "cats",
      provider: "google",
      results: [hit],
      images: [],
      note: "No Tavily API key; results from Google; Google image results unavailable",
    });
  });
});

describe("normalizeGoogleImages", () => {
  const thumb = "https://encrypted-tbn0.gstatic.com/images?q=tbn:abc";
  it("pairs inline originals with their thumbnails, decodes escapes, dedupes, caps", () => {
    const out = normalizeGoogleImages(
      {
        blocked: false,
        data: [
          { url: thumb, h: 100, w: 150 },
          { url: "https://img.example/a.jpg?w\u003d800\u0026h\u003d600", h: 600, w: 800 },
          { url: "https://www.google.com/logos/x.png", h: 1, w: 1 },
          { url: "https://img.example/b.png", h: 10, w: 20 },
          { url: "https://img.example/b.png", h: 10, w: 20 },
          { url: "https://img.example/c.png", h: 1, w: 1 },
        ],
        links: [],
        thumbs: [{ src: thumb, alt: " Cat  on a mat " }],
      },
      2,
    );
    expect(out).toEqual([
      { url: "https://img.example/a.jpg?w=800&h=600", description: "Cat on a mat", thumbnail: thumb, width: 800, height: 600 },
      { url: "https://img.example/b.png", width: 20, height: 10 },
    ]);
  });

  it("reads /imgres links, and falls back to thumbnails", () => {
    const imgres = "https://www.google.com/imgres?imgurl=https%3A%2F%2Fimg.example%2Fd.jpg&imgrefurl=https%3A%2F%2Fsite.example%2Fpage";
    expect(normalizeGoogleImages({ blocked: false, data: [], links: [imgres, "https://www.google.com/imgres?imgurl=javascript:x"], thumbs: [] }, 5)).toEqual([
      { url: "https://img.example/d.jpg", sourceUrl: "https://site.example/page" },
    ]);
    expect(normalizeGoogleImages({ blocked: false, data: [], links: [], thumbs: [{ src: thumb, alt: "Cat" }] }, 5)).toEqual([
      { url: thumb, description: "Cat", thumbnail: thumb },
    ]);
  });

  it("builds the images url", () => {
    expect(googleImagesUrl("a b")).toBe("https://www.google.com/search?q=a+b&udm=2&hl=en");
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
