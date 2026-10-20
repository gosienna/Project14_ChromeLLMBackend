// Markdown and LaTeX → safe HTML for playground replies. Ported from Project05's Dialogue renderer
// (modes/dialogue/markdown.js): text is HTML-escaped before any formatting, so model output can't
// inject markup. Math ($…$, \(…\), $$…$$, \[…\]) is rendered with KaTeX (bundled, trust off).

import katex from "katex";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESC[ch]);
}

// Placeholders use private-use characters, which no emphasis or escaping rule touches.
const OPEN = "";
const CLOSE = "";
const TOKEN = /(\d+)/g;
const BLOCK_TOKEN = /^\d+$/;

const isSafeUrl = (url: string) => /^(https?:|mailto:)/i.test(url.trim());
const link = (url: string, label: string) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

function math(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex.trim(), { displayMode, throwOnError: false, output: "htmlAndMathml", strict: "ignore", trust: false, maxExpand: 1000 });
  } catch {
    return `<code class="pg-md-math-error">${escapeHtml(tex)}</code>`;
  }
}

/** Render a model reply. Incomplete constructs (an unclosed $ or ```) stay as text until closed. */
export function renderMarkdown(src: string): string {
  const slots: string[] = [];
  const park = (html: string) => `${OPEN}${slots.push(html) - 1}${CLOSE}`;
  // Block-level placeholders sit on their own line so they aren't wrapped in a paragraph.
  const parkBlock = (html: string) => `\n\n${park(html)}\n\n`;

  let s = src.replace(/\r\n?/g, "\n");
  // Code first, so $ and markup inside it stay literal.
  s = s.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const language = lang.trim().replace(/[^\w.+#-]/g, "");
    return parkBlock(`<pre class="pg-md-code"><code${language ? ` data-lang="${escapeHtml(language)}"` : ""}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
  });
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => park(`<code>${escapeHtml(code)}</code>`));
  // Then math: display, then inline. "$5 and $10" stays text (Pandoc's rule: no space inside the
  // delimiters, and a closing $ isn't followed by a digit); \$ is a literal dollar.
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => parkBlock(math(tex, true)));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => parkBlock(math(tex, true)));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => park(math(tex, false)));
  s = s.replace(/\\\$/g, () => park("$"));
  s = s.replace(/\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g, (_, tex: string) => park(math(tex, false)));

  const inline = (text: string) => renderInline(text, park);
  const html = splitBlocks(s).map((b) => renderBlock(b, inline)).join("");
  // Slots may hold other slots (a link label with math), so restore until none are left.
  let out = html;
  for (let i = 0; i < 3 && out.includes(OPEN); i++) out = out.replace(TOKEN, (_, n: string) => slots[Number(n)] ?? "");
  return out;
}

type Block =
  | { type: "raw"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "hr" }
  | { type: "blockquote"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "table"; rows: string[] }
  | { type: "paragraph"; text: string };

const LIST = /^\s*([-*+]|\d+[.)])\s+/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?/;
const TABLE_ROW = /^(\|?.+\|.+)$/;
const TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/;

function splitBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const isTable = (j: number) => TABLE_ROW.test(lines[j]) && j + 1 < lines.length && TABLE_SEP.test(lines[j + 1]);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (BLOCK_TOKEN.test(line.trim())) {
      blocks.push({ type: "raw", text: line.trim() });
      i++;
    } else if (isTable(i)) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(lines[i++]);
      blocks.push({ type: "table", rows });
    } else if (HEADING.test(line)) {
      const m = line.match(HEADING)!;
      blocks.push({ type: "heading", level: m[1].length, text: m[2].replace(/\s+#+\s*$/, "") });
      i++;
    } else if (RULE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
    } else if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, ""));
      blocks.push({ type: "blockquote", text: quoted.join("\n") });
    } else if (LIST.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && LIST.test(lines[i])) {
        items.push(lines[i++].replace(LIST, ""));
        // Indented continuation lines belong to the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST.test(lines[i])) items[items.length - 1] += `\n${lines[i++].trim()}`;
      }
      blocks.push({ type: ordered ? "ol" : "ul", items });
    } else {
      const para: string[] = [];
      while (
        i < lines.length && lines[i].trim() && !BLOCK_TOKEN.test(lines[i].trim()) && !HEADING.test(lines[i]) &&
        !QUOTE.test(lines[i]) && !LIST.test(lines[i]) && !RULE.test(lines[i]) && !isTable(i)
      ) para.push(lines[i++]);
      blocks.push({ type: "paragraph", text: para.join("\n") });
    }
  }
  return blocks;
}

function renderBlock(b: Block, inline: (t: string) => string): string {
  const lines = (t: string) => inline(t).replace(/\n/g, "<br>");
  switch (b.type) {
    case "raw":
      return b.text;
    case "heading":
      return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
    case "hr":
      return "<hr>";
    case "blockquote":
      return `<blockquote>${lines(b.text)}</blockquote>`;
    case "ul":
    case "ol":
      return `<${b.type}>${b.items.map((it) => `<li>${lines(it)}</li>`).join("")}</${b.type}>`;
    case "table":
      return renderTable(b.rows, inline);
    case "paragraph":
      return `<p>${lines(b.text)}</p>`;
  }
}

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");

function renderTable(rows: string[], inline: (t: string) => string): string {
  const aligns = cells(rows[1]).map((c) => {
    const t = c.trim();
    return /^:-+:$/.test(t) ? "center" : /^-+:$/.test(t) ? "right" : /^:-+$/.test(t) ? "left" : "";
  });
  const cell = (tag: string, text: string, i: number) => `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ""}>${inline(text.trim())}</${tag}>`;
  const head = cells(rows[0]).map((c, i) => cell("th", c, i)).join("");
  const body = rows.slice(2).map((r) => `<tr>${cells(r).map((c, i) => cell("td", c, i)).join("")}</tr>`).join("");
  return `<div class="pg-md-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderInline(text: string, park: (html: string) => string): string {
  let s = text;
  // Links are validated before escaping. Images become links: no remote loads from model output.
  s = s.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, label: string, url: string) =>
    isSafeUrl(url) ? park(link(url, escapeHtml(label || url))) : full);
  s = escapeHtml(s);
  // Bare URLs, trailing punctuation left outside the link.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+?)([.,;:!?)]*(?=\s|$))/g, (_, pre: string, url: string, tail: string) => {
    const raw = url.replace(/&amp;/g, "&");
    return isSafeUrl(raw) ? `${pre}${park(link(raw, url))}${tail}` : `${pre}${url}${tail}`;
  });
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/___([^_]+)___/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s;
}
