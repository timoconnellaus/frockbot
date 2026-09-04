/// <reference path="../env.d.ts" />

// The hosted Computer client projects the Bot Durable Object and submits one
// versioned command per action. The viewer bearer URL is held only on this
// in-memory state object and is never copied into browser navigation state.
import type { ClientPlugin } from "@frockbot/client-core";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { ref, watch } from "vue";
import {
  decodeComputerCommandResponse,
  decodeComputerProjectionV1,
  type ComputerCommandTypeV1,
} from "../protocol.js";
import { computerKey, type ComputerState } from "../shared.js";
import ComputerCard from "./ComputerCard.vue";
import ComputerViewerOverlay from "./ComputerViewerOverlay.vue";
import {
  initialComputerMachineState,
  transitionComputerState,
  type ComputerMachineEvent,
} from "./state-machine.js";
import "./styles.css";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";

export const PROJECTION_POLL_INTERVAL_MS = 20_000;
export const ACTIVE_PROJECTION_POLL_INTERVAL_MS = 1_500;
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
    let projectionPollInterval: number | undefined;
    let stateChannelStatus: "connecting" | "open" | "fallback" | "hidden" = ctx
      .transport.watchBotState
      ? "connecting"
      : "fallback";
    let stopStateChannel: (() => void) | undefined;
    let updateRejoin: unknown;
    let controlRequest: Promise<void> | undefined;
    /** Set by a release the backend refused; no heartbeat renews after it. */
    let controlAbandoned = false;
    /**
     * Whether a view-only card preview is watching the desktop right now.
     *
     * It is the card's declaration, not a second session: the heartbeat it
     * keeps alive renews the same minted viewer the overlay would use.
     */
    let livePreviewHeld = false;

    const state = ref<ComputerState>({
      ...machine,
      connect: () => connect("connect-requested"),
      openViewer: () => openViewer(),
      holdLivePreview: (held: boolean) => holdLivePreview(held),
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
      syncProjectionPoll();
      syncUpdateRejoin();
    }

    function stopControlHeartbeat(): void {
      if (controlHeartbeat !== undefined) {
        runtime.clearInterval(controlHeartbeat);
      }
      controlHeartbeat = undefined;
    }

    function syncControlHeartbeat(): void {
      // A release the backend could not confirm ends the heartbeat for good.
      // Renewing a lease the User has already asked to drop is how a takeover
      // becomes one that cannot be cancelled; the next explicit `takeControl`
      // is what starts it again.
      if (machine.phase !== "human-control" || controlAbandoned) {
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
      // A hidden tab watches nothing, so it renews nothing: the slot lapses
      // and the Sprite stops paying for a stream no one is looking at.
      const watching =
        machine.expanded || (livePreviewHeld && runtime.isVisible());
      if (!watching || !machine.viewerUrl) {
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
      projectionPollInterval = undefined;
    }

    function syncProjectionPoll(): void {
      if (
        stateChannelStatus !== "fallback" ||
        !shell.value.activeBotId ||
        !runtime.isVisible()
      ) {
        stopProjectionPoll();
        return;
      }
      const interval =
        machine.expanded &&
        (machine.phase === "provisioning" ||
          machine.phase === "updating" ||
          machine.phase === "taking-control")
          ? ACTIVE_PROJECTION_POLL_INTERVAL_MS
          : PROJECTION_POLL_INTERVAL_MS;
      if (projectionPoll !== undefined && projectionPollInterval === interval) {
        return;
      }
      stopProjectionPoll();
      projectionPollInterval = interval;
      projectionPoll = runtime.setInterval(() => {
        const selectedBotId = shell.value.activeBotId;
        if (!selectedBotId || !runtime.isVisible()) return;
        // Projection reads are wake-free. Expanded operations read quickly so
        // durable provider progress is visible without inventing client state.
        void load(selectedBotId).catch((error) =>
          apply({ type: "failed", message: errorMessage(error) }),
        );
      }, interval);
    }

    function watchStateChannel(selectedBotId: string | undefined): void {
      stopStateChannel?.();
      stopStateChannel = undefined;
      if (!selectedBotId || !ctx.transport.watchBotState) {
        stateChannelStatus = selectedBotId ? "fallback" : "hidden";
        syncProjectionPoll();
        return;
      }
      stopStateChannel = ctx.transport.watchBotState(selectedBotId, {
        async invalidate(topic) {
          if (topic !== undefined && topic !== "computer") return;
          if (shell.value.activeBotId !== selectedBotId) return;
          await load(selectedBotId);
        },
        status(status) {
          stateChannelStatus = status;
          syncProjectionPoll();
        },
      });
    }

    function stopUpdateRejoin(): void {
      if (updateRejoin !== undefined) runtime.clearInterval(updateRejoin);
      updateRejoin = undefined;
    }

    function syncUpdateRejoin(): void {
      if (
        updateRejoin !== undefined ||
        machine.phase !== "updating" ||
        !machine.expanded ||
        !shell.value.activeBotId ||
        !runtime.isVisible()
      ) {
        if (
          machine.phase !== "updating" ||
          !machine.expanded ||
          !shell.value.activeBotId ||
          !runtime.isVisible()
        ) {
          stopUpdateRejoin();
        }
        return;
      }
      // An update only advances when a connect rejoins the host operation.
      // Keep that effect cadence at 20s; only the durable reads accelerate.
      updateRejoin = runtime.setInterval(() => {
        if (!runtime.isVisible()) return;
        void execute("connect").catch(() => {
          // A refusal keeps the updating phase; the next interval rejoins.
        });
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
        throw new Error("This computer belongs to a different Bot.");
      }
      apply({ type: "projection-received", projection });
    }

    async function post(type: ComputerCommandTypeV1): Promise<void> {
      const selectedBotId = botId();
      const receipt = decodeComputerCommandResponse(
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
        // A connect can be refused because the host is already applying an
        // update. The Bot authority records that typed phase even though the
        // command receipt is rejected, so read its durable projection before
        // deciding this is a generic client error.
        try {
          await load();
        } catch {
          // The original command failure remains the useful answer.
        }
        if (type === "connect" && machine.phase === "updating") return;
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
      // Idle wakes. Updating rejoins: the host either hands back the viewer
      // because the update has finished, or refuses again with its phase.
      const wake = machine.phase === "idle" || machine.phase === "updating";
      apply({ type: "viewer-expanded" });
      if (!wake) return;
      if (machine.phase === "updating") {
        await execute("connect").catch(() => {
          // Still updating; the durable update-rejoin cadence continues.
        });
        return;
      }
      await connect("connect-requested");
    }

    function holdLivePreview(held: boolean): void {
      if (livePreviewHeld === held) return;
      livePreviewHeld = held;
      syncViewerHeartbeat();
    }

    async function closeViewer(): Promise<void> {
      if (!machine.expanded) return;
      // A host with no Computer never had a viewer session to close.
      const hadComputer = machine.phase !== "unconfigured";
      if (controlRequest) {
        try {
          await controlRequest;
        } catch {
          // The failed acquisition already projected its error. There is no
          // lease to release before this explicit close finishes.
        }
      }
      if (machine.takingControl) {
        try {
          await releaseControl();
        } catch {
          // A release the Computer refused is already recorded durably and
          // has stopped the heartbeat. It is not a reason to keep the User
          // inside a full-screen viewer they asked to leave.
        }
      }
      // Collapse first. The capture the backend files on close is
      // opportunistic, and it crosses a service binding to take a screenshot
      // on the Sprite; an overlay that stayed on screen waiting for that would
      // be the stall this capture was added to make unnecessary. Post rather
      // than execute, so a refused capture never projects a failure onto a
      // Computer the User has already stopped watching.
      apply({ type: "viewer-collapsed" });
      // A viewer that never existed has nothing to close, and the capture the
      // command files is of a session that was never opened.
      if (!hadComputer) return;
      void (async () => {
        try {
          await post("closeViewer");
          await load();
        } catch {
          // The durable projection remains the only truth about the Computer.
        }
      })();
    }

    function takeControl(): Promise<void> {
      if (controlRequest) return controlRequest;
      controlAbandoned = false;
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
      try {
        await execute("releaseControl");
      } catch (error) {
        controlAbandoned = true;
        syncControlHeartbeat();
        throw error;
      }
    }

    async function refreshControl(): Promise<void> {
      try {
        await post("refreshControl");
        await load();
      } catch (error) {
        apply({
          type: "failed",
          message: `You lost control of this computer: ${errorMessage(error)}`,
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
        stopUpdateRejoin();
        controlAbandoned = false;
        // The card remounts its preview against the newly selected Bot; a
        // hold carried across would renew the previous Bot's session.
        livePreviewHeld = false;
        machine = initialComputerMachineState();
        Object.assign(state.value, machine);
        watchStateChannel(selectedBotId);
        if (!selectedBotId || !runtime.isVisible()) return;
        void load(selectedBotId).catch((error) =>
          apply({ type: "failed", message: errorMessage(error) }),
        );
      },
      { immediate: true },
    );
    const stopVisibility = runtime.onVisibilityChange(() => {
      syncProjectionPoll();
      syncViewerHeartbeat();
      syncUpdateRejoin();
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
        stopStateChannel?.();
        stopProjectionPoll();
        stopUpdateRejoin();
      },
    ];
  };
}

export const computerClientPlugin = createComputerClientPlugin();

export default computerClientPlugin;

/**
 * The manifest's `client` entry, resolved by specifier. The application looks
 * this descriptor up in its Contribution table; it never branches on which
 * Package it belongs to.
 */
export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-computer/client",
  plugin: computerClientPlugin,
});
