// Downloading a remote image: shared by the playground (shows search and Markdown images) and the
// router's fetch-image request (localLLM.fetchImage). Raster types only; SVG can carry script.

import { LLMError } from "./errors";

export const REMOTE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"] as const;
export const MAX_REMOTE_IMAGE_BYTES = 8 * 2 ** 20;

/** Null when the response may be used, otherwise why not. `length` is content-length, if sent. */
export function checkImageResponse(contentType: string | null, length: number | null): string | null {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!(REMOTE_IMAGE_TYPES as readonly string[]).includes(type)) return `Not a supported image type (${type || "none"})`;
  if (length !== null && length > MAX_REMOTE_IMAGE_BYTES) return `Image is larger than ${MAX_REMOTE_IMAGE_BYTES / 2 ** 20} MB`;
  return null;
}

/**
 * Fetch an image without cookies or referrer. Extension pages with host permission for the url
 * skip CORS; without it only hosts that send CORS headers work. Throws LLMError: NetworkError
 * when it can't be fetched, DataError when it isn't a usable image.
 */
export async function fetchRemoteImage(url: string, signal?: AbortSignal): Promise<{ type: string; bytes: Uint8Array }> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow", signal });
  } catch (e) {
    throw new LLMError("NetworkError", `Could not download the image: ${(e as Error)?.message ?? e}`);
  }
  if (!res.ok) throw new LLMError("NetworkError", `Could not download the image: HTTP ${res.status}`);
  const declared = res.headers.get("content-length");
  const bad = checkImageResponse(res.headers.get("content-type"), declared === null ? null : Number(declared));
  if (bad) throw new LLMError("DataError", bad);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_REMOTE_IMAGE_BYTES) throw new LLMError("DataError", `Image is larger than ${MAX_REMOTE_IMAGE_BYTES / 2 ** 20} MB`);
  return { type: res.headers.get("content-type")!.split(";")[0].trim().toLowerCase(), bytes };
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Image urls each origin got back from its own searches, newest last. fetch-image only downloads
 * these, so a site can't use the extension's host access to read arbitrary or intranet urls.
 */
export class SearchedImages {
  private byOrigin = new Map<string, Set<string>>();
  constructor(private readonly perOrigin = 300) {}

  remember(origin: string, urls: string[]): void {
    let set = this.byOrigin.get(origin);
    if (!set) this.byOrigin.set(origin, (set = new Set()));
    for (const url of urls) {
      set.delete(url);
      set.add(url);
    }
    for (const old of set) {
      if (set.size <= this.perOrigin) break;
      set.delete(old);
    }
  }

  has(origin: string, url: string): boolean {
    return this.byOrigin.get(origin)?.has(url) ?? false;
  }

  forget(origin: string): void {
    this.byOrigin.delete(origin);
  }
}
