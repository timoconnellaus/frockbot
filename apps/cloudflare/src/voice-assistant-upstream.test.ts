import { describe, expect, test } from "bun:test";
import {
  parseVoiceAssistantUpstreamFrameV1,
  voiceAssistantSetupV1,
  voiceAssistantUpstreamTargetV1,
} from "./voice-assistant-upstream.js";

describe("Gemini Live assistant upstream", () => {
  test("selects override, direct secret, then Gateway BYOK", () => {
    expect(
      voiceAssistantUpstreamTargetV1({
        VOICE_ASSISTANT_UPSTREAM_URL: "ws://fake/live?frock_idle_ms=500",
        GEMINI_API_KEY: "direct",
      }).path,
    ).toBe("override");
    expect(
      voiceAssistantUpstreamTargetV1({ GEMINI_API_KEY: "direct" }),
    ).toMatchObject({
      path: "gemini",
      url: expect.stringContaining("?key=direct"),
    });
    expect(
      voiceAssistantUpstreamTargetV1({
        FROCK_AI_ACCOUNT_ID: "account",
        FROCK_AI_GATEWAY_TOKEN: "token",
      }),
    ).toEqual({
      path: "gateway",
      url: "wss://gateway.ai.cloudflare.com/v1/account/flock/google",
      headers: { "cf-aig-authorization": "Bearer token" },
    });
  });

  test("sends the documented audio setup and a resumable handle", () => {
    expect(voiceAssistantSetupV1("resume-1")).toMatchObject({
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: { responseModalities: ["AUDIO"] },
        sessionResumption: { handle: "resume-1" },
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: false },
          activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
        },
      },
    });
  });

  test("decodes every audio part, tool calls, resumption, and goAway", () => {
    expect(
      parseVoiceAssistantUpstreamFrameV1(
        JSON.stringify({
          serverContent: {
            modelTurn: {
              parts: [
                { inlineData: { data: "AA==" } },
                { inlineData: { data: "AQ==" } },
              ],
            },
            interrupted: true,
          },
          toolCall: {
            functionCalls: [{ id: "call-1", name: "list_bots", args: {} }],
          },
          sessionResumptionUpdate: { resumable: true, newHandle: "handle-1" },
          goAway: { timeLeft: "1.5s" },
        }),
      ),
    ).toMatchObject({
      audio: ["AA==", "AQ=="],
      interrupted: true,
      resumptionHandle: "handle-1",
      goAwayMs: 1_500,
      functionCalls: [{ id: "call-1", name: "list_bots", args: {} }],
    });
  });
});
