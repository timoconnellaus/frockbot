/**
 * The one place the hosted client raises a notification.
 *
 * Progressive enhancement, in the constitution's sense: when the shell around
 * the WebUI exposes its notifications Package — `desktop.notifications.show`
 * or `mobile.notifications.show` — the intent goes there, because the platform
 * shows it the way the platform shows notifications. When it does not, the web
 * `Notification` API carries it. Neither Package changes for this; the seam
 * only asks what the host already exposes.
 */

/** What a shell exposes to the hosted page. Detected structurally. */
interface HostedCapabilityBridge {
  list(): readonly { id: string }[];
  invoke(request: unknown, signal?: AbortSignal): Promise<{ status: string }>;
}

export interface ClientNotificationIntentV1 {
  title: string;
  body: string;
  urgency?: "normal" | "critical";
}

export type ClientNotificationDeliveryV1 =
  "desktop" | "mobile" | "web" | "unavailable";

const DESKTOP_SHOW_COMMAND = "desktop.notifications.show";
const MOBILE_SHOW_COMMAND = "mobile.notifications.show";

function bridge(candidate: unknown): HostedCapabilityBridge | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const value = candidate as Partial<HostedCapabilityBridge>;
  return typeof value.list === "function" && typeof value.invoke === "function"
    ? (value as HostedCapabilityBridge)
    : undefined;
}

function exposes(host: HostedCapabilityBridge, commandId: string): boolean {
  try {
    return host.list().some((command) => command.id === commandId);
  } catch {
    return false;
  }
}

async function invokeShow(
  host: HostedCapabilityBridge,
  commandId: string,
  intent: ClientNotificationIntentV1,
): Promise<boolean> {
  try {
    const result = await host.invoke({
      schemaVersion: 1,
      action: "invoke",
      commandId,
      input: {
        title: intent.title,
        body: intent.body,
        urgency: intent.urgency ?? "normal",
      },
    });
    return result.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Shows one notification through the best surface available. Never throws: a
 * notification that cannot be shown reports how far it got, and the caller
 * decides what to say about it.
 */
export async function showClientNotificationV1(
  intent: ClientNotificationIntentV1,
): Promise<ClientNotificationDeliveryV1> {
  const host = globalThis.window as unknown as
    Record<string, unknown> | undefined;
  if (host) {
    const desktop = bridge(host.frockbotDesktop);
    if (desktop && exposes(desktop, DESKTOP_SHOW_COMMAND)) {
      if (await invokeShow(desktop, DESKTOP_SHOW_COMMAND, intent)) {
        return "desktop";
      }
    }
    const mobile = bridge(host.frockbotMobile);
    if (mobile && exposes(mobile, MOBILE_SHOW_COMMAND)) {
      if (await invokeShow(mobile, MOBILE_SHOW_COMMAND, intent)) {
        return "mobile";
      }
    }
  }
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    Notification.permission !== "granted"
  ) {
    return "unavailable";
  }
  new Notification(intent.title, { body: intent.body });
  return "web";
}
