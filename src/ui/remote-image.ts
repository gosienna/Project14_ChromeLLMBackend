// Remote images in the playground. Extension pages run with COEP require-corp, so a plain
// <img src="https://…"> fails for most hosts; instead images are fetched here and shown from a
// blob: URL. Markup carries the url in data-src; hydrateImages() fills in src.

import { fetchRemoteImage } from "../shared/remote-image";
import { h } from "./dom";

const ALL_URLS = { origins: ["<all_urls>"] };

/** url -> blob: URL, or null when it couldn't be loaded. Kept so streaming re-renders don't refetch. */
const cache = new Map<string, Promise<string | null>>();

export function loadImage(url: string): Promise<string | null> {
  let p = cache.get(url);
  if (!p) {
    p = fetchRemoteImage(url).then(
      ({ type, bytes }) => URL.createObjectURL(new Blob([bytes as BlobPart], { type })),
      () => null,
    );
    cache.set(url, p);
  }
  return p;
}

/** Load every img[data-src] under `root`; a failed one becomes a link with a way to allow images. */
export function hydrateImages(root: ParentNode): void {
  for (const img of root.querySelectorAll<HTMLImageElement>("img[data-src]:not([src])")) {
    const url = img.dataset.src!;
    void loadImage(url).then((src) => {
      if (src) img.src = src;
      else if (img.isConnected) img.replaceWith(failed(url, img.alt, img.className));
    });
  }
}

function failed(url: string, alt: string, cls: string): HTMLElement {
  const allow = h("button", {
    type: "button",
    class: "pg-img-allow small",
    title: "Lets the playground download images from any site (optional <all_urls> permission)",
    onclick: async () => {
      // Must run in the click handler: chrome.permissions.request needs a user gesture.
      if (!(await chrome.permissions.request(ALL_URLS))) return;
      for (const [u, p] of cache) if ((await p) === null) cache.delete(u);
      const img = h("img", { class: cls, "data-src": url, alt });
      el.replaceWith(img);
      hydrateImages(img.parentElement ?? document);
    },
  }, "Allow images");
  const el = h("span", { class: "pg-img-failed small" },
    h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, `🖼 ${alt || url}`), " ", allow);
  return el;
}

/** Forget loaded images and free their blob: URLs (New chat). */
export function revokeImages(): void {
  for (const p of cache.values()) void p.then((src) => src && URL.revokeObjectURL(src));
  cache.clear();
}
