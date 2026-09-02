/// <reference path="../env.d.ts" />

// The hosted Computer client projects the Bot Durable Object and submits one
// versioned command per action. The viewer bearer URL is held only on this
// in-memory state object and is never copied into browser navigation state.
import type { ClientPlugin } from "@frockbot/client-core";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { ref, watch } from "vue";
import {
  decodeComputerCommandReceiptV1,
  decodeComputerProjectionV1,
  type ComputerCommandTypeV1,
} from "../protocol.js";
import { computerKey, type ComputerState } from "../shared.js";
import ComputerCard from "./ComputerCard.vue";
import ComputerStrip from "./ComputerStrip.vue";
import ComputerViewerOverlay from "./ComputerViewerOverlay.vue";
import {
  initialComputerMachineState,
  transitionComputerState,
  type ComputerMachineEvent,
  type ComputerMachineState,
} from "./state-machine.js";
import "./styles.css";

export const PROJECTION_POLL_INTERVAL_MS = 20_000;
export const VIEWER_REFRESH_INTERVAL_MS = 30_000;
const CONTROL_REFRESH_INTERVAL_MS = 30_000;

export interface ComputerClientRuntime {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
  isVisible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
}

const browserRuntime: ComputerClientRuntime = {
  setInterval: (callback, milliseconds) =>
    globalThis.setInterval(callback, milliseconds),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  isVisible: () =>
    typeof document === "undefined" || document.visibilityState === "visible",
  onVisibilityChange: (listener) => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the lifecycle-owned hosted provider.
 *
 * The runtime argument is the browser clock and visibility seam. Tests drive
 * it without sleeping; production uses `document.visibilityState`, ensuring a
 * hidden tab submits neither a projection poll nor a wake command (P1/P4).
 */
export function createComputerClientPlugin(
  runtime: ComputerClientRuntime = browserRuntime,
): ClientPlugin {
  return (ctx) => {
    const slots = [
      ctx.slot({
        slot: "frockbot.computer",
        order: 10,
        component: ComputerCard,
      }),
      ctx.slot({
        slot: "frockbot.sidebar-computer",
        order: 10,
        component: ComputerStrip,
      }),
      ctx.slot({
        slot: "frockbot.overlays",
        order: 20,
        component: ComputerViewerOverlay,
      }),
    ];
    // The Cordis local host publishes through `useRpc`; when no hosted
    // transport exists we deliberately provide nothing, so that provider wins.
    if (!ctx.transport.hostedRequest) return slots;

    const request = ctx.transport.hostedRequest.bind(ctx.transport);
    const shell = ctx.inject(frockBotWebDataKey);
    let machine = initialComputerMachineState();
    let controlHeartbeat: unknown;
    let viewerHeartbeat: unknown;
    let projectionPoll: unknown;
    let controlRequest: Promise<void> | undefined;

    const state = ref<ComputerState>({
      ...machine,
      connect: () => connect("connect-requested"),
      openViewer: () => openViewer(),
      closeViewer: () => closeViewer(),
      takeControl: () => takeControl(),
      releaseControl: () => releaseControl(),
      runDoctor: () => execute("runDoctor"),
      retry: () => connect("retry-requested"),
    });

    function apply(event: ComputerMachineEvent): void {
      machine = transitionComputerState(machine, event);
      Object.assign(state.value, machine);
      syncControlHeartbeat();
      syncViewerHeartbeat();
    }

    function stopControlHeartbeat(): void {
      if (controlHeartbeat !== undefined) {
        runtime.clearInterval(controlHeartbeat);
      }
      controlHeartbeat = undefined;
    }

    function syncControlHeartbeat(): void {
      if (machine.phase !== "human-control") {
        stopControlHeartbeat();
        return;
      }
      if (controlHeartbeat === undefined) {
        controlHeartbeat = runtime.setInterval(
          () => void refreshControl(),
          CONTROL_REFRESH_INTERVAL_MS,
        );
      }
    }

    function stopViewerHeartbeat(): void {
      if (viewerHeartbeat !== undefined) {
        runtime.clearInterval(viewerHeartbeat);
      }
      viewerHeartbeat = undefined;
    }

    function syncViewerHeartbeat(): void {
      if (!machine.expanded || !machine.viewerUrl) {
        stopViewerHeartbeat();
        return;
      }
      if (viewerHeartbeat === undefined) {
        // This command, not the strip and not a projection read, is the only
        // client activity that keeps a watched desktop's slot live (P3).
        viewerHeartbeat = runtime.setInterval(
          () => void refreshViewer(),
          VIEWER_REFRESH_INTERVAL_MS,
        );
      }
    }

    function stopProjectionPoll(): void {
      if (projectionPoll !== undefined) runtime.clearInterval(projectionPoll);
      projectionPoll = undefined;
    }

    function syncProjectionPoll(): void {
      stopProjectionPoll();
      if (!shell.value.activeBotId || !runtime.isVisible()) return;
      projectionPoll = runtime.setInterval(() => {
        const selectedBotId = shell.value.activeBotId;
        if (!selectedBotId || !runtime.isVisible()) return;
        void load(selectedBotId).catch((error) =>
          apply({ type: "failed", message: errorMessage(error) }),
        );
      }, PROJECTION_POLL_INTERVAL_MS);
    }

    function botId(): string {
      const selected = shell.value.activeBotId?.trim();
      if (!selected)
        throw new Error("Select a Bot before opening its Computer");
      return selected;
    }

    async function load(selectedBotId = botId()): Promise<void> {
      const projection = decodeComputerProjectionV1(
        await request(
          `/api/bots/${encodeURIComponent(selectedBotId)}/computer`,
        ),
      );
      if (projection.botId !== selectedBotId) {
        throw new Error("Computer projection does not match the selected Bot");
      }
      apply({ type: "projection-received", projection });
    }

    async function post(type: ComputerCommandTypeV1): Promise<void> {
      const selectedBotId = botId();
      const receipt = decodeComputerCommandReceiptV1(
        await request(
          `/api/bots/${encodeURIComponent(selectedBotId)}/computer/commands`,
          "POST",
          JSON.stringify({
            version: 1,
            commandId: crypto.randomUUID(),
            botId: selectedBotId,
            type,
          }),
        ),
      );
      if (receipt.status === "rejected") throw new Error(receipt.failure);
    }

    async function execute(type: ComputerCommandTypeV1): Promise<void> {
      try {
        await post(type);
        await load();
      } catch (error) {
        apply({ type: "failed", message: errorMessage(error) });
        throw error;
      }
    }

    async function connect(
      event: "connect-requested" | "retry-requested",
    ): Promise<void> {
      apply({ type: event });
      await execute("connect");
    }

    async function openViewer(): Promise<void> {
      if (machine.expanded) return;
      const wake = machine.phase === "idle";
      apply({ type: "viewer-expanded" });
      if (wake) await connect("connect-requested");
    }

    async function closeViewer(): Promise<void> {
      if (!machine.expanded) return;
      if (controlRequest) {
        try {
          await controlRequest;
        } catch {
          // The failed acquisition already projected its error. There is no
          // lease to release before this explicit close finishes.
        }
      }
      if (machine.takingControl) await releaseControl();
      apply({ type: "viewer-collapsed" });
    }

    function takeControl(): Promise<void> {
      if (controlRequest) return controlRequest;
      const pending = (async () => {
        if (!machine.viewerUrl) await connect("connect-requested");
        if (!machine.viewerUrl) return;
        apply({ type: "take-control-requested" });
        await execute("takeControl");
      })();
      controlRequest = pending.finally(() => {
        controlRequest = undefined;
      });
      return controlRequest;
    }

    async function releaseControl(): Promise<void> {
      await execute("releaseControl");
    }

    async function refreshControl(): Promise<void> {
      try {
        await post("refreshControl");
        await load();
      } catch (error) {
        apply({
          type: "failed",
          message: `Human control lease was lost: ${errorMessage(error)}`,
          takingControl: false,
        });
      }
    }

    async function refreshViewer(): Promise<void> {
      try {
        await post("refreshViewer");
        await load();
      } catch (error) {
        apply({
          type: "viewer-disconnected",
          message: `Viewer disconnected: ${errorMessage(error)}`,
        });
      }
    }

    const stopSelection = watch(
      () => shell.value.activeBotId,
      (selectedBotId) => {
        stopControlHeartbeat();
        stopViewerHeartbeat();
        machine = initialComputerMachineState();
        Object.assign(state.value, machine);
        syncProjectionPoll();
        if (!selectedBotId || !runtime.isVisible()) return;
        void load(selectedBotId).catch((error) =>
          apply({ type: "failed", message: errorMessage(error) }),
        );
      },
      { immediate: true },
    );
    const stopVisibility = runtime.onVisibilityChange(() => {
      syncProjectionPoll();
      const selectedBotId = shell.value.activeBotId;
      if (!selectedBotId || !runtime.isVisible()) return;
      void load(selectedBotId).catch((error) =>
        apply({ type: "failed", message: errorMessage(error) }),
      );
    });

    const provided = ctx.provide(computerKey, state);
    return [
      ...slots,
      provided,
      () => {
        stopSelection();
        stopVisibility();
        stopControlHeartbeat();
        stopViewerHeartbeat();
        stopProjectionPoll();
      },
    ];
  };
}

export const computerClientPlugin = createComputerClientPlugin();

export default computerClientPlugin;
