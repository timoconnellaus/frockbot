import { describe, expect, test } from "bun:test";
import { createCapacitorConfig } from "./capacitor.config.ts";
import { resolveAndroidDevelopmentTarget } from "./dev-target.ts";

const oneDevice = `List of devices attached
54261JEBF09176\tdevice
adb-54261._adb-tls-connect._tcp\toffline
`;

describe("resolveAndroidDevelopmentTarget", () => {
  test("returns undefined when no active Android device is connected", () => {
    expect(
      resolveAndroidDevelopmentTarget({
        adbDevices: "List of devices attached\nserial\toffline\n",
        tailscaleIpv4: "",
      }),
    ).toBeUndefined();
  });

  test("uses the active ADB device and Tailscale IPv4 address", () => {
    const target = resolveAndroidDevelopmentTarget({
      adbDevices: oneDevice,
      tailscaleIpv4: "100.119.164.113\nfd7a:115c:a1e0::4b3a:a471\n",
    });

    expect(target).toEqual({
      deviceSerial: "54261JEBF09176",
      tailscaleHost: "100.119.164.113",
      gatewayUrl: "http://100.119.164.113:8787",
      rendererUrl: "http://100.119.164.113:5174",
    });

    const config = createCapacitorConfig({
      FROCKBOT_MOBILE_DEV_SERVER_URL: target?.rendererUrl,
      FROCKBOT_GOOGLE_WEB_CLIENT_ID: "123-example.apps.googleusercontent.com",
    });
    expect(config.server).toEqual({
      androidScheme: "frockbot",
      url: "http://100.119.164.113:5174",
      cleartext: true,
    });
    expect(config.plugins?.FrockBotGoogleAuth).toEqual({
      serverClientId: "123-example.apps.googleusercontent.com",
    });
  });

  test("prefers one wireless ADB endpoint over its direct device", () => {
    expect(
      resolveAndroidDevelopmentTarget({
        adbDevices:
          "List of devices attached\n54261JEBF09176\tdevice\nadb-54261JEBF09176-BksSLE._adb-tls-connect._tcp\tdevice\n",
        tailscaleIpv4: "100.119.164.113",
      })?.deviceSerial,
    ).toBe("adb-54261JEBF09176-BksSLE._adb-tls-connect._tcp");
  });

  test("requires ANDROID_SERIAL when several active devices are connected", () => {
    const adbDevices =
      "List of devices attached\nfirst\tdevice\nsecond\tdevice\n";
    expect(() =>
      resolveAndroidDevelopmentTarget({
        adbDevices,
        tailscaleIpv4: "100.119.164.113",
      }),
    ).toThrow("multiple ADB devices are connected");

    expect(
      resolveAndroidDevelopmentTarget({
        adbDevices,
        tailscaleIpv4: "100.119.164.113",
        preferredDeviceSerial: "second",
      })?.deviceSerial,
    ).toBe("second");
  });

  test("rejects a preferred device that is not active", () => {
    expect(() =>
      resolveAndroidDevelopmentTarget({
        adbDevices: oneDevice,
        tailscaleIpv4: "100.119.164.113",
        preferredDeviceSerial: "missing",
      }),
    ).toThrow("ANDROID_SERIAL missing is not an active ADB device");
  });

  test("requires a Tailscale IPv4 address for a connected phone", () => {
    expect(() =>
      resolveAndroidDevelopmentTarget({
        adbDevices: oneDevice,
        tailscaleIpv4: "fd7a:115c:a1e0::4b3a:a471",
      }),
    ).toThrow("Tailscale is running without an IPv4 address");
  });
});
