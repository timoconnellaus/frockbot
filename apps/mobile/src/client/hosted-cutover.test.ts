import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("mobile hosted WebUI cutover", () => {
  test("keeps the Capacitor bundle as auth and capability bridge only", async () => {
    const index = await read("./index.ts");
    expect(index).not.toContain("FrockBotApp");
    expect(index).not.toContain("MobileShell");
    expect(index).not.toContain("requestTurn");
    expect(index).toContain("createMobileHost");
    expect(index).toContain("MobileAuthGate");
  });

  test("renders the hosted application through the exact bridge", async () => {
    const gate = await read("./MobileAuthGate.vue");
    const component = await read("./HostedMobileApp.vue");
    const bridge = await read("./hosted-bridge.ts");
    const hostedClient = await read("../../../cloudflare/src/client/index.ts");
    expect(gate).toContain("HostedMobileApp");
    expect(component).toContain("handleHostedMobileMessage");
    expect(bridge).toContain('type: "frockbot/mobile-api-response"');
    expect(bridge).toContain("event.source !== bridge.frameWindow");
    expect(bridge).toContain("event.origin !== bridge.hostedOrigin");
    expect(hostedClient).toContain("MOBILE_SHELL_ORIGINS.has(event.origin)");
    expect(hostedClient).toContain("connectionsAvailable: !usesMobileShell()");
  });
});
