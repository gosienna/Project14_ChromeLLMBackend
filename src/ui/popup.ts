// Toolbar popup: enable the current site (browser gate) and see active sessions.

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

  app.append(h("h1", {}, "Local LLM"), h("p", { class: "muted small" }, `${total} active session${total === 1 ? "" : "s"}`));

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
  app.append(h("p", { class: "small", style: "margin-top:12px" }, h("a", { href: "#", onclick: (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); } }, "Settings, models and usage →")));
}

main().catch((e) => app.append(h("p", { class: "warn" }, String(e))));
