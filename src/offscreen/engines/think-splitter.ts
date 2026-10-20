// Splits a streamed reply into answer and reasoning for models whose chat template leaves
// <think>…</think> in the content instead of llama.cpp separating it. Tags may arrive split
// across chunks, so a possible partial tag at the end of a chunk is held back.

const OPEN = "<think>";
const CLOSE = "</think>";

export interface Split {
  answer: string;
  reasoning: string;
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
export function partialTag(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n;
  return 0;
}

export class ThinkSplitter {
  private thinking = false;
  private held = "";
  private answerStarted = false;

  push(text: string): Split {
    const out: Split = { answer: "", reasoning: "" };
    let buf = this.held + text;
    this.held = "";
    while (buf) {
      const tag = this.thinking ? CLOSE : OPEN;
      const i = buf.indexOf(tag);
      const end = i >= 0 ? i : buf.length - partialTag(buf, tag);
      this.emit(out, buf.slice(0, end));
      if (i < 0) {
        this.held = buf.slice(end);
        break;
      }
      this.thinking = !this.thinking;
      buf = buf.slice(i + tag.length);
    }
    return out;
  }

  /** Whatever was held back as a possible tag, once the stream ends. */
  flush(): Split {
    const out: Split = { answer: "", reasoning: "" };
    this.emit(out, this.held);
    this.held = "";
    return out;
  }

  private emit(out: Split, text: string) {
    if (this.thinking) {
      out.reasoning += text;
      return;
    }
    // The answer usually follows </think> after blank lines; drop them.
    const t = this.answerStarted ? text : text.trimStart();
    if (t) this.answerStarted = true;
    out.answer += t;
  }
}
