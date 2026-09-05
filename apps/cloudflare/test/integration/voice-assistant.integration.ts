// The actual gateway → VoiceSession DO → UserConfiguration DO boundary.
//
// The deployment is configured with the scriptable Gemini Live stand-in in
// `test/voice-upstream-fake.ts`, so the transport's answer to a provider that
// misbehaves — a refused resumption handle, a socket that never answers a
// setup — is observable here as the frames a browser or a phone would actually
// receive, beside what the User-owned durable ledger recorded.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { TOOL_CALL_TRIGGER } from "../harness/miniflare.ts";
import {
  voiceUpstreamFakeModeUrl,
  voiceUpstreamFakeSetupsUrl,
  type VoiceUpstreamFakeModeV1,
  type VoiceUpstreamFakeSetupV1,
} from "../voice-upstream-fake.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

async function useUpstreamMode(mode: VoiceUpstreamFakeModeV1): Promise<void> {
  const response = await fetch(voiceUpstreamFakeModeUrl(mode));
  expect(response.status).toBe(200);
}

async function upstreamSetups(): Promise<VoiceUpstreamFakeSetupV1[]> {
  const response = await fetch(voiceUpstreamFakeSetupsUrl());
  return ((await response.json()) as { setups: VoiceUpstreamFakeSetupV1[] })
    .setups;
}

/** Opens the assistant socket a client opens, and collects what it is told. */
async function openAssistant(
  userId: string,
  deviceId = "integration-device",
): Promise<{ socket: WebSocket; frames: Array<Record<string, unknown>> }> {
  const response = await asUser(
    userId,
    `/api/voice/assistant?version=1&device=${deviceId}`,
    { headers: { upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeDefined();
  socket!.accept();
  const frames: Array<Record<string, unknown>> = [];
  socket!.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      frames.push(JSON.parse(event.data) as Record<string, unknown>);
    }
  });
  return { socket: socket!, frames };
}

/**
 * Leaves a resumption handle in the User ledger, the way an earlier session on
 * another device would have. Voice's next start sends it to the provider.
 */
async function seedResumptionHandle(
  userId: string,
  handle: string,
): Promise<void> {
  const user = env.USER_CONFIGURATIONS.getByName(userId) as unknown as {
    startVoiceAssistant(input: unknown): Promise<unknown>;
    saveVoiceResumptionHandle(input: unknown): Promise<void>;
    endVoiceAssistant(input: unknown): Promise<unknown>;
  };
  const at = new Date().toISOString();
  const month = at.slice(0, 7);
  const sessionId = "seeded-voice-session";
  await user.startVoiceAssistant({
    schemaVersion: 1,
    userId,
    month,
    sessionId,
    deviceId: "seed-device",
    at,
  });
  await user.saveVoiceResumptionHandle({
    schemaVersion: 1,
    userId,
    sessionId,
    handle,
    at,
  });
  await user.endVoiceAssistant({
    schemaVersion: 1,
    userId,
    month,
    sessionId,
    at,
    reason: "stopped",
    seconds: 0,
  });
}

describe("Voice assistant Durable Object boundary", () => {
  it("gives up and tells the client when the provider never accepts a setup", async () => {
    await useUpstreamMode("closing");
    const userId = freshUserId("voice-assistant");
    const { frames } = await openAssistant(userId);
    await vi.waitFor(() => {
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "offline", reason: "error" }),
      );
    });
    // Bounded, not endless: the transport retried and then stopped, rather
    // than reopening the same refused socket for as long as the client waited.
    expect((await upstreamSetups()).length).toBe(3);

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

  it("retries without a resumption handle the provider refused, and reaches ready", async () => {
    await useUpstreamMode("stale-handle");
    const userId = freshUserId("voice-resume");
    await seedResumptionHandle(userId, "stale-resumption-handle");
    const { socket, frames } = await openAssistant(userId);

    await vi.waitFor(() => {
      expect(frames).toContainEqual(expect.objectContaining({ type: "ready" }));
    });
    // The first setup carried the stored handle and was refused; the second
    // carried none, which is the only difference that could have earned a
    // different answer.
    expect(await upstreamSetups()).toEqual([
      { handle: "stale-resumption-handle" },
      {},
    ]);
    expect(frames).not.toContainEqual(
      expect.objectContaining({ type: "offline" }),
    );

    socket.send(JSON.stringify({ schemaVersion: 1, type: "stop" }));
    await vi.waitFor(() => {
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "offline", reason: "stopped" }),
      );
    });
  });

  it("stops waiting when the provider accepts the socket and answers nothing", async () => {
    await useUpstreamMode("silent");
    const userId = freshUserId("voice-silent");
    const { frames } = await openAssistant(userId);

    await vi.waitFor(
      () => {
        expect(frames).toContainEqual(
          expect.objectContaining({
            type: "offline",
            reason: "error",
            message: expect.stringContaining("too long to connect"),
          }),
        );
      },
      { timeout: 15_000 },
    );
    expect(frames).not.toContainEqual(
      expect.objectContaining({ type: "ready" }),
    );

    await vi.waitFor(async () => {
      const view = (await expectOkJson(await asUser(userId, "/api/voice"))) as {
        ledger: { state: { enabled: boolean } };
      };
      expect(view.ledger.state.enabled).toBe(false);
    });
  });

  it("admits ask_bot to the target Bot and records its first send as voice/answered", async () => {
    await useUpstreamMode("ready");
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
