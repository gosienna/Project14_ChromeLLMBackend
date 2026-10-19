// Model-gate dialog: "<origin> wants to use your local model — Allow once / Always / Deny".

import type { ConsentRequest, Decision } from "../background/consent";
import { h, send } from "./dom";

const app = document.getElementById("app")!;
const id = new URLSearchParams(location.search).get("id") ?? "";

async function decide(decision: Decision) {
  await send({ type: "consent:decide", id, decision });
  window.close();
}

async function main() {
  const req = await send<ConsentRequest | undefined>({ type: "consent:get", id });
  if (!req) {
    app.append(h("p", {}, "This request has expired."), h("button", { onclick: () => window.close() }, "Close"));
    return;
  }
  const host = new URL(req.origin).host;
  document.title = `${host} wants to use your model`;
  app.append(
    h("h1", {}, h("span", { class: "origin" }, host), req.cloud ? " wants to use your cloud model" : " wants to use your local model"),
    h("p", { class: "muted" }, `Model: ${req.backendName}`),
    req.cloud
      ? h("p", { class: "warn" }, `Prompts from this site will leave your device and be sent to ${req.backendName}. Usage is billed to your API key.`)
      : h("p", {}, "The model runs on this device. Prompts stay on your computer; the site receives only the model's output."),
    h("p", { class: "small muted" },
      "Once approved, any script running on this site, including third-party ads and analytics, can use the model. ",
      "You can review usage and revoke access at any time in the extension settings."),
    h("div", { class: "actions" },
      h("button", { class: "primary", onclick: () => decide("always") }, "Always allow"),
      h("button", { onclick: () => decide("once") }, "Allow once (this tab)"),
      h("button", { class: "danger", onclick: () => decide("deny") }, "Deny"),
    ),
  );
}

main().catch((e) => app.append(h("p", { class: "warn" }, String(e))));
