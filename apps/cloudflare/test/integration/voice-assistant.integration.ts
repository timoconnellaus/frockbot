// The actual gateway → VoiceSession DO → UserConfiguration DO boundary. The
// integration deployment intentionally has no Gemini credential: that makes
// the final error deterministic while proving start and end both reached the
// User-owned durable ledger.
import { describe, expect, it, vi } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

describe("Voice assistant Durable Object boundary", () => {
  it("records a socket session in the User ledger even when upstream is unavailable", async () => {
    const userId = freshUserId("voice-assistant");
    const response = await asUser(
      userId,
      "/api/voice/assistant?version=1&device=integration-device",
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).toBeDefined();
    socket!.accept();

    const messages: string[] = [];
    socket!.addEventListener("message", (event) => {
      if (typeof event.data === "string") messages.push(event.data);
    });
    await vi.waitFor(() => {
      expect(messages.map((entry) => JSON.parse(entry))).toContainEqual(
        expect.objectContaining({ type: "offline", reason: "error" }),
      );
    });

    await vi.waitFor(async () => {
      const view = (await expectOkJson(await asUser(userId, "/api/voice"))) as {
        ledger: {
          state: { enabled: boolean };
          sessions: Array<{ deviceId: string; endedReason?: string }>;
        };
      };
      expect(view.ledger.state.enabled).toBe(false);
      expect(view.ledger.sessions).toContainEqual(
        expect.objectContaining({
          deviceId: "integration-device",
          endedReason: "error",
        }),
      );
    });
  });
});
