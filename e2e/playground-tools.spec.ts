import type { Page } from "@playwright/test";
import { PAGE, expect, test } from "./fixtures";

// The echo engine calls a tool when the message is "/tool <name> <json>" and the tool was offered.

async function openPlayground(context: import("@playwright/test").BrowserContext, extId: string) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/playground.html`);
  await expect(page.locator(".pg-head")).toContainText("on dummy");
  return page;
}

async function say(page: Page, text: string) {
  const message = page.getByLabel("Message", { exact: true });
  await message.fill(text);
  await message.press("Enter");
}

/** Enable registry tools by writing IndexedDB directly (the UI would ask Chrome for permissions). */
async function enableTools(page: Page, names: string[]) {
  await page.evaluate(async (names) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("local-llm-tools", 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction("tools", "readwrite");
    const store = tx.objectStore("tools");
    for (const name of names) {
      const rec = await new Promise<any>((res) => (store.get(name).onsuccess = (e) => res((e.target as IDBRequest).result)));
      store.put({ ...rec, enabled: true, confirm: false });
    }
    await new Promise((res) => (tx.oncomplete = res));
    db.close();
  }, names);
}

test("each reply's Raw view shows the request sent and the response", async ({ context, sw }) => {
  const page = await openPlayground(context, new URL(sw.url()).host);
  await say(page, "hello raw");
  const reply = page.locator(".pg-assistant").nth(0);
  await expect(reply.locator(":scope > .pg-text")).toHaveText("Echo #1: hello raw");
  await reply.getByRole("button", { name: "Raw" }).click();
  const raw = reply.locator(".pg-raw");
  await expect(raw).toContainText("Sent to dummy");
  await expect(raw.locator(".pg-raw-section").first()).toContainText('"hello raw"');
  await expect(raw.locator(".pg-raw-section").last()).toContainText("Echo #1: hello raw");
});

test("an edited request replaces the conversation for the next Send", async ({ context, sw }) => {
  const page = await openPlayground(context, new URL(sw.url()).host);
  await page.getByRole("button", { name: "Show raw" }).click();
  await page.getByRole("button", { name: "Edit JSON" }).click();
  const editor = page.getByLabel("Request JSON");
  await editor.fill(JSON.stringify({ messages: [{ role: "user", content: "a bad one" }, { role: "assistant", content: "x" }] }));
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(".pg-pending-raw")).toContainText("last message must be the user turn");
  await editor.fill(JSON.stringify({ messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: "edited turn" }] }));
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(".pg-pending-raw")).toContainText("Custom request");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".pg-notice")).toContainText("edited request");
  // Two user turns in the edited history: the echo engine counts them.
  await expect(page.locator(".pg-assistant .pg-text").last()).toHaveText("Echo #2: edited turn");
  await expect(page.getByLabel("System prompt")).toHaveValue("Be terse.");
});

test("a custom tool from the Tools panel runs in the sandbox, after asking", async ({ context, sw }) => {
  const page = await openPlayground(context, new URL(sw.url()).host);
  await page.locator(".pg-tools-box > summary").click();
  await page.getByRole("button", { name: "Add tool" }).click();
  await page.getByLabel("Tool name").fill("add");
  await page.getByLabel("Description").fill("Add a and b");
  await page.getByLabel("Code").fill("return { sum: args.a + args.b };");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".pg-tools")).toContainText("Saved add");

  await say(page, '/tool add {"a":2,"b":3}');
  const card = page.locator(".pg-toolcall").last();
  await expect(card).toContainText("Run add?");
  await card.getByRole("button", { name: "Run" }).click();
  await expect(page.locator(".pg-assistant > .pg-text").last()).toHaveText('Tool add said: {"sum":5}');

  await say(page, '/tool add {"a":1,"b":1}');
  await page.locator(".pg-toolcall").last().getByRole("button", { name: "Deny" }).click();
  await expect(page.locator(".pg-assistant > .pg-text").last()).toHaveText("Tool add said: Error: The user declined to run this tool");
});

test("registry tools let the model read the tool list", async ({ context, sw }) => {
  const page = await openPlayground(context, new URL(sw.url()).host);
  await enableTools(page, ["list_tools"]);
  await say(page, '/tool list_tools {"group":"registry"}');
  await expect(page.locator(".pg-assistant > .pg-text").last()).toContainText('"name":"create_tool"');
});

test("browser tools read the most recently used web page", async ({ context, sw }) => {
  const site = await context.newPage();
  await site.goto(PAGE);
  const page = await openPlayground(context, new URL(sw.url()).host);
  await enableTools(page, ["read_page", "list_tabs"]);
  await say(page, "/tool read_page {}");
  await expect(page.locator(".pg-assistant > .pg-text").last()).toHaveText("Tool read_page said: test page");
  await say(page, "/tool list_tabs {}");
  await expect(page.locator(".pg-assistant > .pg-text").last()).toContainText("e2e page");
});
