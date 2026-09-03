import type { PackageIframeHostMessageV2 } from "@frockbot/kernel-contracts";

type MessageTarget = Pick<Window, "postMessage">;

export function postPackageIframeHostMessage(
  target: MessageTarget,
  message: PackageIframeHostMessageV2,
  lastStateWireByName: Map<string, string>,
): void {
  const wire = JSON.stringify(message);
  if (new TextEncoder().encode(wire).byteLength > 64 * 1024) {
    throw new Error("Package page state exceeds the bridge limit");
  }
  if (
    message.type === "state" &&
    lastStateWireByName.get(message.name) === wire
  ) {
    return;
  }

  // Vue settings values may be reactive proxies, which structured clone
  // rejects. JSON is also the bridge's declared value domain.
  target.postMessage(JSON.parse(wire) as PackageIframeHostMessageV2, "*");
  if (message.type === "state") {
    lastStateWireByName.set(message.name, wire);
  }
}
