// Provider API keys. Stored in chrome.storage.local, never sent to pages or written to logs.
// Optional passphrase lock: keys are encrypted with AES-GCM under a PBKDF2-derived key, and
// the unlocked key is held in chrome.storage.session (memory only, cleared on browser exit).

import { LLMError } from "./errors";

interface Sealed {
  iv: string;
  ct: string;
}

interface KeyStore {
  salt?: string;
  /** Encrypts a fixed string so a wrong passphrase can be detected. */
  check?: Sealed;
  entries: Record<string, string | Sealed>;
}

const PBKDF2_ITERATIONS = 310_000;
const CHECK_TEXT = "local-llm-keystore";

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface KeystoreDeps {
  local: chrome.storage.StorageArea;
  session: chrome.storage.StorageArea;
}

const defaultDeps = (): KeystoreDeps => ({ local: chrome.storage.local, session: chrome.storage.session });

async function load(d: KeystoreDeps): Promise<KeyStore> {
  const { keys } = await d.local.get("keys");
  return (keys as KeyStore) ?? { entries: {} };
}

const save = (d: KeystoreDeps, keys: KeyStore) => d.local.set({ keys });

async function derive(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

async function seal(key: CryptoKey, text: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}

async function open(key: CryptoKey, s: Sealed): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) as BufferSource }, key, unb64(s.ct) as BufferSource);
  return new TextDecoder().decode(pt);
}

async function sessionKey(d: KeystoreDeps): Promise<CryptoKey | null> {
  const { keystoreKey } = await d.session.get("keystoreKey");
  if (typeof keystoreKey !== "string") return null;
  return crypto.subtle.importKey("raw", unb64(keystoreKey) as BufferSource, "AES-GCM", true, ["encrypt", "decrypt"]);
}

export async function keystoreStatus(d = defaultDeps()): Promise<{ locked: boolean; unlocked: boolean; providers: string[] }> {
  const ks = await load(d);
  const locked = !!ks.salt;
  return { locked, unlocked: !locked || !!(await sessionKey(d)), providers: Object.keys(ks.entries) };
}

export async function setKey(provider: string, value: string, d = defaultDeps()): Promise<void> {
  const ks = await load(d);
  if (ks.salt) {
    const key = await sessionKey(d);
    if (!key) throw new LLMError("NotAllowedError", "Key store is locked");
    ks.entries[provider] = await seal(key, value);
  } else {
    ks.entries[provider] = value;
  }
  await save(d, ks);
}

export async function deleteKey(provider: string, d = defaultDeps()): Promise<void> {
  const ks = await load(d);
  delete ks.entries[provider];
  await save(d, ks);
}

export async function getKey(provider: string, d = defaultDeps()): Promise<string | undefined> {
  const ks = await load(d);
  const entry = ks.entries[provider];
  if (entry === undefined || typeof entry === "string") return entry;
  const key = await sessionKey(d);
  if (!key) throw new LLMError("NotAllowedError", "Key store is locked; unlock it from the extension options");
  return open(key, entry);
}

export async function enableLock(passphrase: string, d = defaultDeps()): Promise<void> {
  const ks = await load(d);
  if (ks.salt) throw new Error("Lock already enabled");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(passphrase, salt);
  const entries: KeyStore["entries"] = {};
  for (const [id, v] of Object.entries(ks.entries)) entries[id] = await seal(key, v as string);
  await save(d, { salt: b64(salt), check: await seal(key, CHECK_TEXT), entries });
  await d.session.set({ keystoreKey: b64(await crypto.subtle.exportKey("raw", key)) });
}

export async function unlock(passphrase: string, d = defaultDeps()): Promise<boolean> {
  const ks = await load(d);
  if (!ks.salt || !ks.check) return true;
  const key = await derive(passphrase, unb64(ks.salt));
  try {
    if ((await open(key, ks.check)) !== CHECK_TEXT) return false;
  } catch {
    return false;
  }
  await d.session.set({ keystoreKey: b64(await crypto.subtle.exportKey("raw", key)) });
  return true;
}

export async function lock(d = defaultDeps()): Promise<void> {
  await d.session.remove("keystoreKey");
}

export async function disableLock(passphrase: string, d = defaultDeps()): Promise<boolean> {
  if (!(await unlock(passphrase, d))) return false;
  const ks = await load(d);
  const key = await sessionKey(d);
  if (!key) return false;
  const entries: KeyStore["entries"] = {};
  for (const [id, v] of Object.entries(ks.entries)) entries[id] = typeof v === "string" ? v : await open(key, v);
  await save(d, { entries });
  await lock(d);
  return true;
}
