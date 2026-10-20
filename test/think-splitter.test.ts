import { describe, expect, it } from "vitest";
import { ThinkSplitter } from "../src/offscreen/engines/think-splitter";

function run(chunks: string[]) {
  const s = new ThinkSplitter();
  let answer = "";
  let reasoning = "";
  for (const part of [...chunks.map((c) => s.push(c)), s.flush()]) {
    answer += part.answer;
    reasoning += part.reasoning;
  }
  return { answer, reasoning };
}

describe("ThinkSplitter", () => {
  it("passes plain answers through", () => expect(run(["Hello ", "world"])).toEqual({ answer: "Hello world", reasoning: "" }));
  it("separates a think block", () => expect(run(["<think>plan</think>\n\nAnswer"])).toEqual({ answer: "Answer", reasoning: "plan" }));
  it("handles tags split across chunks", () =>
    expect(run(["<th", "ink>step 1, ", "step 2</thi", "nk>\n", "Done."])).toEqual({ answer: "Done.", reasoning: "step 1, step 2" }));
  it("keeps text that only looks like a tag start", () => expect(run(["a <", "b"])).toEqual({ answer: "a <b", reasoning: "" }));
  it("treats an unclosed block as reasoning", () => expect(run(["<think>still going"])).toEqual({ answer: "", reasoning: "still going" }));
});
