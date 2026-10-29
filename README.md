# Agent Browser ToolKit — Chrome extension

An MV3 Chrome extension that serves a language model — running locally in the browser, or through the user's own cloud API keys — to websites the user approves, via a Prompt API–compatible `window.LanguageModel`. Web apps code against the standard API once; the extension supplies the model, loaded a single time and shared across every tab and site.

- **For web developers:** jump to [Using the backend from a web app](#using-the-backend-from-a-web-app).
- **For extension developers:** see [Development](#development), [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) (the plan) and [`docs/STATUS.md`](docs/STATUS.md) (what is built).

```js
const session = await LanguageModel.create();
console.log(await session.prompt("Write a haiku about browsers"));
```

---

## Contents

1. [How it works in one minute](#how-it-works-in-one-minute)
2. [Installing the extension](#installing-the-extension)
3. [Using the backend from a web app](#using-the-backend-from-a-web-app)
   - [What the end user has to do first](#1-what-the-end-user-has-to-do-first)
   - [Detecting the API](#2-detecting-the-api)
   - [Checking availability](#3-checking-availability)
   - [Creating a session](#4-creating-a-session)
   - [Prompting](#5-prompting)
   - [Streaming](#6-streaming)
   - [Conversations and context](#7-conversations-and-context)
   - [Cancelling](#8-cancelling)
   - [Cloning and destroying sessions](#9-cloning-and-destroying-sessions)
   - [Tool calling](#10-tool-calling)
     - [Web search](#web-search-extension-only)
   - [Model information](#11-model-information)
   - [Errors](#12-errors)
   - [Limits](#13-limits)
   - [Falling back when there is no model](#14-falling-back-when-there-is-no-model)
   - [Complete example](#15-complete-example)
   - [Testing your integration](#16-testing-your-integration)
   - [API reference](#api-reference)
   - [Security and privacy notes for app developers](#security-and-privacy-notes-for-app-developers)
4. [Architecture](#architecture)
5. [Development](#development)

---

## How it works in one minute

- Your page calls the standard [Prompt API](https://github.com/webmachinelearning/prompt-api) (`LanguageModel.create()`, `session.prompt()`, …). No SDK, no API key and no server are needed on your side.
- The extension injects `window.LanguageModel` **only into sites the user has enabled**, and asks the user's consent the first time your site creates a session.
- Requests travel from your page to the extension, which runs the model the user picked: an on-device model (Transformers.js, WebLLM, wllama or Chrome's built-in Gemini Nano) or a cloud provider using **the user's own key** (Anthropic, OpenAI, Gemini, xAI, DeepSeek, OpenRouter, Ollama or any OpenAI-compatible endpoint).
- Your page receives only the model's text output.

Code written for Chrome's native Prompt API runs unchanged on the extension, and the other way round.

## Installing the extension

Until it is published on the Chrome Web Store, build and load it unpacked:

```bash
npm install                 # .npmrc sets ignore-scripts (skips onnxruntime-node's binary download)
npm run fetch:webllm-libs   # bundle WebLLM model libraries (store policy: no remote code)
npm run build               # -> dist/
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `dist/`.
2. Open the extension's options page (toolbar icon → **Settings, models and usage**) and pick a local model. Optionally click **Download / load** to fetch the weights now. Otherwise they download on first use (Qwen2.5 0.5B, about 480 MB).
3. Optional: under **Cloud providers**, enable a provider, pick a model and paste your API key. The model picker and the **Models** tables list each provider's current and legacy models with input → output types, context size, reasoning, tool calling and list price (any other model id can be typed in). Defaults: Claude Haiku 5.5, GPT-6 Luna, Gemini 3.8 Flash, Grok 4.3, DeepSeek V4.1 Flash, OpenRouter Auto.
4. To try it out, click the toolbar icon → **Open playground**. It's a chat page inside the extension. Pick the local model or any enabled provider, and attach, paste or drop images. Images work with cloud providers, Chrome's built-in model and local vision models (shown as `text+image→text` in the options). Replies render Markdown (headings, lists, tables, code, links) and LaTeX math (`$…$`, `\(…\)`, `$$…$$`, `\[…\]`, via bundled KaTeX); Session options can switch to plain text. Each reply has a **Raw** view with the exact request the model received and its raw response for every tool round, and **Show raw** previews the next request; **Edit JSON** lets you change it before sending. The **Tools** panel gives the model the extension's own tools: browser automation on your tabs, web search (Tavily with a key from options → Tools, or a Google results page as fallback), tools you write (sandboxed JavaScript), and registry tools that let the model create and edit tools. They're off until you enable them, risky ones ask before each run, and websites never get them. Playground conversations aren't tied to a website and aren't saved.

Requires Chrome 116 or later. Local models run fastest with WebGPU; without it the extension falls back to CPU (wllama). Models larger than about 3.5 GB (up to Qwen3.5 122B) run on wllama with WebGPU and need Chrome 137+ (JSPI and Memory64) and enough GPU memory: unified memory on Apple Silicon, VRAM elsewhere.

---

## Using the backend from a web app

### 1. What the end user has to do first

`window.LanguageModel` does not exist on your site until the user does both of these:

1. **Enable the site.** On your site, they click the extension's toolbar icon, choose **Enable on this site** and accept Chrome's permission prompt, then reload. They can also add the site on the options page.
2. **Grant consent.** The first time your page calls `LanguageModel.create()`, the extension shows a dialog: **Always allow**, **Allow once (this tab)** or **Deny**.

Until step 1, the extension is invisible to your site: it can't be detected at all. Tell your users what to do, for example with an "Enable local AI" hint that links to these steps.

### 2. Detecting the API

The extension injects its script as the page starts loading, so `LanguageModel` is normally defined before your own scripts run:

```js
if ("LanguageModel" in window) {
  // Native Chrome Prompt API or this extension
}

const isExtension = "localLLM" in window; // only the extension defines window.localLLM
```

If your code may run very early, for example from an inline script in `<head>`, wait for the extension's ready event:

```js
function waitForLanguageModel(timeout = 500) {
  if ("LanguageModel" in window) return Promise.resolve(window.LanguageModel);
  return new Promise((resolve) => {
    const done = () => resolve(window.LanguageModel ?? null);
    window.addEventListener("localllm:ready", done, { once: true });
    setTimeout(done, timeout);
  });
}
```

The [`@local-llm/web`](#14-falling-back-when-there-is-no-model) helper does this for you.

**Chrome's built-in model:** if the browser already provides a native `LanguageModel`, the extension leaves it alone. Your page talks to Chrome's model directly unless the user turns on **Override Chrome's native LanguageModel** in the extension's settings.

### 3. Checking availability

```js
const status = await LanguageModel.availability();
```

| Value | Meaning for your site |
| --- | --- |
| `"available"` | Ready. The model is downloaded, or the site uses a cloud backend. |
| `"downloadable"` | Usable, but `create()` will first either ask the user for consent or download the model. Show a progress UI (see below). |
| `"downloading"` | A download is already in progress. |
| `"unavailable"` | The user denied your site, or no backend can run on this device. Use your fallback. |

An origin that hasn't been granted consent yet always sees `"downloadable"`, never `"available"`, so that it doesn't learn the user's model state.

`LanguageModel.params()` returns `{ defaultTopK, maxTopK, defaultTemperature, maxTemperature }` for the backend in use.

### 4. Creating a session

```js
const session = await LanguageModel.create({
  initialPrompts: [
    { role: "system", content: "You are a concise assistant for a recipe site." },
    { role: "user", content: "What is a roux?" },
    { role: "assistant", content: "Equal parts fat and flour cooked together to thicken sauces." },
  ],
  temperature: 0.7, // optional; if you set one of temperature/topK, set both
  topK: 3,
  signal: abortController.signal, // optional
  monitor(m) {
    m.addEventListener("downloadprogress", (e) => {
      progressBar.value = e.loaded; // 0 … 1
    });
  },
});
```

- `create()` resolves once the user has consented and the model is loaded. On the first call this can take a while: the consent dialog, then possibly a model download of several hundred MB.
- `initialPrompts` may start with **one** `system` message; the rest are example turns.
- Options are validated: an unknown role, `temperature` outside 0–2 or a lone `temperature`/`topK` throws.
- Only text is supported. Passing `expectedInputs` or `expectedOutputs` with a type other than `"text"` throws `NotSupportedError`.

### 5. Prompting

```js
const answer = await session.prompt("How do I keep it from going lumpy?");
```

Input can be a string or an array of messages:

```js
await session.prompt([
  { role: "user", content: "Translate to French:" },
  { role: "user", content: [{ type: "text", value: "Good morning" }] },
]);
```

The session remembers the conversation: each `prompt()` sees all previous turns.

Not supported yet: `responseConstraint` (JSON-schema structured output, planned for v2) throws `NotSupportedError`.

### 6. Streaming

`promptStreaming()` returns a `ReadableStream<string>` of text **deltas**, meaning each chunk is new text to append:

```js
output.textContent = "";
for await (const chunk of session.promptStreaming("Explain WebGPU in two paragraphs")) {
  output.textContent += chunk;
}
```

Local and cloud backends stream the same way. Cancelling the stream, for example by breaking out of the loop or calling `reader.cancel()`, stops generation.

#### Reasoning (extension only)

By default a page gets the answer only. To also see a reasoning model's thinking, opt in when you create the session and pass `onReasoning` to `prompt()` or `promptStreaming()`:

```js
const session = await LanguageModel.create({ reasoning: true });
for await (const chunk of session.promptStreaming("Why is the sky blue?", {
  onReasoning: (text) => (thinking.textContent += text), // deltas, kept out of the answer
})) {
  output.textContent += chunk;
}
```

Clones of an opted-in session keep the opt-in. Models that don't reason never call `onReasoning`. Chrome's native API ignores both options.

### 7. Conversations and context

```js
session.inputUsage;  // tokens used by the conversation so far
session.inputQuota;  // the session's maximum (contextUsage / contextWindow are aliases)

await session.measureInputUsage("How long is this?"); // count tokens without sending

await session.append([{ role: "user", content: "Context: the user is vegetarian." }]); // add without generating
```

When a conversation outgrows `inputQuota`, the oldest non-system turns are dropped. If a single prompt is larger than the quota by itself, it rejects with `QuotaExceededError`. The quota is the smaller of the model's context window and the user's **Max context tokens** setting (default 8192).

Token counts come from the model's tokenizer with Transformers.js. For other backends they are estimates (about 4 characters per token).

### 8. Cancelling

Every call takes an `AbortSignal`:

```js
const ac = new AbortController();
stopButton.onclick = () => ac.abort();

try {
  const text = await session.prompt("Write a long story", { signal: ac.signal });
} catch (e) {
  if (e.name === "AbortError") console.log("stopped by user");
  else throw e;
}
```

Aborting stops the generation in the extension: a local model stops generating and a cloud request is cancelled. An aborted turn is not added to the conversation.

### 9. Cloning and destroying sessions

```js
const branch = await session.clone(); // copy of the conversation so far; then independent
await branch.prompt("Alternative answer?");

session.destroy(); // frees the session; any in-flight request rejects with AbortError
```

Always call `destroy()` on sessions you no longer need. Each site may have only **2** open sessions by default. Sessions are also freed automatically when the tab is closed or navigates away.

### 10. Tool calling

Give the session tools at `create()`, in the same shape as Chrome's native Prompt API. When the model decides to use a tool, the extension calls your `execute()` in the page, passes the result back to the model, and `prompt()` resolves with the final answer. Your functions never leave the page; the extension only sees each tool's name, description and input schema.

```js
const session = await LanguageModel.create({
  tools: [
    {
      name: "getWeather",
      description: "Current weather for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      async execute({ city }) {
        const res = await fetch(`/api/weather?city=${encodeURIComponent(city)}`);
        return JSON.stringify(await res.json()); // a string; other values are JSON-encoded
      },
    },
  ],
});

console.log(await session.prompt("Should I take an umbrella in Paris today?"));
```

- **It works with every backend.** Cloud providers (Anthropic, OpenAI-compatible, Gemini) and local GGUF models whose chat template supports tools use their **native** tool calling, except OpenAI's GPT-6 models, which can't call tools over Chat Completions and use prompted calling. Every other local model uses **prompted** tool calling: the tools are described in the system prompt and the model's `<tool_call>` replies are parsed. Prompted calling depends on the model following instructions, so small models may skip tools or call them badly. `localLLM.info()` reports `tools: "native" | "prompted"` for the current backend, and the options page shows the mode per model and engine.
- **Calls run in parallel** when the model asks for several at once. A model may chain up to 8 rounds of tool calls per prompt; after that it must answer without tools.
- **If `execute()` throws,** the model receives `Error: <message>` as the result and can recover or explain.
- **Aborting** the prompt's `signal`, or destroying the session, cancels a prompt that's waiting on a tool. Your `execute()` keeps running; check your own signal if it does long work.
- **Tool results become model input,** and they count toward the context window and the site's token limits. Return only what the model needs.
- `clone()` keeps the tools. Tools must have unique names made of letters, digits, `_` or `-`, and a session can have at most 32. Malformed tools make `create()` throw a `TypeError`.

#### Web search (extension only)

If the user ticks **Allow web search** for your site (options → Sites), your page can search the web through the extension. You can call it directly, or hand the model a ready-made tool:

```js
if (window.localLLM?.capabilities?.search) {
  // Direct: up to 10 results.
  const { provider, results, note } = await localLLM.search("chrome prompt api", { maxResults: 5 });
  // results: [{ title, url, snippet, score }]; provider: "tavily" | "google"

  // With images: also returns images: [{ url, description?, sourceUrl?, thumbnail?, width?, height? }]
  const { images } = await localLLM.search("eiffel tower", { maxResults: 5, includeImages: true });

  // In the model's tool loop: a page-declared tool whose execute() calls localLLM.search().
  const session = await LanguageModel.create({ tools: [localLLM.webSearchTool()] });
  const answer = await session.prompt("What changed in the latest Chrome release? Cite your sources.");
}
```

- **Providers.** The extension uses Tavily with the user's key. When there's no key, or Tavily rejects it or is out of credits (401/403/429/432/433, a 5xx or a network failure), it opens a Google results page in a minimized window, reads the results and closes the window. That fallback needs the user to grant access to google.com (options → Tools). `note` says why the fallback was used.
- **Images.** With `includeImages: true` (or `include_images` in the tool call), Tavily is asked for images with descriptions (same credit). The Google fallback opens the Images tab in the same minimized window after the web results and reads the top results' original image urls. If that page can't be read, you still get the web results, with `images: []` and a `note`.
- **Keeping images.** `localLLM.fetchImage(url)` resolves to `{ url, type, blob }` for an image url this site's own `search()` returned (others are refused with `NotAllowedError`). PNG, JPEG, GIF, WebP, AVIF or BMP up to 8 MB; 30 downloads per minute. Hosts that don't allow cross-site downloads need the user to grant **Images for sites** (options → Tools).
- **Gating.** Search needs the same consent as the model (Always, or an Allow-once grant in the visible tab) **and** the site's web search switch, which is off by default. Without it, `search()` rejects with `NotAllowedError`.
- **Limits.** 10 searches per minute per site (`QuotaExceededError`). Google searches run one at a time, and Google may ask for verification (`NetworkError`).
- `webSearchTool({ name?, maxResults? })` returns `{ name: "web_search", description, inputSchema, execute }`; the result the model sees is the `search()` response as JSON. `@local-llm/web` offers the same as `webSearchTool(found)` and `found.search`.

### 11. Model information

The extension adds a small non-standard namespace, which is absent with Chrome's native API:

```js
if (window.localLLM) {
  const info = await window.localLLM.info();
  // { name: "Qwen2.5 0.5B Instruct (default)", backend: "webllm", images: false, tools: "prompted", version: "0.1.0" }
  // backend is the local engine ("transformers" | "webllm" | "wllama" | "nano"), or the provider name for cloud
}
```

#### Listing the models your site can run

`localLLM.models()` lists the models your site can use **right now**:

- local models whose weights are already downloaded and that can run on this device
- cloud models from providers that the user has set up with an API key and allowed for your site

Your site only sees the backends the user allowed for it, which is the local model alone by default. You never learn about other providers the user has keys for. Models that would need a download first are not listed. If the user denied your site, the list is empty.

```js
const models = await window.localLLM.models(); // the default model comes first
// [
//   { id: "local:qwen3-0.6b", name: "Qwen3 0.6B", backend: "local", provider: "Local", engine: "wllama",
//     default: true, input: ["text"], output: ["text"], contextWindow: 40960, inputQuota: 8192,
//     maxOutputTokens: 8192, reasoning: "hybrid", tools: "native", price: { input: 0, output: 0 }, sizeMB: 378 },
//   { id: "anthropic:claude-haiku-5-5", name: "Claude Haiku 5.5", backend: "anthropic", provider: "Anthropic",
//     default: false, input: ["text", "image", "pdf"], output: ["text"], contextWindow: 1000000, inputQuota: 8192,
//     maxOutputTokens: 8192, reasoning: "hybrid", tools: "native",
//     price: { input: 0.1, output: 0.5, cachedInput: 0.01, long: { above: 100000, input: 0.5, output: 2.5 }, asOf: "2026-10-20" } },
// ]
```

| Field | Meaning |
| --- | --- |
| `id` | `"local:<model>"` or `"<provider>:<model>"`; pass it to `create({ model })` |
| `name`, `provider`, `backend` | Display name, `"Local"` or the provider's name, and `"local"` or the provider id |
| `engine` | Local models only: `"webllm"`, `"transformers"`, `"wllama"`, `"nano"` or `"dummy"` |
| `default` | What `create()` uses when you don't pass `model` |
| `input`, `output` | What the model accepts (`text`, `image`, `audio`, `video`, `pdf`) and produces (`text`). Pages can send text only for now |
| `contextWindow` | The model's maximum context in tokens |
| `inputQuota` | The context a session actually gets: the smaller of `contextWindow` and the user's limit |
| `maxOutputTokens` | The longest reply a session allows |
| `reasoning` | `"hybrid"` (can skip thinking) or `"always"`; absent for models that don't reason. Your page gets the answer only, unless it opts in with `create({ reasoning: true })` |
| `tools` | `"native"` or `"prompted"` tool calling |
| `price` | List price in USD per million tokens (`input`, `output`, optional `cachedInput`, `long` for long-prompt rates, `note`, `asOf`). Local models are `{ input: 0, output: 0 }`; `null` means unknown, or that the price depends on where a router sends the request |
| `sizeMB`, `legacy` | Download size of a local model; an older cloud model the provider still serves |

#### Choosing a model

Pass a listed `id` to `create()`. Chrome's native API ignores the option.

```js
const session = await LanguageModel.create({ model: "anthropic:claude-haiku-5-5" });
```

- The extension accepts only ids from your site's current list. Any other id rejects with `NotSupportedError`.
- A model you choose is used as is: the extension never falls back to another backend for it.
- The first `create()` still shows the consent dialog. It names the model you chose, and for cloud models it warns that prompts leave the device.
- Only one local model is loaded at a time. If sites use different local models, the extension reloads weights between their turns, which is slow for large models.

### 12. Errors

All failures reject with a `DOMException`. Check `error.name`:

| `name` | When | Suggested handling |
| --- | --- | --- |
| `NotAllowedError` | The user denied consent or revoked the site; a background tab tried to use the model without "Always" consent; a cloud key is missing or locked; `localLLM.search()` without the site's web search switch, or with no search provider set up | Fall back; explain how to enable |
| `QuotaExceededError` | Too many open sessions; a per-minute, daily or monthly token limit reached; a prompt larger than the context window | Destroy unused sessions, retry later, or shorten input |
| `AbortError` | Your `signal` was aborted, or the session was destroyed | Usually ignore |
| `InvalidStateError` | The session was destroyed, or the extension restarted and lost it | Create a new session |
| `NotSupportedError` | Non-text modality; `responseConstraint`; no model can run on this device; `create({ model })` with an id that isn't in `localLLM.models()` | Fall back, or list the models again |
| `NetworkError` | A cloud provider was unreachable or returned an error | Retry or fall back |
| `DataError` | A cloud provider rejected the request (for example an invalid model name) | Fall back |
| `OperationError` | The extension restarted mid-request, or an internal error | Retry once with a new session |

Invalid arguments, such as a bad role or a malformed message array, throw a plain `TypeError`.

### 13. Limits

The user can change all of these in the extension's options; the defaults are:

| Limit | Default | Error when exceeded |
| --- | --- | --- |
| Open sessions per site | 2 | `QuotaExceededError` on `create()`/`clone()` |
| Tokens per minute per site | 20,000 | `QuotaExceededError` on `prompt()` |
| Tokens per day per site | 200,000 | `QuotaExceededError` |
| Max context per session | 8,192 tokens | Oldest turns dropped; `QuotaExceededError` if one prompt is too large |
| Monthly tokens per cloud provider | 2,000,000 | `QuotaExceededError` |
| Web searches per minute per site | 10 (fixed) | `QuotaExceededError` on `localLLM.search()` |

Also:
- Local generation is queued: one request runs at a time across all sites, so expect some waiting under load.
- Background tabs can only start generation if the user chose **Always allow** for your site.
- Only the top-level page gets the API. Iframes, including same-origin ones, don't.

### 14. Falling back when there is no model

Plan for the model to be missing: the extension isn't installed, the site isn't enabled, the user denied it, or the device can't run a model. The [`@local-llm/web`](packages/web) helper in this repository wraps detection and fallback. It isn't published to npm yet: build it from `packages/web` (`npm run build` there) or copy `packages/web/src/index.ts` into your project.

```js
import { createOrFallback, detect, getLanguageModel } from "@local-llm/web";

detect(); // "native" | "extension" | null, synchronous

const found = await getLanguageModel({ timeout: 500 }); // waits for the extension to inject
if (found) console.log(found.source, await found.info());

// Create a session, or run your fallback with a reason
const session = await createOrFallback({
  create: { initialPrompts: [{ role: "system", content: "Be brief." }] },
  fallback: (reason) => {
    console.warn("No local model:", reason); // "no-implementation" | "unavailable" | "NotAllowedError: …"
    return null;
  },
});
```

A common pattern is to use the local model when present and your own server otherwise:

```js
async function ask(question) {
  const session = await createOrFallback({ fallback: () => null });
  if (!session) {
    const res = await fetch("/api/ask", { method: "POST", body: JSON.stringify({ question }) });
    return res.text();
  }
  try {
    return await session.prompt(question);
  } finally {
    session.destroy();
  }
}
```

### 15. Complete example

A chat box with streaming, a stop button, download progress and fallback, in plain HTML and JavaScript:

```html
<div id="log"></div>
<progress id="dl" max="1" hidden></progress>
<form id="f"><input id="q" autocomplete="off" /><button>Send</button><button type="button" id="stop">Stop</button></form>

<script type="module">
  const log = document.getElementById("log");
  const dl = document.getElementById("dl");
  let session, ac;

  async function getSession() {
    if (session) return session;
    if (!("LanguageModel" in window)) throw new Error("Enable the Agent Browser ToolKit extension on this site.");
    if ((await LanguageModel.availability()) === "unavailable") throw new Error("No model available.");
    session = await LanguageModel.create({
      initialPrompts: [{ role: "system", content: "You are a helpful, concise assistant." }],
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => { dl.hidden = e.loaded >= 1; dl.value = e.loaded; });
      },
    });
    return session;
  }

  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const q = document.getElementById("q").value;
    const out = log.appendChild(document.createElement("p"));
    ac = new AbortController();
    try {
      const s = await getSession();
      for await (const chunk of s.promptStreaming(q, { signal: ac.signal })) out.textContent += chunk;
    } catch (err) {
      if (err.name === "AbortError") return;
      if (err.name === "InvalidStateError") session = null; // lost; recreate next time
      out.textContent = `⚠ ${err.name}: ${err.message}`;
    }
  };
  document.getElementById("stop").onclick = () => ac?.abort();
  addEventListener("pagehide", () => session?.destroy());
</script>
```

### 16. Testing your integration

- **Local origin:** serve your app (for example `http://localhost:3000`), then enable that origin from the toolbar icon or the options page. Ports are respected: enabling `localhost:3000` doesn't enable `localhost:8080`.
- **Without downloading a model:** in the extension's options, set the model to **Echo (test engine, no model)**. Every prompt then returns `Echo #<turn>: <your text>`, which is instant and deterministic, so it suits UI work and automated tests.
- **Conformance page:** `npm run demo`, open http://localhost:8787 and enable that origin. It runs a checklist (availability, create, prompt, streaming, abort, clone, destroy, errors) against whichever implementation is present, the extension or Chrome's native one.
- **Reset consent:** the options page has **Reset consent** and **Revoke** per site, to replay the first-run experience.

### API reference

| Member | Notes |
| --- | --- |
| `LanguageModel.availability(options?)` | `"available" \| "downloadable" \| "downloading" \| "unavailable"`; reflects consent state |
| `LanguageModel.params()` | `{ defaultTopK, maxTopK, defaultTemperature, maxTemperature }` |
| `LanguageModel.create(options?)` | `initialPrompts`, `temperature` + `topK`, `signal`, `monitor`, `expectedInputs`/`expectedOutputs` (text only) |
| `session.prompt(input, { signal })` | Resolves with the full text |
| `session.promptStreaming(input, { signal })` | `ReadableStream<string>` of deltas |
| `session.append(input, { signal })` | Adds messages without generating |
| `session.measureInputUsage(input)` | Token count (`countPromptTokens` alias) |
| `session.inputUsage`, `session.inputQuota` | Also as `contextUsage`, `contextWindow` |
| `session.temperature`, `session.topK` | Effective sampling values |
| `session.clone({ signal })` | Copies the conversation |
| `session.destroy()` | Frees the session |
| `LanguageModel.create({ tools })` | Tools with `execute()`, run in the page; see [Tool calling](#10-tool-calling) |
| `window.localLLM.info()` | Extension only: `{ name, backend, images, tools, version }` |
| `window.localLLM.models()` | Extension only: the models your site can run now; see [Model information](#11-model-information) |
| `LanguageModel.create({ model })` | Extension only: a `localLLM.models()` id; ignored by Chrome's native API |
| `LanguageModel.create({ reasoning: true })` + `prompt*(input, { onReasoning })` | Extension only: deltas of a reasoning model's thinking; see [Reasoning](#reasoning-extension-only) |
| `window.localLLM.search(query, { maxResults, includeImages, signal })` | Extension only, when the user allowed web search for the site: `{ query, provider, results, images?, note? }`; see [Web search](#web-search-extension-only) |
| `window.localLLM.fetchImage(url, { signal })` | Extension only: `{ url, type, blob }` for an image this site's search returned |
| `window.localLLM.webSearchTool({ name, maxResults })` | Extension only: a `web_search` tool for `create({ tools })` |
| `window.localLLM.capabilities` | Extension only: `{ search: true, imageSearch: true, fetchImage: true }` in versions with web search, image results and image downloads |
| `window.localLLM.version`, `window.localLLM.overridesNative` | Extension only |
| `localllm:ready` event on `window` | Fired when the extension's API is injected |
| `localllm:closed` event on `window` | Extension only: the connection closed. `detail.reason` is `"idle"` (no requests for 25s; the page's sessions are destroyed), `"disconnected"` or `"unresponsive"` (reload the page). The next call reconnects |
| Not yet | `responseConstraint`, image/audio input from pages, `quotaoverflow` event |

### Security and privacy notes for app developers

- **Your site never handles keys or model files.** Cloud keys stay inside the extension; your page receives model output only.
- **The user controls the backend.** A site may be served by a local model or by a cloud provider the user allowed for it. Your site can pick among those models with `create({ model })`, but never outside them. When cloud is used, the consent dialog tells the user that prompts leave their device and are billed to their key. Don't assume prompts stay on the device.
- **All scripts on an approved site share access.** Once the user approves your origin, any script running on it can call the model, third-party ads and analytics included. Keep untrusted scripts off pages that use it, or use a dedicated subdomain.
- **No browsing data crosses over.** The API exposes text generation and, where the user allows it, web search results. No page content, tabs, history or other extension features. The Google fallback's window runs in the user's profile, so results may be personalized; the page gets only titles, urls and snippets.
- **Usage is visible to the user.** The extension logs origin, time and token counts (never prompt text), and the user can revoke your site at any time. Handle `NotAllowedError` gracefully.

---

## Architecture

```
page ── window.LanguageModel (polyfill.js, MAIN world, holds no model)
  │  MessageChannel + per-page nonce
  ▼
content script relay (bridge.js, ISOLATED world: schema check, visibility)
  │  chrome.runtime port
  ▼
service worker (router: origin from port.sender only, consent, rate limits, spend caps)   ← trust boundary
  │  chrome.runtime port
  ▼
offscreen host (sessions, FIFO queue, one loaded model)
  ├─ local:  Transformers.js · WebLLM · wllama · Chrome built-in (Nano) · echo (tests)
  └─ cloud:  AnthropicAdapter · GeminiAdapter · OpenAICompatAdapter (OpenAI, xAI, DeepSeek, OpenRouter, Ollama, LM Studio, …)
```

- The page-side stub only tracks request ids; it holds no model and has no extension privileges.
- The service worker trusts only the origin Chrome reports for the connection, never anything inside a message, and validates every message against a strict schema.
- The offscreen host loads the model once for every tab and site and streams text pieces back up the same path.
- The playground (`ui/playground.html`) opens its own port to the service worker. Only that extension page may use it. Because it's the user's own UI, it may pick the backend and attach images, and it skips the site consent gate. Provider spend caps still apply, and keys still stay in the service worker.

See `CLAUDE.md` for the source layout and the rules each layer follows.

## Development

| Command | What it does |
| --- | --- |
| `npm run build` | Production build to `dist/` (readable, not minified) |
| `npm run watch` | Rebuild on change |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests (protocol, policy, limits, SSE, adapters, keystore, helper package) |
| `npm run test:e2e` | Builds `dist-test/` and runs Playwright against the unpacked extension with the echo engine |
| `npm run demo` | Serves the conformance page on http://localhost:8787 |
| `npm run fetch:webllm-libs` | Downloads WebLLM model libraries into `vendor/webllm-libs/` for bundling |
| `npm run pack` | Builds `dist/` and writes `release/local-llm-<version>.zip` for the Chrome Web Store. See [`docs/STORE.md`](docs/STORE.md) |

Further docs: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md), [`docs/STATUS.md`](docs/STATUS.md), [`docs/STORE.md`](docs/STORE.md) (Chrome Web Store notes).
