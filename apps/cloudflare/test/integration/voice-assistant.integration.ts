// The actual gateway → VoiceSession DO → UserConfiguration DO boundary. The
// integration deployment intentionally has no Gemini credential: that makes
// the final error deterministic while proving start and end both reached the
// User-owned durable ledger.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { TOOL_CALL_TRIGGER } from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
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

  it("admits ask_bot to the target Bot and records its first send as voice/answered", async () => {
    const userId = freshUserId("voice-ask");
    await provisionThroughGateway({ userId, botId: "general" });
    expect(
      (
        await postAsUser(userId, "/api/bots", {
          schemaVersion: 1,
          type: "bot/create",
          commandId: "create-researcher",
          expectedRevision: 1,
          botId: "researcher",
          name: "Researcher",
          description: "Finds the answer.",
        })
      ).status,
    ).toBe(201);
    const user = env.USER_CONFIGURATIONS.getByName(userId) as unknown as {
      startVoiceAssistant(input: unknown): Promise<unknown>;
      executeVoiceTool(input: unknown): Promise<unknown>;
      readVoiceAsk(input: unknown): Promise<unknown>;
    };
    const sessionId = "voice-integration";
    const at = new Date().toISOString();
    await user.startVoiceAssistant({
      schemaVersion: 1,
      userId,
      month: at.slice(0, 7),
      sessionId,
      deviceId: "integration-device",
      at,
    });
    const answer = "The specialist answer from Voice.";
    const question = `${TOOL_CALL_TRIGGER}send_to_user:${JSON.stringify({
      payload: { type: "text", text: answer },
    })}`;
    const accepted = (await user.executeVoiceTool({
      schemaVersion: 1,
      userId,
      sessionId,
      callId: "ask-researcher",
      name: "ask_bot",
      args: { bot: "researcher", question },
      at,
    })) as { result: { askId: string; status: string; message: string } };
    expect(accepted.result).toMatchObject({
      status: "accepted",
      message: "I've asked Researcher. I'll tell you when Researcher answers.",
    });

    await vi.waitFor(
      async () => {
        const record = (await user.readVoiceAsk({
          schemaVersion: 1,
          userId,
          askId: accepted.result.askId,
        })) as { answered?: { type: string; answer: string } };
        expect(record.answered).toEqual(
          expect.objectContaining({ type: "voice/answered", answer }),
        );
      },
      { timeout: 60_000 },
    );
    const voice = (await expectOkJson(await asUser(userId, "/api/voice"))) as {
      ledger: { pendingAnswers: Array<{ answerId: string; answer: string }> };
    };
    expect(voice.ledger.pendingAnswers).toContainEqual(
      expect.objectContaining({
        answerId: accepted.result.askId,
        answer,
      }),
    );
    const transcript = (await expectOkJson(
      await asUser(userId, "/api/bots/researcher/turns"),
    )) as {
      runs: Array<{ input: string; via?: { kind: string; name: string } }>;
    };
    expect(transcript.runs).toContainEqual(
      expect.objectContaining({
        input: question,
        via: { kind: "voice", name: "Voice" },
      }),
    );
  });
});
