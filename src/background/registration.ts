// Browser gate: the stub and relay are registered only for origins the user enabled and
// granted a host permission for. Unapproved sites cannot detect the extension.

import { getSettings, getSites, originPattern } from "../shared/settings";

const PREFIX = "llm-";

export async function isPermitted(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [originPattern(origin)] });
}

function scripts(matches: string[], overrideNative: boolean): chrome.scripting.RegisteredContentScript[] {
  const common = { matches, runAt: "document_start" as const, allFrames: false, persistAcrossSessions: true };
  return [
    { ...common, id: `${PREFIX}bridge`, js: ["bridge.js"], world: "ISOLATED" },
    { ...common, id: `${PREFIX}stub`, js: [overrideNative ? "polyfill-override.js" : "polyfill.js"], world: "MAIN" },
  ];
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Make the registered content scripts match exactly the enabled, permitted sites. Updates in
 * place (never unregister-then-register) so pages loading meanwhile are not missed. Serialized.
 */
export function syncRegistrations(): Promise<string[]> {
  const run = chain.then(doSync, doSync);
  chain = run.catch(() => {});
  return run;
}

async function doSync(): Promise<string[]> {
  const [sites, settings, existing] = await Promise.all([getSites(), getSettings(), chrome.scripting.getRegisteredContentScripts()]);
  // Denied sites keep the stub so availability() can report "unavailable".
  const origins = Object.keys(sites);
  const permitted = await Promise.all(origins.map(isPermitted));
  const matches = origins.filter((_, i) => permitted[i]).map(originPattern).sort();

  const ours = existing.filter((s) => s.id.startsWith(PREFIX));
  const desired = scripts(matches, settings.overrideNative);
  if (!matches.length) {
    if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours.map((s) => s.id) });
    return [];
  }
  const same = (a: chrome.scripting.RegisteredContentScript, b?: chrome.scripting.RegisteredContentScript) =>
    !!b && JSON.stringify([...(a.matches ?? [])].sort()) === JSON.stringify([...(b.matches ?? [])].sort()) && JSON.stringify(a.js) === JSON.stringify(b.js);
  const toUpdate = desired.filter((d) => ours.some((o) => o.id === d.id) && !same(d, ours.find((o) => o.id === d.id)));
  const toAdd = desired.filter((d) => !ours.some((o) => o.id === d.id));
  if (toUpdate.length) await chrome.scripting.updateContentScripts(toUpdate);
  if (toAdd.length) await chrome.scripting.registerContentScripts(toAdd);
  return matches;
}
