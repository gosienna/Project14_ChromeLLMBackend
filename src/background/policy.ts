// Model-gate policy: decides what a request from an origin may do given its consent state.
// Pure logic so the rules can be unit-tested; router.ts supplies the inputs.

import type { PageRequestKind, PageResponseKind } from "../shared/protocol";
import type { SiteConfig } from "../shared/settings";

export type Gate =
  | { action: "allow" }
  /** Show the consent dialog, then allow or deny. */
  | { action: "ask" }
  | { action: "deny"; name: "NotAllowedError"; message: string };

export interface GateInput {
  kind: PageRequestKind;
  site: SiteConfig | undefined;
  /** Browser gate: the origin holds a granted host permission. */
  permitted: boolean;
  /** An "Allow once" grant exists for this origin and tab. */
  onceGrant: boolean;
  /** Tab visibility as observed by the content script. */
  visible: boolean;
}

const deny = (message: string): Gate => ({ action: "deny", name: "NotAllowedError", message });

export function gate({ kind, site, permitted, onceGrant, visible }: GateInput): Gate {
  // Tool results answer a prompt that already passed this gate, like abort and destroy.
  if (kind === "abort" || kind === "destroy" || kind === "tool-result") return { action: "allow" };
  if (!permitted || !site) return deny("This site is not enabled for the local model");
  // Discovery calls never prompt; availability() reports consent state itself.
  if (kind === "availability" || kind === "params" || kind === "info" || kind === "models") return { action: "allow" };
  if (site.consent === "deny") return deny("The user denied this site access to the model");

  const always = site.consent === "always";
  if (always) return { action: "allow" };
  if (!visible) return deny("Background tabs may not use the model without \"Always\" consent");
  if (onceGrant) return { action: "allow" };
  return kind === "create" ? { action: "ask" } : deny("No consent for this site; call LanguageModel.create() first");
}

/** What availability() reports before the backend is consulted, or null to ask the backend. */
export function consentAvailability(site: SiteConfig | undefined, permitted: boolean, onceGrant: boolean): "unavailable" | "downloadable" | null {
  if (!permitted || !site || site.consent === "deny") return "unavailable";
  if (site.consent === "always" || onceGrant) return null;
  return "downloadable";
}

/**
 * Pages get the model's answer, as the Prompt API defines it, plus a reasoning model's thinking
 * when the page opted in with create({ reasoning: true }). Raw request/response traces go to the
 * extension's own playground and nowhere else.
 */
export function deliversTo(kind: PageResponseKind, toPlayground: boolean, wantsReasoning = false): boolean {
  if (toPlayground) return true;
  if (kind === "trace") return false;
  return kind !== "reasoning" || wantsReasoning;
}
