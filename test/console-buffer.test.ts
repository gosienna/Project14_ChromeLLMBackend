import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_TOOLS } from "../src/ui/tools/builtin";
import { clearConsoleBuffer, installConsoleBuffer, readConsoleBuffer, type ConsoleMsg } from "../src/ui/tools/console";

const LEVELS = ["debug", "log", "info", "warn", "error"] as const;
const original = Object.fromEntries(LEVELS.map((level) => [level, console[level]])) as Record<(typeof LEVELS)[number], typeof console.log>;

describe("page console buffer", () => {
  beforeEach(() => {
    delete (globalThis as { __localLlmConsole?: unknown }).__localLlmConsole;
    Object.assign(console, original);
    globalThis.addEventListener = () => {};
  });

  afterEach(() => {
    Object.assign(console, original);
    delete (globalThis as { __localLlmConsole?: unknown }).__localLlmConsole;
  });

  it("records messages after install and filters by level", () => {
    installConsoleBuffer();
    console.log("hello");
    console.warn("careful");
    const out = readConsoleBuffer({ level: "warn", maxEntries: 10, clear: false, maxChars: 1000 });
    expect(out.messages.map((m: ConsoleMsg) => m.text)).toEqual(["careful"]);
    expect(out.totalBuffered).toBe(1);
    expect(out.returned).toBe(1);
  });

  it("keeps messages from before a second install and clears them", () => {
    installConsoleBuffer();
    console.info("kept");
    installConsoleBuffer();
    console.info("also");
    expect(readConsoleBuffer({ level: "debug", maxEntries: 10, clear: false, maxChars: 1000 }).messages).toHaveLength(2);
    expect(clearConsoleBuffer()).toEqual({ ok: true });
    expect(readConsoleBuffer({ level: "debug", maxEntries: 10, clear: false, maxChars: 1000 }).messages).toEqual([]);
  });

  it("drops the oldest messages to stay within the character cap", () => {
    installConsoleBuffer();
    console.log("a".repeat(80));
    console.log("b".repeat(80));
    console.log("c".repeat(80));
    const out = readConsoleBuffer({ level: "debug", maxEntries: 10, clear: true, maxChars: 100 });
    expect(out.messages.map((m) => m.text[0])).toEqual(["c"]);
    expect(readConsoleBuffer({ level: "debug", maxEntries: 10, clear: false, maxChars: 1000 }).messages).toEqual([]);
  });

  it("does not close over extension helpers, so Chrome can run it in the page", () => {
    for (const fn of [installConsoleBuffer, readConsoleBuffer, clearConsoleBuffer]) {
      const src = fn.toString();
      expect(src).not.toContain("resolveTabId");
      expect(src).not.toContain("chrome");
    }
  });
});

describe("store permission surface", () => {
  it("does not declare the debugger permission", () => {
    const manifest = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url), "utf8"));
    const declared = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
    expect(declared).not.toContain("debugger");
    expect(manifest.host_permissions).toEqual([]);
    for (const tool of BUILTIN_TOOLS) expect(tool.needs?.permissions ?? []).not.toContain("debugger");
    const consoleTools = BUILTIN_TOOLS.filter((t) => t.name.includes("console"));
    expect(consoleTools.map((t) => t.name).sort()).toEqual(["clear_console_messages", "get_console_messages"]);
    for (const tool of consoleTools) expect(tool.needs).toEqual({ origins: ["<all_urls>"] });
  });
});
