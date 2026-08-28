import { describe, expect, test } from "bun:test";
import {
  connectionCompletionResponse,
  decodeAuthorizationState,
  encodeAuthorizationState,
} from "./backend.js";

describe("Composio authorization return handoff", () => {
  test("returns desktop authorization to the fixed native protocol", () => {
    const response = connectionCompletionResponse(
      new URL("https://bot.frockbot.com/api/plugins/composio/callback"),
      "desktop",
      "ready",
      "native-1",
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "com.frockbot.desktop:/connections?status=ready&nonce=native-1",
    );
  });

  test("returns browser authorization to the hosted application", () => {
    const response = connectionCompletionResponse(
      new URL("https://bot.frockbot.com/api/plugins/composio/callback"),
      "browser",
      "failed",
    );
    expect(response.headers.get("location")).toBe(
      "https://bot.frockbot.com/?connection=composio-failed",
    );
  });

  test("signs desktop state over User, Connection, and native return nonce", async () => {
    const state = await encodeAuthorizationState(
      {
        schemaVersion: 1,
        authorizationStateId: "state-1",
        userId: "user-1",
        connectionId: "connection-1",
        returnTarget: "desktop",
        expiresAt: Date.now() + 60_000,
        nativeReturnNonce: "native-1",
      },
      "state-secret",
    );
    await expect(decodeAuthorizationState(state, "state-secret")).resolves.toMatchObject(
      {
        userId: "user-1",
        connectionId: "connection-1",
        nativeReturnNonce: "native-1",
      },
    );
    await expect(
      decodeAuthorizationState(`${state.slice(0, -1)}x`, "state-secret"),
    ).rejects.toThrow("invalid");
  });
});
