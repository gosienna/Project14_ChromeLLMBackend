import { describe, expect, it } from "vitest";
import { checkImageResponse, MAX_REMOTE_IMAGE_BYTES, SearchedImages, toBase64 } from "../src/shared/remote-image";

describe("checkImageResponse", () => {
  it("accepts raster images within the size cap", () => {
    expect(checkImageResponse("image/png", 10)).toBeNull();
    expect(checkImageResponse("IMAGE/JPEG; charset=binary", null)).toBeNull();
  });
  it("refuses svg, html, missing types and oversized images", () => {
    expect(checkImageResponse("image/svg+xml", 10)).toMatch(/image\/svg\+xml/);
    expect(checkImageResponse("text/html", 10)).toMatch(/Not a supported/);
    expect(checkImageResponse(null, 10)).toMatch(/none/);
    expect(checkImageResponse("image/png", MAX_REMOTE_IMAGE_BYTES + 1)).toMatch(/larger than 8 MB/);
  });
});

describe("SearchedImages", () => {
  it("remembers urls per origin, newest kept, and forgets on revoke", () => {
    const s = new SearchedImages(2);
    s.remember("https://a.example", ["u1", "u2"]);
    s.remember("https://a.example", ["u1", "u3"]);
    expect(["u1", "u2", "u3"].map((u) => s.has("https://a.example", u))).toEqual([true, false, true]);
    expect(s.has("https://b.example", "u1")).toBe(false);
    s.forget("https://a.example");
    expect(s.has("https://a.example", "u1")).toBe(false);
  });
});

it("toBase64 handles large inputs", () => {
  const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
  expect(Buffer.from(toBase64(bytes), "base64").equals(Buffer.from(bytes))).toBe(true);
});
