import { isIP } from "node:net";

export interface AndroidDevelopmentTarget {
  readonly deviceSerial: string;
  readonly tailscaleHost: string;
  readonly gatewayUrl: string;
  readonly rendererUrl: string;
}

interface AndroidDevelopmentInput {
  readonly adbDevices: string;
  readonly tailscaleIpv4: string;
  readonly preferredDeviceSerial?: string;
}

function connectedDeviceSerials(adbDevices: string): string[] {
  return adbDevices
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/, 2))
    .filter((entry) => entry.length === 2 && entry[1] === "device")
    .map(([serial]) => serial);
}

function tailscaleHost(output: string): string {
  const addresses = output
    .split(/\s+/)
    .map((address) => address.trim())
    .filter((address) => isIP(address) === 4);

  if (addresses.length === 0) {
    throw new Error("Tailscale is running without an IPv4 address");
  }
  return addresses[0];
}

export function resolveAndroidDevelopmentTarget(
  input: AndroidDevelopmentInput,
): AndroidDevelopmentTarget | undefined {
  const devices = connectedDeviceSerials(input.adbDevices);
  if (devices.length === 0) return undefined;

  let deviceSerial: string;
  if (input.preferredDeviceSerial) {
    if (!devices.includes(input.preferredDeviceSerial)) {
      throw new Error(
        `ANDROID_SERIAL ${input.preferredDeviceSerial} is not an active ADB device`,
      );
    }
    deviceSerial = input.preferredDeviceSerial;
  } else {
    const wirelessDevices = devices.filter((serial) =>
      serial.includes("._adb-tls-connect._tcp"),
    );
    const candidates = wirelessDevices.length > 0 ? wirelessDevices : devices;
    if (candidates.length > 1) {
      throw new Error(
        `multiple ADB devices are connected (${devices.join(", ")}); set ANDROID_SERIAL`,
      );
    }
    deviceSerial = candidates[0];
  }

  const host = tailscaleHost(input.tailscaleIpv4);
  return {
    deviceSerial,
    tailscaleHost: host,
    gatewayUrl: `http://${host}:8787`,
    rendererUrl: `http://${host}:5174`,
  };
}
