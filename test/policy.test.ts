import { describe, expect, it } from "vitest";
import { consentAvailability, deliversTo, gate } from "../src/background/policy";
import { defaultSite } from "../src/shared/settings";

const site = (consent?: "always" | "deny") => ({ ...defaultSite("https://app.example.com"), consent });
const base = { permitted: true, onceGrant: false, visible: true };

describe("gate", () => {
  it("denies everything for unpermitted or unknown sites", () => {
    expect(gate({ ...base, kind: "create", site: site("always"), permitted: false }).action).toBe("deny");
    expect(gate({ ...base, kind: "availability", site: undefined }).action).toBe("deny");
  });

  it("asks on first create and refuses prompt without consent", () => {
    expect(gate({ ...base, kind: "create", site: site() }).action).toBe("ask");
    expect(gate({ ...base, kind: "prompt", site: site() }).action).toBe("deny");
  });

  it("allows with Always or an Allow-once grant", () => {
    expect(gate({ ...base, kind: "prompt", site: site("always") }).action).toBe("allow");
    expect(gate({ ...base, kind: "prompt", site: site(), onceGrant: true }).action).toBe("allow");
  });

  it("blocks background tabs unless consent is Always", () => {
    expect(gate({ ...base, kind: "create", site: site(), visible: false }).action).toBe("deny");
    expect(gate({ ...base, kind: "prompt", site: site(), onceGrant: true, visible: false }).action).toBe("deny");
    expect(gate({ ...base, kind: "prompt", site: site("always"), visible: false }).action).toBe("allow");
  });

  it("honors Deny but keeps discovery and cleanup working", () => {
    expect(gate({ ...base, kind: "create", site: site("deny") }).action).toBe("deny");
    expect(gate({ ...base, kind: "availability", site: site("deny") }).action).toBe("allow");
    expect(gate({ ...base, kind: "destroy", site: site("deny") }).action).toBe("allow");
  });
});

describe("consentAvailability", () => {
  it("reports consent state before asking the backend", () => {
    expect(consentAvailability(site(), true, false)).toBe("downloadable");
    expect(consentAvailability(site("deny"), true, false)).toBe("unavailable");
    expect(consentAvailability(site(), false, false)).toBe("unavailable");
    expect(consentAvailability(site("always"), true, false)).toBeNull();
    expect(consentAvailability(site(), true, true)).toBeNull();
  });
});

describe("deliversTo", () => {
  it("keeps reasoning out of pages", () => {
    expect(deliversTo("reasoning", false)).toBe(false);
    expect(deliversTo("chunk", false)).toBe(true);
  });
  it("sends reasoning to the playground", () => expect(deliversTo("reasoning", true)).toBe(true));
});
