# LearnWithLLM: Clean and Debug modes

## Context

The dialogue hides almost everything that happens in a turn:
- Text from every tool round is merged into one bubble.
- Tool calls show up only as "Updating the lesson…".
- The fallback in `turn.ts` silently swaps the streamed reply for "I put the lesson on the whiteboard.".
- Reasoning never reaches the page, because Project14's router delivers `reasoning` only to its Playground.
- The board shows only the rendered page.

The user wants two UI modes they can switch between with one click:
- **Clean**: only what matters for learning.
- **Debug**: everything available, including reasoning, each tool round with its inputs and results, the raw reply before the fallback, and the raw board sources (html/css/js/svg/json).

Decisions made with the user:
- Project14 is also changed so pages can opt in to reasoning.
- Traces are saved with the topic in IndexedDB.
- Raw sources appear as tabs on the board.

## Part A: Project14 (opt-in reasoning for pages)

Per Project14's CLAUDE.md, first copy this plan into `Project14_ChromeLLMBackend/docs/<date>-learnwithllm-debug-mode.md`.

1. **`src/shared/protocol.ts`**
   - Add `reasoning?: boolean` to `SessionOptions`, with a doc comment.
   - Allow the new field in the `isSessionOptions` key list and check that it is a boolean.
   - Update the comment on the `reasoning` response kind.
2. **`src/background/router.ts`**
   - In `case "create"`, take `reasoning` out of the options, the same way `model` is taken out, so the host never sees it.
   - Keep `reasoningSessions: Set<string>`. When the create result arrives, add its `sessionId`, using the same place where `sessionBackends` is filled from `msg.res.value.sessionId`.
   - Add `sessionId` to `InFlight` for `prompt`.
   - At line ~368, call `deliversTo(kind, isPlayground, reasoningSessions.has(f.sessionId))`.
   - Remove the session from the set on `destroy`.
3. **`src/background/policy.ts`**: change `deliversTo(kind, toPlayground, wantsReasoning = false)`.
   - `trace` stays Playground-only.
   - `reasoning` also goes to pages that opted in.
4. **`src/polyfill/polyfill.ts`**
   - Add `onReasoning?` to `Pending` and handle `case "reasoning"` in `onPortMessage`.
   - `create()` passes `options.reasoning === true` through.
   - `prompt()` and `promptStreaming()` accept a non-standard `options.onReasoning?: (text) => void` and wire it into the request.
5. **Tests and docs**
   - Tests: add `deliversTo` cases in `test/policy.test.ts` and a `reasoning` field case in `test/protocol.test.ts`.
   - Docs:
     - Update the "Pages get model output only" rule in `CLAUDE.md`: reasoning is now delivered to pages that opt in.
     - Update the README API section.
     - Update `docs/STATUS.md`.
   - Run `npm run typecheck && npm test && npm run test:e2e`, because the polyfill and router are touched.

## Part B: LearnWithLLM

### Data model (`src/types.ts`)
- Add `TraceEvent`:
  - `{ kind: "text"; text }`
  - `{ kind: "reasoning"; text }`
  - `{ kind: "tool"; name; input; output?; error?; ms }`
- Add `TurnTrace`, with these fields:
  - `{ modelId; startedAt; endedAt; events: TraceEvent[] }`
  - `rawReply?`: set only when the fallback replaced the reply.
  - `fallback?: "html" | "svg"`
  - `systemPrompt?`: set only on turns that created a new session.
  - `inputUsage?`, `inputQuota?`
  - `error?`
- Add `DialogueMessage.trace?: TurnTrace`. Old records stay valid with no migration.
- Long strings in tool input and output are capped at 20k characters with a "…(N more chars)" marker, so traces don't bloat storage. The full sources are in the board tabs anyway.
- Add `CreateOptions.reasoning?: boolean`, and add `onReasoning` to the `promptStreaming` options type.

### Tool hooks (`src/llm/tools.ts`)
- `ToolHost.onToolStart(name, input)` and `onToolEnd(name, { output } | { error })`.
- `wrap()` gets the tool name, times the call, and reports the result or the thrown message before re-throwing.

### Turn recording (`src/llm/turn.ts`, `Conversation.send`)
- Build a `TurnTrace` while the turn runs:
  - Each chunk is added to the last `text` event, or starts a new one after a tool event. This is how separate rounds become visible.
  - `onReasoning` adds to a `reasoning` event.
  - Tool start and end push a `tool` event.
- `ensureSession` passes `reasoning: true` to `model.create`. It always does, so traces are complete even if the user switches to Debug later. It also returns `built.system` so the trace can save it.
- Fallback branches: save `rawReply = reply` and `fallback`.
- `StreamState` gains `events` so Debug shows the trace live.
- **Errors and aborts**: save an assistant message with `content: ""` and `trace.error`, so the failure can be inspected. Clean mode skips assistant messages with empty content, which also stops the bare "Tutor" bubble.
- `toolSucceeded` and `destroySession` behavior is unchanged.

### Mode state (`src/ui/mode.ts`, new)
- `type UiMode = "clean" | "debug"`.
- `readMode()` and `writeMode()` use the `localStorage` key `learnwithllm.mode`, wrapped in try/catch, with default `"clean"`.
- `applyMode(shell, mode)` sets `data-mode` on `.app`.

### Toggle (`src/ui/shell.ts`, `src/main.ts`)
- Add a two-segment "Clean | Debug" switch to `.board-toolbar`, made of two buttons with `aria-pressed`. Return it in `Shell`.
- `AppController.mode`. A click calls `writeMode`, then `applyMode`, then `paint(app)`.
- Also add a Ctrl/Cmd+Shift+D shortcut.

### Dialogue (`src/ui/dialogue.ts`)
- `renderTranscript(messages, stream, mode)`.
- **Clean mode**: today's bubbles. Assistant messages with empty content are skipped. "Updating the lesson…" stays while a tool runs.
- **Debug mode**: each assistant bubble gets a `<details class="trace">` with the summary "N tool calls · Xs · model", listing events in order:
  - reasoning: muted, collapsible
  - text segments, labelled "Round k"
  - tool cards: name, pretty-printed input JSON in a `<pre>`, then the output or the error in red, with ms
  - the raw reply when the fallback replaced it
  - the system prompt, when present, collapsed
  - the error

  The live stream renders the same trace while it runs. The header detail adds `inputUsage / inputQuota`.
- Keep which `<details>` are open across re-renders, by message id in a `Set`, because `renderTranscript` rebuilds the DOM on every chunk.

### Board source tabs (`src/ui/whiteboard.ts`)
- New `renderBoard(host, sources, material, mode)`. It wraps the existing `renderWhiteboard`, which keeps its render-key cache so the iframe isn't reloaded.
- In Debug mode, a tab row appears: Preview | HTML | CSS | JS | SVG | JSON | Material.
  - Each tab shows its character count.
  - Code tabs are read-only `<pre><code>` blocks with a Copy button.
  - Empty components show "(empty)".
- The chosen tab is kept in module state. Clean mode always shows Preview with no tabs.

### Styles (`src/styles.css`)
- Add styles for the toggle, the trace block, tool cards, source tabs, and the `pre` blocks (monospace, scrollable, max-height).
- Add `[data-mode="clean"]` rules to hide debug-only parts.
- Reuse the existing tokens (`--line`, `--muted`, `--note`, `--accent`).

### Tests (vitest + happy-dom, next to the existing `*.test.ts`)
- `turn.test.ts`:
  - The trace records text, then a tool event, then text as separate events.
  - The fallback keeps `rawReply`.
  - An abort saves an empty assistant message with a trace.
  - `onReasoning` events are recorded.
- `tools.test.ts`: `onToolStart` and `onToolEnd` receive the name, input, output, and error.
- New `dialogue.test.ts`: Clean hides empty assistant messages and traces; Debug shows tool cards.
- `whiteboard.test.ts`: the tabs appear only in Debug; the iframe isn't rebuilt when only the tab changes.
- New `mode.test.ts`: the default and the persistence round-trip.

## Verification
1. LearnWithLLM: `npm test` and `npm run build`. The build runs `tsc --noEmit`.
2. Project14: `npm run typecheck && npm test && npm run test:e2e`, then reload the unpacked extension.
3. Manual check, with `npm run dev` and Claude in Chrome:
   1. In Clean mode, ask for a lesson. Expect only the chat and the rendered board.
   2. Switch to Debug.
   3. Confirm the same turn shows its rounds, tool cards with `whiteboard_set` input, and reasoning when a reasoning model is selected.
   4. Confirm the HTML/CSS/JSON tabs show the sources.
   5. Reload the page. The mode and past traces are still there.
   6. Stop a turn partway. Debug shows the aborted trace; Clean shows no empty bubble.
