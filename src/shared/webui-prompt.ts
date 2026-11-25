// Flatten a chat history into one paste for a web chat composer.

import type { ChatMessage } from "./protocol";

/** Labelled multi-turn prompt suitable for pasting into ChatGPT / Gemini / Claude. */
export function flattenWebUiPrompt(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const role = m.role === "system" ? "System" : m.role === "assistant" ? "Assistant" : m.role === "tool" ? "Tool" : "User";
    const text = (m.content ?? "").trim();
    if (!text && !m.images?.length) continue;
    const imageNote = m.images?.length ? ` [image x${m.images.length} omitted]` : "";
    parts.push(`${role}: ${text}${imageNote}`);
  }
  return parts.join("\n\n").trim();
}
