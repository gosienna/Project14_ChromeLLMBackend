// In-memory stand-in for chrome.storage.StorageArea.
export function fakeArea(): chrome.storage.StorageArea {
  const data: Record<string, unknown> = {};
  const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
  return {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (keys == null) return clone(data);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data[k] = clone(v);
    },
    async remove(keys: string | string[]) {
      for (const k of typeof keys === "string" ? [keys] : keys) delete data[k];
    },
    async clear() {
      for (const k of Object.keys(data)) delete data[k];
    },
  } as unknown as chrome.storage.StorageArea;
}
