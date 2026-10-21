// Toolbar popup: enable the current site (browser gate), see active sessions, force-stop stuck
// generations, open the playground.

import type { HostStatus } from "../shared/host-protocol";
import { getSite, normalizeOrigin, originPattern } from "../shared/settings";
import { h, send } from "./dom";

const app = document.getElementById("app")!;

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin: string | null = null;
  try {
    if (tab?.url && /^https?:/.test(tab.url)) origin = normalizeOrigin(tab.url);
  } catch {
    origin = null;
  }
  const sessions = await send<Record<string, number>>({ type: "sessions" }).catch(() => ({}) as Record<string, number>);
  const total = Object.values(sessions).reduce((a, b) => a + b, 0);

  // Only ask the host when it has sessions: asking would otherwise start it.
  const status = total ? await send<HostStatus>({ type: "admin", admin: { op: "status" } }).catch(() => null) : null;
  const running = Object.values(status?.running ?? {}).reduce((a, b) => a + b, 0);

  app.append(h("h1", {}, "Local LLM"), h("p", { class: "muted small" }, `${total} active session${total === 1 ? "" : "s"}`));
  if (running) {
    // One stuck generation holds up every local request behind it; this stops them all.
    app.append(h("div", { class: "row" },
      h("span", { class: "small muted" }, `${running} request${running === 1 ? "" : "s"} running or queued`),
      h("button", { class: "danger", title: "Abort every running and queued request. An engine that doesn't stop is unloaded.", onclick: async () => { await send({ type: "admin", admin: { op: "stop" } }); location.reload(); } }, "Force stop all")));
  }

  if (origin) {
    const site = await getSite(origin);
    const permitted = await chrome.permissions.contains({ origins: [originPattern(origin)] });
    const host = new URL(origin).host;
    const card = h("div", { class: "card stack" });
    if (site && permitted) {
      const state = site.consent === "always" ? "Always allowed" : site.consent === "deny" ? "Denied" : "Asks on first use";
      card.append(
        h("p", {}, h("strong", {}, host), " is enabled"),
        h("p", { class: "small muted" }, `${state} · backend: ${site.backend} · ${sessions[origin] ?? 0} session(s)`),
        h("button", { class: "danger", onclick: async () => { await send({ type: "site:revoke", origin }); location.reload(); } }, "Revoke access"),
      );
      // Idle sessions have nothing to abort, so the stop buttons below never show for them.
      if (sessions[origin]) card.append(h("button", { title: "Destroy this site's open sessions; the site stays enabled. The page's session objects stop working.", onclick: async () => { await send({ type: "admin", admin: { op: "revokeOrigin", origin } }); location.reload(); } }, `End sessions (${sessions[origin]})`));
      const siteRunning = status?.running[origin];
      if (siteRunning) card.append(h("button", { onclick: async () => { await send({ type: "admin", admin: { op: "stop", origin } }); location.reload(); } }, `Stop this site's requests (${siteRunning})`));
    } else {
      card.append(
        h("p", {}, "Let ", h("strong", {}, host), " use window.LanguageModel?"),
        h("p", { class: "small muted" }, "The site will be asked for consent the first time it creates a session. Reload the page after enabling."),
        h("button", {
          class: "primary",
          onclick: async () => {
            // Must run in the click handler: chrome.permissions.request needs a user gesture.
            const granted = await chrome.permissions.request({ origins: [originPattern(origin!)] });
            if (!granted) return;
            await send({ type: "site:enable", origin });
            if (tab?.id) chrome.tabs.reload(tab.id);
            window.close();
          },
        }, "Enable on this site"),
      );
    }
    app.append(card);
  } else {
    app.append(h("p", { class: "muted" }, "Open a website to enable it."));
  }
  app.append(h("div", { class: "actions" },
    h("button", { onclick: async () => { await chrome.tabs.create({ url: chrome.runtime.getURL("ui/playground.html") }); window.close(); } }, "Open playground"),
    h("p", { class: "small" }, h("a", { href: "#", onclick: (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); } }, "Settings, models and usage →"))));
}

main().catch((e) => app.append(h("p", { class: "warn" }, String(e))));
