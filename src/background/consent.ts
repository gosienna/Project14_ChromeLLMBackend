// Model gate: "<origin> wants to use your local model — Allow once / Always / Deny".
// "Always" and "Deny" persist in chrome.storage.local; "Allow once" lasts for the tab, in
// chrome.storage.session. All are revocable from the options page.

import { randomId } from "../shared/protocol";
import { updateSite } from "../shared/settings";

export type Decision = "once" | "always" | "deny";

export interface ConsentRequest {
  id: string;
  origin: string;
  tabId: number;
  backend: string;
  backendName: string;
  cloud: boolean;
}

interface Pending extends ConsentRequest {
  windowId?: number;
  waiters: Array<(d: Decision) => void>;
}

const pending = new Map<string, Pending>();

const onceKey = (origin: string, tabId: number) => `${origin}|${tabId}`;

export async function hasOnceGrant(origin: string, tabId: number): Promise<boolean> {
  const { onceGrants } = await chrome.storage.session.get("onceGrants");
  return !!(onceGrants as Record<string, true> | undefined)?.[onceKey(origin, tabId)];
}

async function setOnceGrant(origin: string, tabId: number): Promise<void> {
  const { onceGrants = {} } = (await chrome.storage.session.get("onceGrants")) as { onceGrants?: Record<string, true> };
  onceGrants[onceKey(origin, tabId)] = true;
  await chrome.storage.session.set({ onceGrants });
}

export async function clearOnceGrants(filter: (origin: string, tabId: number) => boolean): Promise<void> {
  const { onceGrants = {} } = (await chrome.storage.session.get("onceGrants")) as { onceGrants?: Record<string, true> };
  for (const key of Object.keys(onceGrants)) {
    const i = key.lastIndexOf("|");
    if (filter(key.slice(0, i), Number(key.slice(i + 1)))) delete onceGrants[key];
  }
  await chrome.storage.session.set({ onceGrants });
}

/** Ask the user. Concurrent asks from the same origin and tab share one dialog. */
export function askConsent(req: Omit<ConsentRequest, "id">): Promise<Decision> {
  const existing = [...pending.values()].find((p) => p.origin === req.origin && p.tabId === req.tabId);
  if (existing) return new Promise((resolve) => existing.waiters.push(resolve));

  const id = randomId();
  const entry: Pending = { ...req, id, waiters: [] };
  pending.set(id, entry);
  const result = new Promise<Decision>((resolve) => entry.waiters.push(resolve));
  chrome.windows
    .create({ url: chrome.runtime.getURL(`ui/consent.html?id=${id}`), type: "popup", width: 440, height: 560, focused: true })
    .then((w) => (entry.windowId = w?.id))
    .catch(() => settle(id, "deny"));
  return result;
}

export function getConsentRequest(id: string): ConsentRequest | undefined {
  const p = pending.get(id);
  return p && { id: p.id, origin: p.origin, tabId: p.tabId, backend: p.backend, backendName: p.backendName, cloud: p.cloud };
}

/** Record the user's decision and release waiting create() calls. */
export async function settle(id: string, decision: Decision): Promise<void> {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (decision === "once") await setOnceGrant(p.origin, p.tabId);
  else await updateSite(p.origin, (s) => ({ ...s, consent: decision }));
  p.waiters.forEach((w) => w(decision));
}

/** A dialog closed without a choice counts as a one-time denial (not persisted). */
export function onWindowClosed(windowId: number): void {
  for (const p of pending.values()) {
    if (p.windowId === windowId) {
      pending.delete(p.id);
      p.waiters.forEach((w) => w("deny"));
    }
  }
}
