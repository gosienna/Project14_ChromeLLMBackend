import { describe, expect, it } from "vitest";
import { parseSSE } from "../src/offscreen/adapters/sse";
import { streamOf } from "./streams";

describe("parseSSE", () => {
  it("parses events split across chunks, CRLF, comments and multi-line data", async () => {
    const out = [];
    for await (const e of parseSSE(streamOf("event: a\r\ndata: 1\r\n\r\n: comment\n", "data: x\ndata: y", "\n\ndata: tail"))) out.push(e);
    expect(out).toEqual([
      { event: "a", data: "1" },
      { event: "message", data: "x\ny" },
      { event: "message", data: "tail" },
    ]);
  });
});
