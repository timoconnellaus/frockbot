import { isRpcIdentifier } from "@frockbot/configuration-core";

function exact(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

export interface HostedMobileBridge {
  hostedOrigin: string;
  frameWindow: MessageEventSource | null | undefined;
  authorizedFetch(path: string, init: RequestInit): Promise<Response>;
  invoke(commandId: string, input: unknown): Promise<unknown>;
  post(message: Record<string, unknown>): void;
}

/** Exact source/origin-checked bridge from the hosted product UI to Capacitor. */
export async function handleHostedMobileMessage(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  bridge: HostedMobileBridge,
): Promise<void> {
  if (
    event.origin !== bridge.hostedOrigin ||
    event.source !== bridge.frameWindow ||
    typeof event.data !== "object" ||
    event.data === null ||
    Array.isArray(event.data)
  )
    return;
  const value = event.data as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !isRpcIdentifier(value.id)) return;
  if (
    value.type === "frockbot/mobile-api-request" &&
    exact(value, ["schemaVersion", "type", "id", "path", "method"], ["body"])
  ) {
    if (
      typeof value.path !== "string" ||
      (!value.path.startsWith("/api/") && value.path !== "/app-manifest") ||
      (value.method !== "GET" && value.method !== "POST") ||
      (value.body !== undefined && typeof value.body !== "string")
    )
      return;
    try {
      const response = await bridge.authorizedFetch(value.path, {
        method: value.method,
        ...(value.body === undefined ? {} : { body: value.body }),
      });
      bridge.post({
        schemaVersion: 1,
        type: "frockbot/mobile-api-response",
        id: value.id,
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        body: await response.text(),
      });
    } catch (error) {
      bridge.post({
        schemaVersion: 1,
        type: "frockbot/mobile-api-response",
        id: value.id,
        status: 599,
        body: JSON.stringify({
          error:
            error instanceof Error ? error.message : "Mobile request failed",
        }),
      });
    }
    return;
  }
  if (
    value.type !== "frockbot/mobile-command" ||
    !exact(value, ["schemaVersion", "type", "id", "commandId", "input"]) ||
    !isRpcIdentifier(value.commandId)
  )
    return;
  try {
    bridge.post({
      schemaVersion: 1,
      type: "frockbot/mobile-command-result",
      id: value.id,
      result: await bridge.invoke(value.commandId, value.input),
    });
  } catch (error) {
    bridge.post({
      schemaVersion: 1,
      type: "frockbot/mobile-command-result",
      id: value.id,
      error: error instanceof Error ? error.message : "Mobile command failed",
    });
  }
}
