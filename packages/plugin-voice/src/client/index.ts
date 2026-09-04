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
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1 } from "@frockbot/protocol";
import { ref, watch } from "vue";
import {
  decodeVoiceAssistantViewV1,
  VOICE_MAX_TOOL_CALLS_V1,
  VOICE_MAX_TRANSCRIPT_ENTRIES_V1,
  type VoiceToolNameV1,
} from "../shared.js";
import { createVoicePlaybackV1, type VoicePlaybackV1 } from "./playback.js";
import { deliverPendingVoiceNotificationsV1 } from "./pending-notifications.js";
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
  "ask_bot",
];
const VOICE_PENDING_POLL_INTERVAL_MS_V1 = 15_000;

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
  /** Invalidates a permission prompt or socket callback from an older toggle. */
  let attempt = 0;
  let quotaTicker: ReturnType<typeof setInterval> | undefined;
  let refreshInFlight: Promise<void> | undefined;

  const releaseMedia = async (): Promise<void> => {
    if (quotaTicker !== undefined) clearInterval(quotaTicker);
    quotaTicker = undefined;
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

  const refresh = (): Promise<void> => {
    if (!request) return Promise.resolve();
    if (refreshInFlight) return refreshInFlight;
    const currentAttempt = attempt;
    refreshInFlight = request("/api/voice")
      .then(decodeVoiceAssistantViewV1)
      .then(async (view) => {
        // The monthly ceiling is stable even if the User turns Voice on while
        // this read is in flight. Live remaining time is owned by the socket.
        state.value.quotaLimitSeconds = view.quota.limitSeconds;
        if (currentAttempt !== attempt || state.value.status !== "offline") {
          return;
        }
        state.value.enabled = view.ledger.state.enabled;
        state.value.quotaRemainingSeconds = view.quota.remainingSeconds;
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
        } else {
          await deliverPendingVoiceNotificationsV1(view.ledger.pendingAnswers);
        }
      })
      .catch(() => {
        if (currentAttempt === attempt && state.value.status === "offline") {
          state.value.message = "Voice status couldn't be loaded.";
        }
      })
      .finally(() => {
        refreshInFlight = undefined;
      });
    return refreshInFlight;
  };

  const state = ref<VoiceClientStateV1>({
    enabled: false,
    status: "offline",
    level: 0,
    quotaRemainingSeconds: 0,
    quotaLimitSeconds: 0,
    transcript: [],
    tools: [],
    refresh,
    open() {
      surfaces.open(VOICE_SURFACE_ID_V1);
    },
    async toggle() {
      state.value.open();
      if (state.value.status !== "offline") {
        attempt += 1;
        state.value.enabled = false;
        state.value.status = "offline";
        state.value.message = "Voice is off.";
        const stopping = session;
        session = undefined;
        stopping?.stop();
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
      const currentAttempt = ++attempt;
      let openingSession: VoiceAssistantSessionV1 | undefined;
      let openedMicrophone: VoiceMicrophoneV1 | undefined;
      let openedPlayback: VoicePlaybackV1 | undefined;
      try {
        openedMicrophone = await startVoiceMicrophoneV1({
          sampleRate: VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1,
          audio(audio) {
            openingSession?.sendAudio(audio);
          },
          level(level) {
            if (currentAttempt !== attempt) return;
            state.value.level = level;
          },
        });
        if (currentAttempt !== attempt) {
          await openedMicrophone.stop();
          return;
        }
        openedPlayback = createVoicePlaybackV1();
        openingSession = openAssistant(deviceIdV1(), {
          ready(sessionId, quotaRemainingSeconds) {
            if (currentAttempt !== attempt) return;
            if (quotaTicker !== undefined) clearInterval(quotaTicker);
            const quotaStartedAt = Date.now();
            state.value.session = {
              sessionId,
              startedAt: new Date().toISOString(),
            };
            state.value.transcript = [];
            state.value.tools = [];
            state.value.quotaRemainingSeconds = quotaRemainingSeconds;
            state.value.status = "listening";
            quotaTicker = setInterval(() => {
              if (currentAttempt !== attempt) return;
              const elapsed = Math.floor((Date.now() - quotaStartedAt) / 1_000);
              state.value.quotaRemainingSeconds = Math.max(
                0,
                quotaRemainingSeconds - elapsed,
              );
            }, 1_000);
          },
          state(liveState) {
            if (currentAttempt !== attempt) return;
            state.value.status = liveState;
          },
          transcript(entry) {
            if (currentAttempt !== attempt) return;
            state.value.transcript = [
              ...state.value.transcript,
              { schemaVersion: 1 as const, ...entry },
            ].slice(-VOICE_MAX_TRANSCRIPT_ENTRIES_V1);
          },
          tool(entry) {
            if (currentAttempt !== attempt) return;
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
            if (currentAttempt !== attempt) return;
            openedPlayback?.play(audio);
          },
          interrupted() {
            if (currentAttempt !== attempt) return;
            openedPlayback?.interrupt();
            state.value.status = "listening";
          },
          offline(reason, message) {
            if (currentAttempt !== attempt) return;
            attempt += 1;
            serverEnded = true;
            session = undefined;
            state.value.enabled = false;
            state.value.status = "offline";
            state.value.message = message;
            void releaseMedia();
            if (reason === "quota" || reason === "error") {
              void notifyOffline(message);
            }
          },
          failed(message) {
            if (currentAttempt !== attempt || serverEnded) return;
            attempt += 1;
            serverEnded = true;
            session = undefined;
            state.value.enabled = false;
            state.value.status = "offline";
            state.value.message = message;
            void releaseMedia();
            void notifyOffline(message);
          },
          closed() {
            if (currentAttempt !== attempt) return;
            attempt += 1;
            session = undefined;
            if (serverEnded || state.value.status === "offline") return;
            state.value.status = "offline";
            state.value.message =
              "Voice is still ready. Turn it on to reconnect this device.";
            void releaseMedia();
          },
        });
        if (currentAttempt !== attempt) {
          openingSession.close();
          await Promise.all([openedMicrophone.stop(), openedPlayback.close()]);
          return;
        }
        microphone = openedMicrophone;
        playback = openedPlayback;
        session = openingSession;
      } catch (error) {
        if (currentAttempt !== attempt) {
          openingSession?.close();
          await Promise.all([
            openedMicrophone?.stop(),
            openedPlayback?.close(),
          ]);
          return;
        }
        attempt += 1;
        state.value.enabled = false;
        state.value.status = "offline";
        state.value.message = voiceMicrophoneRefusalV1(error);
        openingSession?.stop();
        session = undefined;
        await Promise.all([openedMicrophone?.stop(), openedPlayback?.close()]);
      }
    },
  });

  const pendingPoll = setInterval(() => {
    if (state.value.status === "offline") void refresh();
  }, VOICE_PENDING_POLL_INTERVAL_MS_V1);

  /*
   * A live session is work a reload would throw away, and the Voice surface
   * is a panel rather than an overlay, so the shell cannot see it any other
   * way. Holding is how a Package says "not right now" without the shell
   * knowing anything about Voice.
   */
  const web = ctx.inject(frockBotWebDataKey);
  let releaseHold: (() => void) | undefined;
  const stopHold = watch(
    () => state.value.status !== "offline",
    (live) => {
      if (live && !releaseHold) releaseHold = web.value.holdReload();
      else if (!live && releaseHold) {
        releaseHold();
        releaseHold = undefined;
      }
    },
    // Synchronous: the hold has to be up before anything can act on the
    // status change, or a reload could land in the gap.
    { immediate: true, flush: "sync" },
  );

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
      stopHold();
      releaseHold?.();
      releaseHold = undefined;
      clearInterval(pendingPoll);
      attempt += 1;
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
