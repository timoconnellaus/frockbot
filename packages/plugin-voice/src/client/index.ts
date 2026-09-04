import {
  clientSurfaceRegistryKey,
  type ClientPlugin,
  type VoiceAssistantSessionV1,
} from "@frockbot/client-core";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";
import {
  startVoiceMicrophoneV1,
  voiceCaptureSupportedV1,
  voiceMicrophoneRefusalV1,
  type VoiceMicrophoneV1,
} from "@frockbot/plugin-shell/client/voice-microphone";
import { showClientNotificationV1 } from "@frockbot/plugin-shell/client/notify";
import { VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1 } from "@frockbot/protocol";
import { ref } from "vue";
import {
  decodeVoiceAssistantViewV1,
  VOICE_MAX_TOOL_CALLS_V1,
  VOICE_MAX_TRANSCRIPT_ENTRIES_V1,
  type VoiceToolNameV1,
} from "../shared.js";
import { createVoicePlaybackV1, type VoicePlaybackV1 } from "./playback.js";
import VoiceSurface from "./VoiceSurface.vue";
import VoiceToggle from "./VoiceToggle.vue";
import { voiceClientStateKey, type VoiceClientStateV1 } from "./state.js";
import "./styles.css";

export const VOICE_SURFACE_ID_V1 = "voice";
const DEVICE_KEY_V1 = "frockbot.voice.device.v1";
const TOOL_NAMES: readonly VoiceToolNameV1[] = [
  "list_bots",
  "bot_activity",
  "memory_search",
  "pending_answers",
];

function deviceIdV1(): string {
  if (typeof window === "undefined") return crypto.randomUUID();
  try {
    const stored = window.localStorage.getItem(DEVICE_KEY_V1);
    if (stored && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(stored)) {
      return stored;
    }
    const created = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY_V1, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export const voiceClientPlugin: ClientPlugin = (ctx) => {
  const request = ctx.transport.hostedRequest?.bind(ctx.transport);
  const openAssistant = ctx.transport.openVoiceAssistant?.bind(ctx.transport);
  const surfaces = ctx.inject(clientSurfaceRegistryKey);
  let microphone: VoiceMicrophoneV1 | undefined;
  let playback: VoicePlaybackV1 | undefined;
  let session: VoiceAssistantSessionV1 | undefined;
  let serverEnded = false;

  const releaseMedia = async (): Promise<void> => {
    const heldMicrophone = microphone;
    const heldPlayback = playback;
    microphone = undefined;
    playback = undefined;
    await Promise.all([heldMicrophone?.stop(), heldPlayback?.close()]);
  };

  const notifyOffline = async (message: string): Promise<void> => {
    await showClientNotificationV1({
      title: "Voice is offline",
      body: message,
    });
  };

  const state = ref<VoiceClientStateV1>({
    enabled: false,
    status: "offline",
    level: 0,
    quotaRemainingSeconds: 0,
    quotaLimitSeconds: 0,
    transcript: [],
    tools: [],
    open() {
      surfaces.open(VOICE_SURFACE_ID_V1);
    },
    async toggle() {
      state.value.open();
      if (state.value.status !== "offline") {
        state.value.enabled = false;
        state.value.status = "offline";
        state.value.message = "Voice is off.";
        session?.stop();
        await releaseMedia();
        return;
      }
      if (!openAssistant || !voiceCaptureSupportedV1()) {
        state.value.message = "Voice isn't available on this device.";
        return;
      }
      state.value.status = "connecting";
      state.value.message = undefined;
      state.value.enabled = true;
      serverEnded = false;
      try {
        microphone = await startVoiceMicrophoneV1({
          sampleRate: VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1,
          audio(audio) {
            session?.sendAudio(audio);
          },
          level(level) {
            state.value.level = level;
          },
        });
        playback = createVoicePlaybackV1();
        session = openAssistant(deviceIdV1(), {
          ready(sessionId, quotaRemainingSeconds) {
            state.value.session = {
              sessionId,
              startedAt: new Date().toISOString(),
            };
            state.value.transcript = [];
            state.value.tools = [];
            state.value.quotaRemainingSeconds = quotaRemainingSeconds;
            state.value.status = "listening";
          },
          state(liveState) {
            state.value.status = liveState;
          },
          transcript(entry) {
            state.value.transcript = [
              ...state.value.transcript,
              { schemaVersion: 1 as const, ...entry },
            ].slice(-VOICE_MAX_TRANSCRIPT_ENTRIES_V1);
          },
          tool(entry) {
            if (!TOOL_NAMES.includes(entry.name as VoiceToolNameV1)) return;
            state.value.tools = [
              ...state.value.tools,
              {
                schemaVersion: 1 as const,
                ...entry,
                name: entry.name as VoiceToolNameV1,
              },
            ].slice(-VOICE_MAX_TOOL_CALLS_V1);
          },
          audio(audio) {
            playback?.play(audio);
          },
          interrupted() {
            playback?.interrupt();
            state.value.status = "listening";
          },
          offline(reason, message) {
            serverEnded = true;
            state.value.enabled = false;
            state.value.status = "offline";
            state.value.message = message;
            void releaseMedia();
            if (reason === "quota" || reason === "error") {
              void notifyOffline(message);
            }
          },
          failed(message) {
            if (serverEnded) return;
            serverEnded = true;
            state.value.enabled = false;
            state.value.status = "offline";
            state.value.message = message;
            void releaseMedia();
            void notifyOffline(message);
          },
          closed() {
            session = undefined;
            if (serverEnded || state.value.status === "offline") return;
            state.value.status = "offline";
            state.value.message =
              "Voice is still ready. Turn it on to reconnect this device.";
            void releaseMedia();
          },
        });
      } catch (error) {
        state.value.enabled = false;
        state.value.status = "offline";
        state.value.message = voiceMicrophoneRefusalV1(error);
        session?.stop();
        session = undefined;
        await releaseMedia();
      }
    },
  });

  if (request) {
    void request("/api/voice")
      .then(decodeVoiceAssistantViewV1)
      .then((view) => {
        state.value.enabled = view.ledger.state.enabled;
        state.value.quotaRemainingSeconds = view.quota.remainingSeconds;
        state.value.quotaLimitSeconds = view.quota.limitSeconds;
        const latest = view.ledger.state.activeSessionId
          ? view.ledger.sessions.find(
              (entry) => entry.sessionId === view.ledger.state.activeSessionId,
            )
          : view.ledger.sessions[0];
        if (latest) {
          state.value.session = latest;
          state.value.transcript = latest.transcript;
          state.value.tools = latest.toolCalls;
        }
        if (view.ledger.state.enabled) {
          state.value.message =
            "Voice is ready to resume. Turn it on to reconnect this device.";
        }
      })
      .catch(() => {
        state.value.message = "Voice status couldn't be loaded.";
      });
  }

  return [
    ctx.provide(voiceClientStateKey, state),
    surfaces.register({
      id: VOICE_SURFACE_ID_V1,
      title: "Voice",
      component: VoiceSurface,
      placement: "panel",
    }),
    ctx.slot({
      slot: "frockbot.header-actions",
      order: 20,
      component: VoiceToggle,
    }),
    () => {
      session?.close();
      session = undefined;
      void releaseMedia();
    },
  ];
};

export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-voice/client",
  plugin: voiceClientPlugin,
});

export default voiceClientPlugin;
