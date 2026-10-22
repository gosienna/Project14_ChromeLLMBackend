// IndexedDB store for downloaded model files, used by the Transformers.js and wllama engines
// (WebLLM has its own IndexedDB cache). Files are written as ~64 MB Blob chunks so multi-GB
// downloads never sit in memory; a read returns one Blob over the chunks, which Chrome keeps on
// disk and wllama slices on demand. Chunks are walked with a cursor: getAll() fails once the
// stored file is multiple GiB, which is what a 27B GGUF is.

const DB_NAME = "local-llm-models";
const CHUNK_BYTES = 64 * 2 ** 20;

interface FileRecord {
  key: string;
  size: number;
  chunks: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("files", { keyPath: "key" });
      // Key: [file key, chunk index].
      req.result.createObjectStore("chunks");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  }));
}

const result = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const committed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new DOMException("IndexedDB transaction aborted", "AbortError"));
  });

const chunkRange = (key: string) => IDBKeyRange.bound([key, 0], [key, Infinity]);

/** Model files under one namespace ("wllama", "transformers"), so engines never see each other's keys. */
export class ModelStore {
  constructor(
    private ns: string,
    private chunkBytes = CHUNK_BYTES,
  ) {}

  private k(key: string) {
    return `${this.ns}/${key}`;
  }

  /** The whole file, or null if it is absent or was only partly written. */
  async read(key: string): Promise<Blob | null> {
    const db = await open();
    const full = this.k(key);
    const tx = db.transaction(["files", "chunks"], "readonly");
    const fileReq = result(tx.objectStore("files").get(full)) as Promise<FileRecord | undefined>;
    const chunks: Blob[] = [];
    // Both requests start before the first await, or IndexedDB commits the transaction.
    const cursorReq = tx.objectStore("chunks").openCursor(chunkRange(full));
    const cursorDone = new Promise<void>((resolve, reject) => {
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve();
          return;
        }
        chunks.push(cursor.value as Blob);
        cursor.continue();
      };
    });
    const [file] = await Promise.all([fileReq, cursorDone]);
    if (!file || chunks.length !== file.chunks) return null;
    return new Blob(chunks);
  }

  /** Size in bytes, or -1 if the file is absent. */
  async size(key: string): Promise<number> {
    const db = await open();
    const file = (await result(db.transaction("files").objectStore("files").get(this.k(key)))) as FileRecord | undefined;
    return file?.size ?? -1;
  }

  /**
   * Stream a file in, replacing any existing one. The file record is written last, so an
   * interrupted download reads as absent and is fetched again.
   */
  async write(key: string, stream: ReadableStream<Uint8Array>, onBytes?: (loaded: number) => void): Promise<void> {
    await this.delete(key);
    const db = await open();
    const full = this.k(key);
    const reader = stream.getReader();
    let parts: Uint8Array[] = [];
    let pending = 0;
    let size = 0;
    let chunks = 0;
    const flush = async () => {
      const tx = db.transaction("chunks", "readwrite");
      tx.objectStore("chunks").put(new Blob(parts as BlobPart[]), [full, chunks++]);
      await committed(tx);
      parts = [];
      pending = 0;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      pending += value.byteLength;
      size += value.byteLength;
      onBytes?.(size);
      if (pending >= this.chunkBytes) await flush();
    }
    if (pending > 0 || chunks === 0) await flush();
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put({ key: full, size, chunks } satisfies FileRecord);
    await committed(tx);
  }

  async list(): Promise<Array<{ key: string; size: number }>> {
    const db = await open();
    const files = (await result(db.transaction("files").objectStore("files").getAll())) as FileRecord[];
    const prefix = this.k("");
    return files.filter((f) => f.key.startsWith(prefix)).map((f) => ({ key: f.key.slice(prefix.length), size: f.size }));
  }

  async delete(key: string): Promise<void> {
    const db = await open();
    const tx = db.transaction(["files", "chunks"], "readwrite");
    tx.objectStore("files").delete(this.k(key));
    tx.objectStore("chunks").delete(chunkRange(this.k(key)));
    await committed(tx);
  }
}

/**
 * Models used to live in Cache Storage (Transformers.js, WebLLM) and OPFS (wllama). Remove those
 * copies so the disk isn't used twice; the models download again into IndexedDB on next use.
 */
export async function removeLegacyStorage(): Promise<void> {
  try {
    for (const name of await caches.keys()) {
      if (name === "transformers-cache" || name.startsWith("webllm/")) await caches.delete(name);
    }
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("cache", { recursive: true }).catch(() => {});
  } catch {
    /* best effort; old files are only wasted space */
  }
}
