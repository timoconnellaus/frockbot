import { describe, expect, test } from "bun:test";
import {
  clientSurfaceRegistryKey,
  type ClientPluginContext,
  type ClientSurfaceRegistry,
} from "@frockbot/client-core";
import { computed, ref } from "vue";
import { voiceClientPlugin } from "./index.js";
import { voiceClientStateKey, type VoiceClientStateV1 } from "./state.js";

function surfaceRegistry(): ClientSurfaceRegistry {
  const activeId = ref<string>();
  return {
    activeId,
    active: computed(() => undefined),
    register: () => () => {},
    has: () => false,
    open: (id) => {
      activeId.value = id;
    },
    close: () => {
      activeId.value = undefined;
    },
  };
}

function mount(
  hostedRequest: NonNullable<ClientPluginContext["transport"]["hostedRequest"]>,
): { calls: string[]; state: { value: VoiceClientStateV1 } } {
  const calls: string[] = [];
  const surfaces = surfaceRegistry();
  let state: unknown;
  const context: ClientPluginContext = {
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      hostedRequest: (path, method, body) => {
        calls.push(path);
        return hostedRequest(path, method, body);
      },
    },
    inject: (key) => {
      if (key === clientSurfaceRegistryKey) return surfaces as never;
      throw new Error("unexpected client provider");
    },
    provide: (key, value) => {
      if (key === voiceClientStateKey) state = value;
      return () => {};
    },
    slot: () => () => {},
  };
  voiceClientPlugin(context);
  return {
    calls,
    state: state as { value: VoiceClientStateV1 },
  };
}

describe("Voice client contribution", () => {
  test("does not read User voice state before authenticated chrome mounts", () => {
    const mounted = mount(() => Promise.reject(new Error("unauthenticated")));

    expect(mounted.calls).toEqual([]);
  });

  test("reads User voice state when authenticated chrome asks for it", async () => {
    const mounted = mount(() =>
      Promise.resolve({
        schemaVersion: 1,
        ledger: {
          schemaVersion: 1,
          state: {
            schemaVersion: 1,
            enabled: false,
            updatedAt: "2026-09-04T00:00:00.000Z",
          },
          sessions: [],
          pendingAnswers: [],
        },
        quota: {
          schemaVersion: 1,
          month: "2026-09",
          usedSeconds: 120,
          limitSeconds: 3_600,
          remainingSeconds: 3_480,
        },
      }),
    );

    await mounted.state.value.refresh();

    expect(mounted.calls).toEqual(["/api/voice"]);
    expect(mounted.state.value.quotaRemainingSeconds).toBe(3_480);
    expect(mounted.state.value.quotaLimitSeconds).toBe(3_600);
  });
});
