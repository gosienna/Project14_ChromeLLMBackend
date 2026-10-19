// Minimal Server-Sent Events parser over a fetch body.

export interface SSEEvent {
  event: string;
  data: string;
}

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  try {
    const field = (line: string) => {
      if (line.startsWith(":")) return;
      const i = line.indexOf(":");
      const name = i < 0 ? line : line.slice(0, i);
      const val = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (name === "event") event = val;
      else if (name === "data") data.push(val);
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl: number;
      while ((nl = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer[nl] === "\r" ? 2 : 1));
        if (line === "") {
          if (data.length) yield { event: event || "message", data: data.join("\n") };
          event = "";
          data = [];
        } else {
          field(line);
        }
      }
    }
    // A final event may arrive without its terminating blank line.
    if (buffer) field(buffer);
    if (data.length) yield { event: event || "message", data: data.join("\n") };
  } finally {
    reader.releaseLock();
  }
}
