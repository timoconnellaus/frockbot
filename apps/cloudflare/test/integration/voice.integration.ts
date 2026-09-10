// Voice through the real gateway: the probe, the two upgrades, and what an
// unconfigured deployment says. This harness carries no provider key, which
// is exactly the state a fresh local stack is in, so what it proves is that
// the doors exist, refuse the anonymous, reach the objects, and answer with
// the actionable message rather than a hang or a 500.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectJson,
  freshUserId,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

function frames(socket: WebSocket) {
  const seen: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const frame = JSON.parse(event.data) as Record<string, unknown>;
    seen.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  return {
    seen,
    waitFor(
      predicate: (frame: Record<string, unknown>) => boolean,
      label: string,
    ): Promise<Record<string, unknown>> {
      const found = seen.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}`)),
          8_000,
        );
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
  };
}

describe("voice through the gateway", () => {
  it("answers the capability probe for a signed-in User", async () => {
    const userId = freshUserId("voice-probe");
    const probe = await asUser(userId, "/api/voice/capabilities");
    expect(probe.status).toBe(200);
    // No key in this harness: both false, and the client says so on press.
    expect(await expectJson(probe)).toEqual({
      schemaVersion: 1,
      dictation: false,
      assistant: false,
    });
  });

  it("opens the dictation relay and says voice is not set up, without a key", async () => {
    const userId = freshUserId("voice-dictation");
    const response = await asUser(userId, "/api/voice/dictation", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const seen = frames(socket);
    socket.send(
      JSON.stringify({ schemaVersion: 1, type: "start", sampleRate: 24000 }),
    );
    const error = await seen.waitFor((f) => f.type === "error", "error");
    expect(error.code).toBe("unconfigured");
    expect(String(error.message)).toContain("isn't set up");
    // The Worker is still there afterwards.
    expect((await asUser(userId, "/")).status).toBe(200);
  });

  it("reaches the voice session object for its owner and refuses the call without a key", async () => {
    const userId = freshUserId("voice-assistant");
    const response = await asUser(
      userId,
      "/api/voice/assistant?version=1&device=integration",
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const seen = frames(socket);
    await seen.waitFor((f) => f.type === "welcome", "welcome");
    socket.send(JSON.stringify({ type: "hello", protocol_version: 1 }));
    socket.send(
      JSON.stringify({ type: "start_call", preferred_format: "pcm16" }),
    );
    const refusal = await seen.waitFor(
      (f) => f.type === "voice/refusal",
      "refusal",
    );
    expect(refusal.code).toBe("unconfigured");
    await seen.waitFor(
      (f) =>
        f.type === "status" &&
        f.status === "idle" &&
        seen.seen.indexOf(f) > seen.seen.indexOf(refusal),
      "idle after refusal",
    );
    socket.close();
    expect((await asUser(userId, "/")).status).toBe(200);
  });

  it("does not open a voice socket for the anonymous", async () => {
    for (const path of ["/api/voice/dictation", "/api/voice/assistant"]) {
      const response = await SELF.fetch(`https://bot.frockbot.com${path}`, {
        headers: { upgrade: "websocket" },
      });
      expect(response.status).toBe(401);
    }
  });
});
