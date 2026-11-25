// Pure DOM drivers for web-chat backends. Injected via chrome.scripting.executeScript, so each
// exported function must be self-contained (no outer closures or imports at runtime).

export type WebUiDriverId = "chatgpt-web" | "gemini-web" | "claude-web";

export interface WebUiBlocked {
  blocked: true;
  reason: string;
}

export interface WebUiOk {
  blocked: false;
}

export interface WebUiRead {
  blocked: false;
  text: string;
  done: boolean;
}

/** Detect login / consent / captcha walls. Runs in the tab. */
export function detectBlocked(): WebUiBlocked | WebUiOk {
  const href = location.href.toLowerCase();
  const title = document.title.toLowerCase();
  const body = (document.body?.innerText ?? "").slice(0, 4000).toLowerCase();
  if (/accounts\.google\.com|signin|login|auth0|claude\.ai\/login|chatgpt\.com\/auth/.test(href)) {
    return { blocked: true, reason: "login" };
  }
  if (/sign in|log in|verify you.?re human|captcha|unusual traffic|before you continue/.test(`${title} ${body}`)) {
    const hasComposer = !!document.querySelector(
      '[data-testid="prompt-textarea"], #prompt-textarea, rich-textarea, [contenteditable="true"]',
    );
    if (!hasComposer) return { blocked: true, reason: "login-or-consent" };
  }
  return { blocked: false };
}

function setNativeValue(el: HTMLElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function fillContentEditable(el: HTMLElement, value: string) {
  el.focus();
  try {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, value);
  } catch {
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  }
}

function clickSend(selectors: string[]): boolean {
  for (const sel of selectors) {
    const btn = document.querySelector(sel) as HTMLButtonElement | null;
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
  }
  return false;
}

function pressEnter(el: HTMLElement) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
}

function fillBox(box: HTMLElement, prompt: string) {
  if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) setNativeValue(box, prompt);
  else fillContentEditable(box, prompt);
}

/** ChatGPT: fill the prompt box and send. */
export function chatgptFillAndSend(prompt: string): WebUiBlocked | WebUiOk {
  const blocked = detectBlocked();
  if (blocked.blocked) return blocked;
  const box =
    (document.querySelector('[data-testid="prompt-textarea"]') as HTMLElement | null) ||
    (document.querySelector("#prompt-textarea") as HTMLElement | null) ||
    (document.querySelector('div[contenteditable="true"]') as HTMLElement | null) ||
    (document.querySelector("textarea") as HTMLTextAreaElement | null);
  if (!box) return { blocked: true, reason: "no-composer" };
  fillBox(box, prompt);
  if (!clickSend(['[data-testid="send-button"]', 'button[aria-label*="Send"]', 'button[data-testid="send-button"]'])) {
    pressEnter(box);
  }
  return { blocked: false };
}

/** ChatGPT: read the latest assistant message. */
export function chatgptRead(): WebUiBlocked | WebUiRead {
  const blocked = detectBlocked();
  if (blocked.blocked) return blocked;
  const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const last = nodes[nodes.length - 1] as HTMLElement | undefined;
  const text = (last?.innerText ?? "").trim();
  const streaming = !!document.querySelector(
    'button[aria-label*="Stop"], button[data-testid="stop-button"], [aria-label="Stop generating"]',
  );
  return { blocked: false, text, done: !!text && !streaming };
}

/** Gemini: fill and send. */
export function geminiFillAndSend(prompt: string): WebUiBlocked | WebUiOk {
  const blocked = detectBlocked();
  if (blocked.blocked) return blocked;
  const box =
    (document.querySelector("rich-textarea .ql-editor") as HTMLElement | null) ||
    (document.querySelector('div[contenteditable="true"]') as HTMLElement | null) ||
    (document.querySelector("textarea") as HTMLTextAreaElement | null);
  if (!box) return { blocked: true, reason: "no-composer" };
  fillBox(box, prompt);
  if (!clickSend(['button[aria-label*="Send"]', "button.send-button", 'button[mattooltip*="Send"]'])) {
    pressEnter(box);
  }
  return { blocked: false };
}

/** Gemini: read the latest model response. */
export function geminiRead(): WebUiBlocked | WebUiRead {
  const blocked = detectBlocked();
  if (blocked.blocked) return blocked;
  const nodes = [
    ...document.querySelectorAll(
      "model-response .response-content, message-content, .model-response-text, [data-message-author-role='model']",
    ),
  ];
  const last = nodes[nodes.length - 1] as HTMLElement | undefined;
  const text = (last?.innerText ?? "").trim();
  const streaming = !!document.querySelector('button[aria-label*="Stop"], button[aria-label*="stop"]');
  return { blocked: false, text, done: !!text && !streaming };
}

/** Claude: fill and send. */
export function claudeFillAndSend(prompt: string): WebUiBlocked | WebUiOk {
  const blocked = detectBlocked();
  if (blocked.blocked) return blocked;
  const box =
    (document.querySelector('div[contenteditable="true"].ProseMirror') as HTMLElement | null) ||
    (document.querySelector('div[contenteditable="true"]') as HTMLElement | null) ||
    (document.querySelector("textarea") as HTMLTextAreaElement | null);
  if (!box) return { blocked: true, reason: "no-composer" };
  fillBox(box, prompt);
  if (!clickSend(['button[aria-label*="Send"]', 'button[aria-label="Send Message"]'])) {
    pressEnter(box);
  }
  return { blocked: false };
}

/** Claude: read the latest assistant message. */
export function claudeRead(): WebUiBlocked | WebUiRead {
  const blocked = detectBlocked();
  if (blocked.blocked) return blocked;
  const nodes = [
    ...document.querySelectorAll(
      '[data-testid="assistant-message"], .font-claude-message, [data-is-streaming], div[class*="assistant"]',
    ),
  ];
  const last = nodes[nodes.length - 1] as HTMLElement | undefined;
  const text = (last?.innerText ?? "").trim();
  const streaming =
    !!document.querySelector('[data-is-streaming="true"], button[aria-label*="Stop"], button[aria-label*="stop"]') ||
    last?.getAttribute("data-is-streaming") === "true";
  return { blocked: false, text, done: !!text && !streaming };
}

export function fillAndSendFor(id: WebUiDriverId): (prompt: string) => WebUiBlocked | WebUiOk {
  if (id === "chatgpt-web") return chatgptFillAndSend;
  if (id === "gemini-web") return geminiFillAndSend;
  return claudeFillAndSend;
}

export function readFor(id: WebUiDriverId): () => WebUiBlocked | WebUiRead {
  if (id === "chatgpt-web") return chatgptRead;
  if (id === "gemini-web") return geminiRead;
  return claudeRead;
}
