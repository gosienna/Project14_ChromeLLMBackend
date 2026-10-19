// Options page: sites, local models, cloud providers and keys, limits, usage log.

import { estimateCost } from "../background/limits";
import { CATALOG, autoSelectEngine, canRun, findModel, type EngineId } from "../shared/catalog";
import type { HostStatus } from "../shared/host-protocol";
import { deleteKey, disableLock, enableLock, keystoreStatus, lock, setKey, unlock } from "../shared/keystore";
import { BUILTIN_PROVIDERS, customProvider } from "../shared/providers";
import {
  allProviders,
  getSettings,
  getSites,
  getUsage,
  normalizeOrigin,
  originPattern,
  saveSettings,
  updateSite,
  type Settings,
  type SiteConfig,
} from "../shared/settings";
import { fmtMB, fmtTime, h, send } from "./dom";

const app = document.getElementById("app")!;
let settings: Settings;

const section = (id: string, title: string, ...body: Array<Node | string | null>) =>
  h("section", { id, class: "card" }, h("h2", {}, title), ...body);

async function save(patch: (s: Settings) => void) {
  patch(settings);
  await saveSettings(settings);
}

const toast = (el: HTMLElement, text: string) => {
  el.textContent = text;
  setTimeout(() => (el.textContent = ""), 3000);
};

// ---- Sites ------------------------------------------------------------------

async function sitesSection(): Promise<HTMLElement> {
  const sites = await getSites();
  const providers = allProviders(settings);
  const backendLabel = (id: string) => (id === "local" ? "Local model" : providers.find((p) => p.id === id)?.name ?? id);
  const enabledBackends = ["local", ...providers.filter((p) => settings.providers[p.id]?.enabled || !p.keyRequired).map((p) => p.id)];

  const input = h("input", { placeholder: "app.example.com", size: 32 });
  const msg = h("span", { class: "small muted" });
  const add = async () => {
    let origin: string;
    try {
      origin = normalizeOrigin(input.value.trim());
    } catch (e) {
      return toast(msg, String((e as Error).message));
    }
    const granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
    if (!granted) return toast(msg, "Permission not granted");
    await send({ type: "site:enable", origin });
    render();
  };

  const rows = Object.values(sites).map((site) => {
    const consent = h("span", {}, site.consent === "always" ? "Always" : site.consent === "deny" ? "Denied" : "Ask");
    const backendSel = h("select", {
      onchange: async (e) => {
        const backend = (e.target as HTMLSelectElement).value;
        await updateSite(site.origin, (s) => ({ ...s, backend }));
      },
    }, ...site.allowedBackends.map((b) => h("option", { value: b, selected: b === site.backend }, backendLabel(b))));

    const allowed = h("div", { class: "row small" }, ...enabledBackends.map((b) =>
      h("label", {}, h("input", {
        type: "checkbox",
        checked: site.allowedBackends.includes(b),
        disabled: b === "local",
        onchange: async (e) => {
          const on = (e.target as HTMLInputElement).checked;
          await updateSite(site.origin, (s) => {
            const allowedBackends = on ? [...new Set([...s.allowedBackends, b])] : s.allowedBackends.filter((x) => x !== b);
            return { ...s, allowedBackends, backend: allowedBackends.includes(s.backend) ? s.backend : "local" };
          });
          render();
        },
      }), backendLabel(b)),
    ));

    const cap = h("input", {
      type: "number", min: 0, step: 1000, value: site.dailyTokenCap,
      onchange: async (e) => updateSite(site.origin, (s) => ({ ...s, dailyTokenCap: Number((e.target as HTMLInputElement).value) })),
    });
    const fallback = h("label", { class: "small" }, h("input", {
      type: "checkbox", checked: site.allowFallback,
      onchange: async (e) => updateSite(site.origin, (s: SiteConfig) => ({ ...s, allowFallback: (e.target as HTMLInputElement).checked })),
    }), "Fall back to other allowed backends");

    return h("tr", {},
      h("td", {}, h("code", {}, site.origin)),
      h("td", {}, consent),
      h("td", {}, backendSel, allowed, fallback),
      h("td", {}, cap),
      h("td", {},
        h("div", { class: "row" },
          h("button", { onclick: async () => { await send({ type: "site:reset-consent", origin: site.origin }); render(); } }, "Reset consent"),
          h("button", { class: "danger", onclick: async () => { await send({ type: "site:revoke", origin: site.origin }); render(); } }, "Revoke"),
        )),
    );
  });

  return section("sites", "Sites",
    h("p", { class: "muted small" },
      "Enabled sites get window.LanguageModel. Each site asks for consent on first use. New sites use the local model only; ",
      "cloud backends must be allowed per site, and fallback never reaches the cloud unless you allow it here."),
    h("div", { class: "row" }, input, h("button", { class: "primary", onclick: add }, "Enable site"), msg),
    rows.length
      ? h("div", { class: "table-wrap", style: "margin-top:12px" }, h("table", {},
          h("thead", {}, h("tr", {}, ...["Site", "Consent", "Backend", "Daily token cap", ""].map((t) => h("th", {}, t)))),
          h("tbody", {}, ...rows)))
      : h("p", { class: "muted", style: "margin-top:12px" }, "No sites enabled yet."),
  );
}

// ---- Local model ------------------------------------------------------------

const ENGINE_ORDER: EngineId[] = ["webllm", "transformers", "wllama", "nano", "dummy"];
const ENGINE_LABELS: Record<EngineId, string> = {
  webllm: "WebLLM (WebGPU)",
  transformers: "Transformers.js (WebGPU or WASM)",
  wllama: "wllama (CPU, GGUF)",
  nano: "Chrome built-in",
  dummy: "Echo (test)",
};

async function localSection(): Promise<HTMLElement> {
  const status = await send<HostStatus>({ type: "admin", admin: { op: "status" } }).catch(() => null);
  const caps = status?.caps ?? { webgpu: false, maxBufferMB: 0 };
  const est = await navigator.storage.estimate().catch(() => ({ usage: 0, quota: 0 }));
  const model = findModel(settings.local.modelId) ?? CATALOG[0];
  const pin = settings.local.enginePin[model.id] ?? "auto";

  const modelSel = h("select", {
    onchange: async (e) => { await save((s) => (s.local.modelId = (e.target as HTMLSelectElement).value)); render(); },
  }, ...CATALOG.map((m) => h("option", { value: m.id, selected: m.id === model.id }, `${m.name}${m.sizeMB ? ` · ~${m.sizeMB} MB` : ""}`)));

  // List every engine the model has a build for; ones this device can't run stay visible but disabled.
  const downloaded = status?.downloaded ?? [];
  const engineLabel = (e: EngineId) => `${ENGINE_LABELS[e]}${downloaded.includes(`${e}:${model.id}`) ? " · downloaded" : ""}`;
  const auto = autoSelectEngine(model, caps);
  const engines = ENGINE_ORDER.filter((e) => canRun(model, e, { webgpu: true, maxBufferMB: Infinity }));
  const engineSel = h("select", {
    onchange: async (e) => { await save((s) => (s.local.enginePin[model.id] = (e.target as HTMLSelectElement).value as EngineId)); render(); },
  },
    h("option", { value: "auto", selected: pin === "auto" }, `Auto-select → ${auto ? engineLabel(auto) : "none available"}`),
    ...engines.map((e) => {
      const ok = canRun(model, e, caps);
      return h("option", { value: e, selected: e === pin, disabled: !ok }, ok ? engineLabel(e) : `${ENGINE_LABELS[e]} — needs WebGPU`);
    }));

  const bar = h("progress", { max: 1, value: 0, hidden: true });
  const msg = h("span", { class: "small muted" });
  const download = async () => {
    bar.hidden = false;
    const listener = (m: { type?: string; loaded?: number }) => {
      if (m.type === "download-progress" && typeof m.loaded === "number") bar.value = m.loaded;
    };
    chrome.runtime.onMessage.addListener(listener);
    try {
      await send({ type: "admin", admin: { op: "download", model, engine: pin } });
      toast(msg, "Model ready");
    } catch (e) {
      toast(msg, String((e as Error).message));
    } finally {
      chrome.runtime.onMessage.removeListener(listener);
      bar.hidden = true;
      render();
    }
  };

  const downloadedRows = (status?.downloaded ?? []).map((key) => {
    const [engine, id] = key.split(":");
    const m = findModel(id);
    return h("tr", {},
      h("td", {}, m?.name ?? id),
      h("td", {}, ENGINE_LABELS[engine as EngineId] ?? engine),
      h("td", {}, m?.sizeMB ? `~${m.sizeMB} MB` : "—"),
      h("td", {}, m ? h("button", { class: "danger", onclick: async () => { await send({ type: "admin", admin: { op: "deleteModel", model: m } }); render(); } }, "Delete") : null),
    );
  });

  const idle = h("input", {
    type: "number", min: 0, value: settings.idleUnloadMinutes,
    onchange: (e) => save((s) => (s.idleUnloadMinutes = Number((e.target as HTMLInputElement).value))),
  });

  return section("local", "Local model",
    h("p", { class: "small muted" },
      `WebGPU: ${caps.webgpu ? `yes (max buffer ${caps.maxBufferMB} MB)` : "no — WebLLM unavailable; Transformers.js runs on WASM, wllama on CPU"} · `,
      `cross-origin isolated: ${status?.crossOriginIsolated ? "yes (multi-threaded WASM)" : "no"} · `,
      `loaded: ${status?.loaded ? `${status.loaded.modelId} on ${ENGINE_LABELS[status.loaded.engine]}` : "none"}`),
    h("div", { class: "row" }, h("label", {}, "Model ", modelSel), h("label", {}, "Engine ", engineSel)),
    h("div", { class: "row", style: "margin-top:10px" },
      h("button", { class: "primary", onclick: download }, "Download / load"),
      h("button", { onclick: async () => { await send({ type: "admin", admin: { op: "unload" } }); render(); } }, "Unload"),
      bar, msg),
    h("div", { class: "row", style: "margin-top:10px" }, h("label", {}, "Unload after idle (minutes) ", idle)),
    h("p", { class: "small muted", style: "margin-top:10px" }, `Extension storage used: ${fmtMB(est.usage ?? 0)}. Weights are stored once and shared by every site.`),
    downloadedRows.length
      ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Downloaded model", "Engine", "Size", ""].map((t) => h("th", {}, t)))), h("tbody", {}, ...downloadedRows)))
      : null,
  );
}

// ---- Cloud providers ----------------------------------------------------------

async function cloudSection(): Promise<HTMLElement> {
  const ks = await keystoreStatus();
  const rows = allProviders(settings).map((p) => {
    const cfg = settings.providers[p.id] ?? { enabled: false, model: p.defaultModel, monthlyTokenCap: 2_000_000 };
    const keyInput = h("input", { type: "password", placeholder: ks.providers.includes(p.id) ? "•••••••• (saved)" : "API key", size: 22, autocomplete: "off" });
    const msg = h("span", { class: "small muted" });
    const builtin = BUILTIN_PROVIDERS.some((b) => b.id === p.id);
    return h("tr", {},
      h("td", {}, h("strong", {}, p.name), h("div", { class: "small muted" }, p.baseUrl)),
      h("td", {}, h("input", {
        type: "checkbox", checked: cfg.enabled,
        onchange: async (e) => {
          const box = e.target as HTMLInputElement;
          if (box.checked && !(await chrome.permissions.request({ origins: [p.hostPattern] }))) {
            box.checked = false;
            return;
          }
          await save((s) => (s.providers[p.id] = { ...cfg, enabled: box.checked }));
        },
      })),
      h("td", {}, h("input", {
        value: cfg.model, size: 20,
        onchange: (e) => save((s) => (s.providers[p.id] = { ...cfg, model: (e.target as HTMLInputElement).value.trim() })),
      })),
      h("td", {}, h("div", { class: "row" }, keyInput,
        h("button", { disabled: !ks.unlocked, onclick: async () => { if (!keyInput.value) return; await setKey(p.id, keyInput.value.trim()); keyInput.value = ""; toast(msg, "Saved"); render(); } }, "Save"),
        ks.providers.includes(p.id) ? h("button", { class: "danger", onclick: async () => { await deleteKey(p.id); render(); } }, "Delete") : null,
        msg)),
      h("td", {}, h("input", {
        type: "number", min: 0, step: 100000, value: cfg.monthlyTokenCap,
        onchange: (e) => save((s) => (s.providers[p.id] = { ...cfg, monthlyTokenCap: Number((e.target as HTMLInputElement).value) })),
      })),
      h("td", {}, builtin ? null : h("button", {
        class: "danger",
        onclick: async () => { await save((s) => { s.customProviders = s.customProviders.filter((c) => c.id !== p.id); delete s.providers[p.id]; }); await deleteKey(p.id); render(); },
      }, "Remove")),
    );
  });

  const name = h("input", { placeholder: "Ollama", size: 12 });
  const url = h("input", { placeholder: "http://localhost:11434/v1", size: 28 });
  const model = h("input", { placeholder: "llama3.2", size: 14 });
  const msg = h("span", { class: "small muted" });
  const addCustom = async () => {
    try {
      const id = `custom-${Date.now().toString(36)}`;
      const def = customProvider(id, name.value.trim() || "Custom", url.value.trim(), model.value.trim());
      // Host permission is requested at the moment the user adds the endpoint.
      if (!(await chrome.permissions.request({ origins: [def.hostPattern] }))) return toast(msg, "Permission not granted");
      await save((s) => {
        s.customProviders.push(def);
        s.providers[id] = { enabled: true, model: def.defaultModel, monthlyTokenCap: 0 };
      });
      render();
    } catch (e) {
      toast(msg, String((e as Error).message));
    }
  };

  return section("cloud", "Cloud providers",
    h("p", { class: "small muted" }, "Your own API keys, stored only in this browser and never shared with websites. A site uses a cloud provider only if you allow it for that site."),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ...["Provider", "Enabled", "Default model", "API key", "Monthly token cap", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...rows))),
    h("h2", { style: "margin-top:16px" }, "Add an OpenAI-compatible endpoint"),
    h("div", { class: "row" }, name, url, model, h("button", { onclick: addCustom }, "Add"), msg),
    await lockPanel(ks),
  );
}

async function lockPanel(ks: Awaited<ReturnType<typeof keystoreStatus>>): Promise<HTMLElement> {
  const pass = h("input", { type: "password", placeholder: "Passphrase", autocomplete: "new-password" });
  const msg = h("span", { class: "small muted" });
  const act = (fn: (p: string) => Promise<unknown>) => async () => {
    if (!pass.value) return toast(msg, "Enter a passphrase");
    const ok = await fn(pass.value);
    if (ok === false) return toast(msg, "Wrong passphrase");
    render();
  };
  const state = !ks.locked ? "Keys are stored unencrypted in extension storage." : ks.unlocked ? "Keys are encrypted; unlocked for this browser session." : "Keys are encrypted and locked. Cloud backends are unavailable until you unlock.";
  return h("div", { style: "margin-top:16px" },
    h("h2", {}, "Passphrase lock"),
    h("p", { class: "small muted" }, state),
    h("div", { class: "row" }, pass,
      !ks.locked ? h("button", { onclick: act(enableLock) }, "Enable lock") : null,
      ks.locked && !ks.unlocked ? h("button", { class: "primary", onclick: act(unlock) }, "Unlock") : null,
      ks.locked && ks.unlocked ? h("button", { onclick: async () => { await lock(); render(); } }, "Lock now") : null,
      ks.locked ? h("button", { onclick: act(disableLock) }, "Remove lock") : null,
      msg),
  );
}

// ---- Limits -------------------------------------------------------------------

function limitsSection(): HTMLElement {
  const num = (label: string, value: number, set: (s: Settings, v: number) => void) =>
    h("label", {}, label, h("input", { type: "number", min: 1, value, onchange: (e) => save((s) => set(s, Number((e.target as HTMLInputElement).value))) }));
  return section("limits", "Limits and compatibility",
    h("div", { class: "row" },
      num("Concurrent sessions per site", settings.limits.maxSessions, (s, v) => (s.limits.maxSessions = v)),
      num("Tokens per minute per site", settings.limits.tokensPerMinute, (s, v) => (s.limits.tokensPerMinute = v)),
      num("Max context tokens", settings.limits.maxContext, (s, v) => (s.limits.maxContext = v))),
    h("div", { class: "row", style: "margin-top:12px" }, h("label", {}, h("input", {
      type: "checkbox", checked: settings.overrideNative,
      onchange: (e) => save((s) => (s.overrideNative = (e.target as HTMLInputElement).checked)),
    }), "Override Chrome's native LanguageModel on enabled sites")),
    h("p", { class: "small muted" }, "Off by default: if the browser already provides LanguageModel, the extension leaves it alone. Changes apply after reloading the site."),
  );
}

// ---- Usage log --------------------------------------------------------------

async function usageSection(): Promise<HTMLElement> {
  const usage = (await getUsage()).slice().reverse();
  const rows = usage.slice(0, 200).map((e) => h("tr", {},
    h("td", {}, fmtTime(e.time)),
    h("td", {}, h("code", {}, e.origin)),
    h("td", {}, e.backend),
    h("td", {}, String(e.inputTokens)),
    h("td", {}, String(e.outputTokens)),
    h("td", {}, e.backend === "local" ? "—" : `$${estimateCost(e).toFixed(4)}`),
  ));
  const totalCost = usage.reduce((s, e) => s + estimateCost(e), 0);
  return section("usage", "Usage log",
    h("p", { class: "small muted" }, `Origin, time and token counts only — prompt text is never logged. Estimated cloud spend in log: $${totalCost.toFixed(2)}.`),
    rows.length
      ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Time", "Site", "Backend", "In", "Out", "Est. cost"].map((t) => h("th", {}, t)))), h("tbody", {}, ...rows)))
      : h("p", { class: "muted" }, "No usage yet."),
    h("button", { style: "margin-top:10px", onclick: async () => { await chrome.storage.local.set({ usage: [] }); render(); } }, "Clear log"),
  );
}

// ---- Page -----------------------------------------------------------------------

async function render() {
  settings = await getSettings();
  const parts = await Promise.all([sitesSection(), localSection(), cloudSection(), Promise.resolve(limitsSection()), usageSection()]);
  app.replaceChildren(
    h("header", {},
      h("h1", {}, "Local LLM"),
      h("p", { class: "muted" }, "Serves a language model to the websites you approve through the standard window.LanguageModel API."),
      h("nav", {}, ...[["sites", "Sites"], ["local", "Local model"], ["cloud", "Cloud providers"], ["limits", "Limits"], ["usage", "Usage"]].map(([id, t]) => h("a", { href: `#${id}` }, t)))),
    ...parts,
  );
}

render().catch((e) => app.append(h("p", { class: "warn" }, String(e))));
