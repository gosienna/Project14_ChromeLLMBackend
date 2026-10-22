import { describe, expect, it } from "vitest";
import { declaredSize, fetchMaybeRanged, isGgufUrl } from "../src/offscreen/large-fetch";

const FILE = "https://huggingface.co/unsloth/medgemma-27b-text-it-GGUF/resolve/main/medgemma-27b-text-it-Q4_K_M.gguf";

function bytes(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => i % 251);
}

function blobOf(data: Uint8Array): Blob {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return new Blob([copy]);
}

/** Serves `data` by Range. A full GET throws when the file is over `max`, the way Chrome does. */
function host(data: Uint8Array, max: number) {
  const calls: string[] = [];
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const range = new Headers(init?.headers).get("range");
    calls.push(`${method} ${range ?? "-"}`);
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-length": String(data.length) } });
    }
    const startEnd = range?.match(/bytes=(\d+)-(\d+)/);
    if (startEnd) {
      const start = Number(startEnd[1]);
      const end = Number(startEnd[2]);
      const slice = data.slice(start, end + 1);
      return new Response(blobOf(slice), {
        status: 206,
        headers: {
          "content-range": `bytes ${start}-${end}/${data.length}`,
          "content-length": String(slice.length),
        },
      });
    }
    if (data.length > max) throw new Error("Failed to fetch");
    return new Response(blobOf(data), { status: 200, headers: { "content-length": String(data.length) } });
  }) as typeof fetch;
  return { base, calls };
}

describe("fetchMaybeRanged", () => {
  it("recognises Hugging Face GGUF urls", () => {
    expect(isGgufUrl(FILE)).toBe(true);
    expect(isGgufUrl("https://us.aws.cdn.hf.co/xet-bridge-us/abc/medgemma.gguf")).toBe(true);
    expect(isGgufUrl("https://example.com/medgemma.gguf")).toBe(false);
    expect(isGgufUrl("https://huggingface.co/unsloth/medgemma/resolve/main/README.md")).toBe(false);
  });

  it("reads a size from content-range ahead of the slice length", () => {
    const res = new Response(new Uint8Array(1), { status: 206, headers: { "content-range": "bytes 0-0/16546405376", "content-length": "1" } });
    expect(declaredSize(res)).toBe(16546405376);
  });

  it("leaves a small GGUF as one fetch", async () => {
    const data = bytes(20);
    const { base, calls } = host(data, 100);
    const res = await fetchMaybeRanged(FILE, undefined, base, { maxSingleBody: 100, rangeBytes: 4 });
    expect(calls).toEqual(["HEAD -", "GET -"]);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
  });

  it("stitches a file Chrome would refuse into one body", async () => {
    const data = bytes(23);
    const { base, calls } = host(data, 8);
    const res = await fetchMaybeRanged(FILE, undefined, base, { maxSingleBody: 8, rangeBytes: 8 });
    expect(res.headers.get("content-length")).toBe("23");
    expect(calls.some((c) => c.startsWith("GET -"))).toBe(false);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
    expect(calls).toContain("GET bytes=0-7");
    expect(calls).toContain("GET bytes=16-22");
  });

  it("answers HEAD with the full size and does not download the body", async () => {
    const data = bytes(23);
    const { base, calls } = host(data, 8);
    const res = await fetchMaybeRanged(FILE, { method: "HEAD" }, base, { maxSingleBody: 8, rangeBytes: 8 });
    expect(res.headers.get("content-length")).toBe("23");
    expect(calls).toEqual(["HEAD -"]);
    expect(await res.arrayBuffer()).toEqual(new ArrayBuffer(0));
  });

  it("does not touch a url that is not a GGUF", async () => {
    const { base, calls } = host(bytes(4), 100);
    const res = await fetchMaybeRanged("https://huggingface.co/unsloth/medgemma/resolve/main/config.json", undefined, base, { maxSingleBody: 100 });
    expect(calls).toEqual(["GET -"]);
    expect(res.status).toBe(200);
  });
});
