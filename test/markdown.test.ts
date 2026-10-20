import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/ui/markdown";

const md = renderMarkdown;

describe("renderMarkdown", () => {
  it("renders headings, emphasis, lists, quotes, rules and code", () => {
    expect(md("# Title\n## Sub")).toBe("<h1>Title</h1><h2>Sub</h2>");
    expect(md("**bold** and *it* and ~~old~~")).toBe("<p><strong>bold</strong> and <em>it</em> and <del>old</del></p>");
    expect(md("- a\n- b\n\n1. one\n2. two")).toBe("<ul><li>a</li><li>b</li></ul><ol><li>one</li><li>two</li></ol>");
    expect(md("> quoted\n\n---")).toBe("<blockquote>quoted</blockquote><hr>");
    expect(md("```js\nconst a = '<b>';\n```")).toBe('<pre class="pg-md-code"><code data-lang="js">const a = &#39;&lt;b&gt;&#39;;</code></pre>');
    expect(md("line one\nline two")).toBe("<p>line one<br>line two</p>");
  });

  it("renders tables with alignment", () => {
    const html = md("| a | b |\n|:-|-:|\n| 1 | 2 |");
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
  });

  it("links only http(s) and mailto, in a new tab", () => {
    expect(md("[site](https://example.com/a?x=1&y=2)")).toBe('<p><a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">site</a></p>');
    expect(md("see https://example.com/path.")).toBe('<p>see <a href="https://example.com/path" target="_blank" rel="noopener noreferrer">https://example.com/path</a>.</p>');
    expect(md("[x](javascript:alert(1))")).not.toContain("<a");
    expect(md("![pic](https://evil.example/t.png)")).not.toContain("<img");
  });

  it("escapes raw HTML", () => {
    const html = md('<script>alert(1)</script> <img src=x onerror="alert(1)">');
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders inline and display math with KaTeX", () => {
    expect(md("area $\\pi r^2$ here")).toMatch(/<p>area <span class="katex">.*<\/span> here<\/p>/s);
    expect(md("inline \\(a_1 + b_1\\)")).toContain('class="katex"');
    expect(md("$$\\frac{a}{b}$$")).toContain('class="katex-display"');
    expect(md("\\[\nx = 1\n\\]")).toContain('class="katex-display"');
    // Display math is its own block, not inside a paragraph.
    expect(md("before\n$$x$$\nafter")).toMatch(/^<p>before<\/p><span class="katex-display">.*<p>after<\/p>$/s);
  });

  it("keeps underscores and stars inside math away from emphasis", () => {
    const html = md("$a_i * b_i$ and $x_j$");
    expect(html).not.toContain("<em>");
    expect(html.match(/class="katex"/g)).toHaveLength(2);
  });

  it("leaves dollars that aren't math alone", () => {
    expect(md("It costs $5 and $10.")).toBe("<p>It costs $5 and $10.</p>");
    expect(md("a literal \\$ sign")).toBe("<p>a literal $ sign</p>");
    expect(md("`$x$` in code")).toBe("<p><code>$x$</code> in code</p>");
    expect(md("```\n$$y$$\n```")).not.toContain("katex");
  });

  it("survives bad TeX and unfinished input while streaming", () => {
    expect(() => md("$\\frac{1}{$ and $$\\undefinedcommand$$")).not.toThrow();
    expect(md("$$\\undefinedcommand$$")).toContain("katex");
    expect(md("half $x^2")).toBe("<p>half $x^2</p>");
    expect(md("```js\nlet a")).toBe("<p>```js<br>let a</p>");
  });
});
