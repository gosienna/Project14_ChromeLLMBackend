// localLLM.fetchImage(): download an image a search returned, for sites that store them (e.g. a
// lesson board keeping its pictures). Runs in the worker; with <all_urls> granted the fetch skips
// CORS, otherwise only hosts that send CORS headers work.

import { LLMError } from "../shared/errors";
import { fetchRemoteImage, toBase64 } from "../shared/remote-image";

export interface FetchedImage {
  url: string;
  type: string;
  /** Base64; the page turns it into a Blob. */
  data: string;
  bytes: number;
}

export async function fetchImageForPage(url: string): Promise<FetchedImage> {
  try {
    const { type, bytes } = await fetchRemoteImage(url);
    return { url, type, data: toBase64(bytes), bytes: bytes.byteLength };
  } catch (e) {
    if (e instanceof LLMError && e.name === "NetworkError" && !(await chrome.permissions.contains({ origins: ["<all_urls>"] }))) {
      throw new LLMError("NetworkError", `${e.message}. The host may not allow downloads from other sites; grant "Images for sites" in extension options → Tools`);
    }
    throw e;
  }
}
