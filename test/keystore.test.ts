import { describe, expect, it } from "vitest";
import { disableLock, enableLock, getKey, keystoreStatus, lock, setKey, unlock } from "../src/shared/keystore";
import { fakeArea } from "./fake-storage";

describe("keystore", () => {
  it("stores keys and encrypts them under a passphrase lock", async () => {
    const d = { local: fakeArea(), session: fakeArea() };
    await setKey("openai", "sk-1", d);
    expect(await getKey("openai", d)).toBe("sk-1");

    await enableLock("correct horse", d);
    const raw = JSON.stringify(await d.local.get("keys"));
    expect(raw).not.toContain("sk-1");
    expect(await getKey("openai", d)).toBe("sk-1"); // unlocked for this session

    await lock(d);
    await expect(getKey("openai", d)).rejects.toMatchObject({ name: "NotAllowedError" });
    await expect(setKey("x", "y", d)).rejects.toBeTruthy();
    expect((await keystoreStatus(d)).unlocked).toBe(false);

    expect(await unlock("wrong", d)).toBe(false);
    expect(await unlock("correct horse", d)).toBe(true);
    expect(await getKey("openai", d)).toBe("sk-1");

    expect(await disableLock("correct horse", d)).toBe(true);
    expect(JSON.stringify(await d.local.get("keys"))).toContain("sk-1");
  }, 20_000);
});
