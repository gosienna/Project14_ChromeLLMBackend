// The extension's own tools for the playground: browser automation and web search ported from
// Project05 (mcp/register-tools.js), plus the registry tools that let the model manage tools.
// Definitions are seeded into IndexedDB (registry.ts); the implementations live here, by name.

import * as browser from "./browser";
import * as consoleTools from "./console";

export type ToolGroup = "browser" | "web" | "registry" | "custom";

type Args = Record<string, unknown>;

export interface ToolContext {
  /** Search the web through the extension (the Tavily key never reaches this page). */
  webSearch(args: Args): Promise<unknown>;
  /** Registry tools (meta.ts) bind these. */
  registry: {
    list(args: Args): Promise<unknown>;
    get(args: Args): Promise<unknown>;
    create(args: Args): Promise<unknown>;
    update(args: Args): Promise<unknown>;
    remove(args: Args): Promise<unknown>;
  };
}

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  group: ToolGroup;
  /** Default for "Ask before running": on for anything that acts or writes. */
  confirm: boolean;
  /** Optional permissions the tool needs, requested when the user enables it. */
  needs?: { permissions?: chrome.runtime.ManifestPermission[]; origins?: string[] };
  run(args: Args, ctx: ToolContext): Promise<unknown> | unknown;
}

const TAB_ID = { type: "integer", description: "Target tab id (defaults to the most recently used web page)" };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const PAGES = { origins: ["<all_urls>"] };

export const BUILTIN_TOOLS: BuiltinTool[] = [
  {
    name: "web_search",
    group: "web",
    confirm: false,
    description:
      "Search the public web for current information. Returns titles, URLs, and relevant snippets (from Tavily, or a Google results page when Tavily isn't available), plus image URLs when include_images is true. Use when the user asks about recent events, facts you are unsure of, anything that may have changed since training, or wants pictures of something.",
    inputSchema: obj(
      {
        query: { type: "string", description: "Search query" },
        max_results: { type: "integer", description: "Number of results to return (1-10)", minimum: 1, maximum: 10 },
        include_images: { type: "boolean", description: "Also return image URLs (with descriptions when available)" },
      },
      ["query"],
    ),
    run: (args, ctx) => ctx.webSearch(args),
  },
  {
    name: "browser_snapshot",
    group: "browser",
    confirm: false,
    needs: PAGES,
    description:
      "Capture accessibility snapshot of the current page, this is better than screenshot. Returns YAML with element refs like [ref=e5]. Use refs as the target in browser_click.",
    inputSchema: obj({
      tabId: TAB_ID,
      target: { type: "string", description: "Optional element ref from a prior snapshot (e.g. e5) to snapshot a subtree; omit for full page" },
      depth: { type: "integer", description: "Limit the depth of the snapshot tree" },
      boxes: { type: "boolean", description: "Include each element's bounding box as [box=x,y,width,height]" },
      maxChars: { type: "integer", description: "Max snapshot characters to return (default 14000)" },
    }),
    run: browser.browser_snapshot,
  },
  {
    name: "browser_click",
    group: "browser",
    confirm: true,
    needs: PAGES,
    description: "Perform click on a web page. Pass target as a ref from browser_snapshot (e.g. e5) or a CSS selector.",
    inputSchema: obj(
      {
        tabId: TAB_ID,
        target: { type: "string", description: "Element ref from browser_snapshot (e.g. e5) or a CSS selector" },
        element: { type: "string", description: "Human-readable element description (optional)" },
        doubleClick: { type: "boolean", description: "Whether to perform a double click instead of a single click" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Button to click, defaults to left" },
        modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] }, description: "Modifier keys to press" },
      },
      ["target"],
    ),
    run: browser.browser_click,
  },
  {
    name: "read_page",
    group: "browser",
    confirm: false,
    needs: PAGES,
    description: "Return visible text from a browser tab.",
    inputSchema: obj({ tabId: TAB_ID, maxChars: { type: "integer", description: "Max characters to return (default 14000)" } }),
    run: browser.read_page,
  },
  {
    name: "get_links",
    group: "browser",
    confirm: false,
    needs: PAGES,
    description: "Return links (text + href) from a browser tab.",
    inputSchema: obj({ tabId: TAB_ID }),
    run: browser.get_links,
  },
  {
    name: "get_page_html",
    group: "browser",
    confirm: false,
    needs: PAGES,
    description:
      "Return raw HTML from a live browser tab (after JS rendering). Omit selector for full document; pass selector for one element's outerHTML. Use before modify_element to pick selectors.",
    inputSchema: obj({
      tabId: TAB_ID,
      selector: { type: "string", description: "Optional CSS selector; omit for full document HTML" },
      maxChars: { type: "integer", description: "Max characters (default 14000)" },
    }),
    run: browser.get_page_html,
  },
  {
    name: "list_tabs",
    group: "browser",
    confirm: false,
    needs: PAGES,
    description: "List open browser tabs (id, title, url, active).",
    inputSchema: obj({}),
    run: browser.list_tabs,
  },
  {
    name: "open_tab",
    group: "browser",
    confirm: true,
    needs: PAGES,
    description: "Open a new browser tab at the given URL.",
    inputSchema: obj({ url: { type: "string", description: "URL to open" } }, ["url"]),
    run: browser.open_tab,
  },
  {
    name: "navigate",
    group: "browser",
    confirm: true,
    needs: PAGES,
    description: "Navigate a tab to a URL.",
    inputSchema: obj({ tabId: TAB_ID, url: { type: "string", description: "URL to navigate to" } }, ["url"]),
    run: browser.navigate,
  },
  {
    name: "click",
    group: "browser",
    confirm: true,
    needs: PAGES,
    description: "Click an element by CSS selector or visible button/link text.",
    inputSchema: obj({ tabId: TAB_ID, selector: { type: "string", description: "CSS selector or visible text to match" } }, ["selector"]),
    run: browser.click,
  },
  {
    name: "type_text",
    group: "browser",
    confirm: true,
    needs: PAGES,
    description: "Type text into an input or textarea matching a CSS selector.",
    inputSchema: obj(
      { tabId: TAB_ID, selector: { type: "string", description: "CSS selector for the input" }, text: { type: "string", description: "Text to type" } },
      ["selector", "text"],
    ),
    run: browser.type_text,
  },
  {
    name: "scroll",
    group: "browser",
    confirm: false,
    needs: PAGES,
    description: 'Scroll the tab one screen "up" or "down".',
    inputSchema: obj({ tabId: TAB_ID, direction: { type: "string", enum: ["up", "down"], description: "Scroll direction" } }),
    run: browser.scroll,
  },
  {
    name: "modify_element",
    group: "browser",
    confirm: true,
    needs: PAGES,
    description:
      "Change DOM content or styles on a tab. Provide selector plus at least one of styles (camelCase CSS), text (textContent), or innerHTML. Set all:true to update up to 100 matches. Reload reverts changes.",
    inputSchema: obj(
      {
        tabId: TAB_ID,
        selector: { type: "string", description: "CSS selector for target element(s)" },
        styles: { type: "object", description: 'CamelCase CSS properties, e.g. { color: "red", fontSize: "2rem" }', additionalProperties: { type: "string" } },
        text: { type: "string", description: "Set element textContent" },
        innerHTML: { type: "string", description: "Set element innerHTML" },
        all: { type: "boolean", description: "Apply to all matching elements (max 100)" },
      },
      ["selector"],
    ),
    run: browser.modify_element,
  },
  {
    name: "execute_script",
    group: "browser",
    confirm: true,
    needs: PAGES,
    description:
      "Run a JavaScript function in the tab (MAIN world: DOM access yes, page JS globals visible). script is a function source string; args is an optional array passed to it. Return value must be JSON-serializable.",
    inputSchema: obj(
      {
        tabId: TAB_ID,
        script: { type: "string", description: 'Function source, e.g. "() => document.title" or "(sel) => ..."' },
        args: { type: "array", description: "Optional arguments passed to the function", items: {} },
      },
      ["script"],
    ),
    run: browser.execute_script,
  },
  {
    name: "wait",
    group: "browser",
    confirm: false,
    description: "Pause for a number of milliseconds (max 15000).",
    inputSchema: obj({ ms: { type: "integer", description: "Milliseconds to wait" } }),
    run: browser.wait,
  },
  {
    name: "fetch_url",
    group: "browser",
    confirm: false,
    needs: PAGES,
    description: "Fetch a URL's text content without opening a tab.",
    inputSchema: obj({ url: { type: "string", description: "URL to fetch" }, maxChars: { type: "integer", description: "Max characters (default 12000)" } }, ["url"]),
    run: browser.fetch_url,
  },
  {
    name: "download_file",
    group: "browser",
    confirm: true,
    needs: { permissions: ["downloads"] },
    description:
      "Download a file from a URL directly to the user's Downloads folder (e.g. PDFs that would open inline when clicked). Returns { ok, filename, fileSize } when complete.",
    inputSchema: obj(
      {
        url: { type: "string", description: "HTTP(S) URL of the file to download" },
        filename: { type: "string", description: "Optional filename (relative to Downloads)" },
        saveAs: { type: "boolean", description: "If true, show the system Save As dialog (default false)" },
        timeoutMs: { type: "integer", description: "Max wait for download to finish in ms (default 120000, max 300000)" },
      },
      ["url"],
    ),
    run: browser.download_file,
  },
  {
    name: "get_console_messages",
    group: "browser",
    confirm: false,
    needs: { permissions: ["debugger"], origins: ["<all_urls>"] },
    description:
      "Return DevTools-style console messages for a tab (console.log/warn/error, uncaught exceptions). Attaches the Chrome debugger on first use (Chrome shows a debugging banner); only messages after that are available.",
    inputSchema: obj({
      tabId: TAB_ID,
      level: { type: "string", enum: ["debug", "log", "info", "warn", "error"], description: "Minimum severity to return (default: all)" },
      maxEntries: { type: "integer", description: "Max messages to return (default 100)" },
      clear: { type: "boolean", description: "If true, clear the buffer after reading (default false)" },
      maxChars: { type: "integer", description: "Max characters in the returned payload (default 14000)" },
    }),
    run: consoleTools.get_console_messages,
  },
  {
    name: "clear_console_messages",
    group: "browser",
    confirm: false,
    needs: { permissions: ["debugger"], origins: ["<all_urls>"] },
    description: "Clear buffered console messages for a tab. Does not detach the debugger.",
    inputSchema: obj({ tabId: TAB_ID }),
    run: consoleTools.clear_console_messages,
  },
  {
    name: "list_tools",
    group: "registry",
    confirm: false,
    description: "List the tools in the extension's tool registry (built-in and custom), with whether each is enabled.",
    inputSchema: obj({ group: { type: "string", enum: ["browser", "web", "registry", "custom"], description: "Only this group (optional)" } }),
    run: (args, ctx) => ctx.registry.list(args),
  },
  {
    name: "get_tool",
    group: "registry",
    confirm: false,
    description: "Load one tool from the registry: its description, input schema and, for custom tools, its code.",
    inputSchema: obj({ name: { type: "string", description: "Tool name" } }, ["name"]),
    run: (args, ctx) => ctx.registry.get(args),
  },
  {
    name: "create_tool",
    group: "registry",
    confirm: true,
    description:
      "Create a custom tool. code is the body of an async JavaScript function that receives `args` (the parsed arguments) and `api` (api.callTool(name, args) runs another enabled tool) and returns the result. It runs in a sandbox without extension or page access. The tool can be used from the next chat.",
    inputSchema: obj(
      {
        name: { type: "string", description: "Letters, digits, _ or -" },
        description: { type: "string", description: "What the tool does, for the model" },
        inputSchema: { type: "object", description: "JSON Schema of the arguments object" },
        code: { type: "string", description: "Async function body, e.g. \"return { sum: args.a + args.b };\"" },
      },
      ["name", "description", "code"],
    ),
    run: (args, ctx) => ctx.registry.create(args),
  },
  {
    name: "update_tool",
    group: "registry",
    confirm: true,
    description:
      "Edit a tool in the registry. Custom tools: any of description, inputSchema, code, enabled. Built-in tools: description, inputSchema or enabled. Changes apply from the next chat.",
    inputSchema: obj(
      {
        name: { type: "string", description: "Tool to edit" },
        description: { type: "string" },
        inputSchema: { type: "object" },
        code: { type: "string" },
        enabled: { type: "boolean" },
      },
      ["name"],
    ),
    run: (args, ctx) => ctx.registry.update(args),
  },
  {
    name: "delete_tool",
    group: "registry",
    confirm: true,
    description: "Delete a custom tool from the registry. Built-in tools can't be deleted, only disabled.",
    inputSchema: obj({ name: { type: "string", description: "Custom tool to delete" } }, ["name"]),
    run: (args, ctx) => ctx.registry.remove(args),
  },
];

export const findBuiltin = (name: string) => BUILTIN_TOOLS.find((t) => t.name === name);
