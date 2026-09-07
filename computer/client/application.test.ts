import { describe, expect, test } from "bun:test";
import type {
  ClientPluginContext,
  ClientSlotRegistration,
} from "@frockbot/client-core";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { nextTick, ref } from "vue";
import { computerKey, type ComputerState } from "../shared.js";
import {
  createComputerClientPlugin,
  ACTIVE_PROJECTION_POLL_INTERVAL_MS,
  PROJECTION_POLL_INTERVAL_MS,
  VIEWER_REFRESH_INTERVAL_MS,
  type ComputerClientRuntime,
} from "./application.js";

class FakeRuntime implements ComputerClientRuntime {
  visible = true;
  readonly intervals = new Map<
    number,
    { callback: () => void; milliseconds: number }
  >();
  private visibilityListener?: () => void;
  private nextTimer = 0;

  setInterval(callback: () => void, milliseconds: number): unknown {
    const id = ++this.nextTimer;
    this.intervals.set(id, { callback, milliseconds });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  isVisible(): boolean {
    return this.visible;
  }

  onVisibilityChange(listener: () => void): () => void {
    this.visibilityListener = listener;
    return () => {
      if (this.visibilityListener === listener) {
        this.visibilityListener = undefined;
      }
    };
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.visibilityListener?.();
  }

  tick(milliseconds: number): void {
    for (const interval of [...this.intervals.values()]) {
      if (interval.milliseconds === milliseconds) interval.callback();
    }
  }

  count(milliseconds: number): number {
    return [...this.intervals.values()].filter(
      (interval) => interval.milliseconds === milliseconds,
    ).length;
  }
}

type Phase = "idle" | "updating" | "ready" | "human-control" | "disconnected";

function mountHostedProvider(options: { stateChannel?: boolean } = {}) {
  const shell = ref({ activeBotId: "scout" });
  const calls: Array<[string, string | undefined, string | undefined]> = [];
  const runtime = new FakeRuntime();
  let phase: Phase = "idle";
  let hostUpdating = false;
  let controlHeld = false;
  let renewFails = false;
  let releaseFails = false;
  let heldClose: { release: () => void; pending: Promise<void> } | undefined;
  let state: { value: ComputerState } | undefined;
  const slots: ClientSlotRegistration[] = [];
  let stateObserver:
    | Parameters<
        NonNullable<ClientPluginContext["transport"]["watchBotState"]>
      >[1]
    | undefined;
  const context: ClientPluginContext = {
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      ...(options.stateChannel
        ? {
            watchBotState: (
              _botId: string,
              observer: NonNullable<typeof stateObserver>,
            ) => {
              stateObserver = observer;
              observer.status("connecting");
              return () => {
                stateObserver = undefined;
              };
            },
          }
        : {}),
      hostedRequest: (path, method, body) => {
        calls.push([path, method, body]);
        if (method === "POST") {
          const command = JSON.parse(body ?? "{}") as {
            commandId: string;
            type:
              | "connect"
              | "takeControl"
              | "releaseControl"
              | "refreshViewer"
              | "closeViewer";
          };
          if (command.type === "connect") {
            phase = hostUpdating ? "updating" : "ready";
          }
          if (command.type === "takeControl") {
            phase = "human-control";
            controlHeld = true;
          }
          if (command.type === "releaseControl" && !releaseFails) {
            controlHeld = false;
            if (phase !== "disconnected") phase = "ready";
          }
          if (command.type === "refreshViewer" && renewFails) {
            phase = "disconnected";
          }
          const receipt = {
            version: 1,
            commandId: command.commandId,
            type: command.type,
            status:
              (command.type === "refreshViewer" && renewFails) ||
              (command.type === "releaseControl" && releaseFails)
                ? "rejected"
                : "applied",
            completedAt: "2026-09-02T00:00:00.000Z",
            ...(command.type === "refreshViewer" && renewFails
              ? { failure: "viewer session expired" }
              : {}),
            ...(command.type === "releaseControl" && releaseFails
              ? { failure: "Sprite is unreachable" }
              : {}),
          };
          if (command.type === "closeViewer" && heldClose) {
            return heldClose.pending.then(() => receipt);
          }
          return Promise.resolve(receipt);
        }
        return Promise.resolve({
          version: 1,
          botId: "scout",
          providerLabel: "Fake Computer",
          phase,
          message:
            phase === "idle"
              ? "Ready to start"
              : phase === "updating"
                ? "Updating the Computer runtime"
                : "Computer ready",
          ...(phase === "updating"
            ? {
                progress: {
                  version: 1,
                  kind: "update",
                  startedAt: "2026-09-02T00:00:00.000Z",
                  updatedAt: "2026-09-02T00:00:02.000Z",
                  index: 1,
                  total: 2,
                  steps: [
                    {
                      version: 1,
                      id: "runtime",
                      label: "Updating the Computer runtime",
                      status: "active",
                    },
                  ],
                },
              }
            : {}),
          ...(phase === "idle" ||
          phase === "disconnected" ||
          phase === "updating"
            ? {}
            : {
                viewerSession: {
                  version: 1,
                  id: "viewer-1",
                  url: "https://viewer.invalid/secret#view_only=1",
                  expiresAt: "2099-09-02T00:01:30.000Z",
                },
              }),
          ...(controlHeld
            ? {
                controlLease: {
                  version: 1,
                  ownerId: "owner-1",
                  acquiredAt: "2026-09-02T00:00:00.000Z",
                  expiresAt: "2099-09-02T00:01:30.000Z",
                },
              }
            : {}),
          screenshots: [],
        });
      },
    },
    inject: (key) => {
      if (key === frockBotWebDataKey) return shell as never;
      throw new Error("unexpected client injection");
    },
    provide: (key, value) => {
      if (key === computerKey) state = value as { value: ComputerState };
      return () => {};
    },
    slot: (registration) => {
      slots.push(registration);
      return () => {};
    },
  };
  const disposers = createComputerClientPlugin(runtime)(context);
  return {
    calls,
    runtime,
    shell,
    slots,
    get state() {
      if (!state) throw new Error("Computer state was not provided");
      return state.value;
    },
    failRenewal() {
      renewFails = true;
    },
    failRelease() {
      releaseFails = true;
    },
    setUpdating() {
      phase = "updating";
      hostUpdating = true;
    },
    setReady() {
      hostUpdating = false;
    },
    holdCloseViewer() {
      let release = (): void => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldClose = { release, pending };
      return () => heldClose?.release();
    },
    channelStatus(status: "connecting" | "open" | "fallback" | "hidden") {
      stateObserver?.status(status);
    },
    dispose() {
      if (Array.isArray(disposers)) {
        for (const dispose of disposers.toReversed()) dispose();
      } else if (typeof disposers === "function") disposers();
    },
  };
}

async function flush(): Promise<void> {
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
}

function postedTypes(
  calls: Array<[string, string | undefined, string | undefined]>,
): string[] {
  return calls
    .filter(([, method]) => method === "POST")
    .map(([, , body]) => (JSON.parse(body ?? "{}") as { type: string }).type);
}

describe("hosted Computer provider", () => {
  test("mounts the card and overlay without connecting the Computer", async () => {
    const mounted = mountHostedProvider();
    await flush();

    expect(mounted.state.phase).toBe("idle");
    expect(mounted.slots.map((slot) => slot.slot)).toEqual([
      "frockbot.computer",
      "frockbot.overlays",
    ]);
    expect(postedTypes(mounted.calls)).toEqual([]);

    await mounted.state.openViewer();
    expect(mounted.state).toMatchObject({ phase: "ready", expanded: true });
    expect(postedTypes(mounted.calls)).toEqual(["connect"]);
    expect(mounted.runtime.count(ACTIVE_PROJECTION_POLL_INTERVAL_MS)).toBe(0);
    mounted.dispose();
  });

  test("a failed release stops the heartbeat and still closes the viewer", async () => {
    const mounted = mountHostedProvider();
    await flush();
    await mounted.state.openViewer();
    await mounted.state.takeControl();
    expect(mounted.state.phase).toBe("human-control");

    mounted.failRelease();
    await expect(mounted.state.releaseControl()).rejects.toThrow(
      "Sprite is unreachable",
    );

    // The projection here keeps reporting the lease — the worst case, a host
    // that cannot drop it. The client must still stop renewing: a takeover
    // whose release failed is one the User can never cancel otherwise.
    const before = postedTypes(mounted.calls).length;
    mounted.runtime.tick(VIEWER_REFRESH_INTERVAL_MS);
    await flush();
    expect(postedTypes(mounted.calls).slice(before)).not.toContain(
      "refreshControl",
    );

    // And the full-screen viewer is closable, rather than trapping the User.
    await mounted.state.closeViewer();
    await flush();
    expect(mounted.state.expanded).toBe(false);
    mounted.dispose();
  });

  test("refreshes the viewer only while the overlay is expanded", async () => {
    const mounted = mountHostedProvider();
    await flush();
    expect(mounted.runtime.count(VIEWER_REFRESH_INTERVAL_MS)).toBe(0);

    await mounted.state.openViewer();
    expect(mounted.runtime.count(VIEWER_REFRESH_INTERVAL_MS)).toBe(1);
    mounted.runtime.tick(VIEWER_REFRESH_INTERVAL_MS);
    await flush();
    expect(postedTypes(mounted.calls)).toEqual(["connect", "refreshViewer"]);

    await mounted.state.closeViewer();
    expect(mounted.runtime.count(VIEWER_REFRESH_INTERVAL_MS)).toBe(0);
    mounted.runtime.tick(VIEWER_REFRESH_INTERVAL_MS);
    await flush();
    expect(postedTypes(mounted.calls)).toEqual([
      "connect",
      "refreshViewer",
      "closeViewer",
    ]);
    mounted.dispose();
  });

  test("a held card preview keeps the same session alive, and a hidden tab drops it", async () => {
    const mounted = mountHostedProvider();
    await flush();
    await mounted.state.connect();
    await flush();
    // A minted session that nobody is watching is not renewed.
    expect(mounted.runtime.count(VIEWER_REFRESH_INTERVAL_MS)).toBe(0);

    mounted.state.holdLivePreview?.(true);
    expect(mounted.runtime.count(VIEWER_REFRESH_INTERVAL_MS)).toBe(1);
    mounted.runtime.tick(VIEWER_REFRESH_INTERVAL_MS);
    await flush();
    expect(postedTypes(mounted.calls)).toEqual(["connect", "refreshViewer"]);
    // The card never expands and never asks for control to watch a Bot work.
    expect(mounted.state.expanded).toBe(false);
    expect(mounted.state.takingControl).toBe(false);

    mounted.runtime.setVisible(false);
    expect(mounted.runtime.count(VIEWER_REFRESH_INTERVAL_MS)).toBe(0);
    mounted.runtime.setVisible(true);
    await flush();
    expect(mounted.runtime.count(VIEWER_REFRESH_INTERVAL_MS)).toBe(1);

    mounted.state.holdLivePreview?.(false);
    expect(mounted.runtime.count(VIEWER_REFRESH_INTERVAL_MS)).toBe(0);
    mounted.dispose();
  });

  test("an updating card click rejoins the update and lands on ready when it finishes", async () => {
    const mounted = mountHostedProvider();
    await flush();
    mounted.setUpdating();
    mounted.runtime.tick(PROJECTION_POLL_INTERVAL_MS);
    await flush();
    expect(mounted.state).toMatchObject({
      phase: "updating",
      message: "Updating the Computer runtime",
      expanded: false,
    });
    // A collapsed viewer never asks the host anything while it updates.
    expect(postedTypes(mounted.calls)).toEqual([]);

    // Opening rejoins: the host still reports the update, so the phase holds
    // and the progress view is what expands.
    await mounted.state.openViewer();
    expect(mounted.state).toMatchObject({
      phase: "updating",
      expanded: true,
      viewerUrl: undefined,
    });
    expect(postedTypes(mounted.calls)).toEqual(["connect"]);
    expect(mounted.runtime.count(ACTIVE_PROJECTION_POLL_INTERVAL_MS)).toBe(1);

    const readsBeforeFastPoll = mounted.calls.filter(
      ([, method]) => !method,
    ).length;
    mounted.runtime.tick(ACTIVE_PROJECTION_POLL_INTERVAL_MS);
    await flush();
    expect(postedTypes(mounted.calls)).toEqual(["connect"]);
    expect(
      mounted.calls.filter(([, method]) => !method).length,
    ).toBeGreaterThan(readsBeforeFastPoll);

    // Rejoin remains deliberately slower than the progress reads, so the
    // durable `updating` record is not the last word once the host finishes.
    mounted.setReady();
    mounted.runtime.tick(PROJECTION_POLL_INTERVAL_MS);
    await flush();
    expect(postedTypes(mounted.calls)).toEqual(["connect", "connect"]);
    expect(mounted.state).toMatchObject({
      phase: "ready",
      expanded: true,
      viewerUrl: "https://viewer.invalid/secret#view_only=1",
    });
    expect(mounted.runtime.count(ACTIVE_PROJECTION_POLL_INTERVAL_MS)).toBe(0);

    // Once ready, polls go back to reading only.
    mounted.runtime.tick(PROJECTION_POLL_INTERVAL_MS);
    await flush();
    expect(postedTypes(mounted.calls)).toEqual(["connect", "connect"]);
    mounted.dispose();
  });

  test("moves a failed viewer renewal to disconnected", async () => {
    const mounted = mountHostedProvider();
    await flush();
    await mounted.state.openViewer();
    mounted.failRenewal();

    mounted.runtime.tick(VIEWER_REFRESH_INTERVAL_MS);
    await flush();

    expect(mounted.state).toMatchObject({
      phase: "disconnected",
      viewerUrl: undefined,
      takingControl: false,
    });
    mounted.dispose();
  });

  test("a viewer failure under human control still releases on close", async () => {
    const mounted = mountHostedProvider();
    await flush();
    await mounted.state.openViewer();
    await mounted.state.takeControl();
    mounted.failRenewal();

    mounted.runtime.tick(VIEWER_REFRESH_INTERVAL_MS);
    await flush();
    expect(mounted.state).toMatchObject({
      phase: "disconnected",
      takingControl: true,
    });

    await mounted.state.closeViewer();
    expect(
      postedTypes(mounted.calls).filter((type) => type !== "refreshControl"),
    ).toEqual([
      "connect",
      "takeControl",
      "refreshViewer",
      "releaseControl",
      "closeViewer",
    ]);
    expect(mounted.state.expanded).toBe(false);
    mounted.dispose();
  });

  test("closing the overlay releases control before it collapses", async () => {
    const mounted = mountHostedProvider();
    await flush();
    await mounted.state.openViewer();
    await mounted.state.takeControl();

    await mounted.state.closeViewer();

    expect(mounted.state).toMatchObject({
      phase: "ready",
      takingControl: false,
      expanded: false,
    });
    expect(postedTypes(mounted.calls)).toEqual([
      "connect",
      "takeControl",
      "releaseControl",
      "closeViewer",
    ]);
    mounted.dispose();
  });

  test("the overlay collapses without waiting for the close capture", async () => {
    const mounted = mountHostedProvider();
    await flush();
    await mounted.state.openViewer();
    const releaseClose = mounted.holdCloseViewer();

    // The backend files an opportunistic screenshot on close, which crosses a
    // service binding to reach the Sprite. The User asked for the overlay to
    // go away; it must not sit on screen until a capture comes back.
    await mounted.state.closeViewer();

    expect(mounted.state.expanded).toBe(false);
    expect(postedTypes(mounted.calls)).toEqual(["connect", "closeViewer"]);
    expect(mounted.runtime.count(VIEWER_REFRESH_INTERVAL_MS)).toBe(0);

    releaseClose();
    await flush();
    expect(mounted.state.expanded).toBe(false);
    mounted.dispose();
  });

  test("polls the wake-free projection only while the tab is visible", async () => {
    const mounted = mountHostedProvider();
    await flush();
    const initialReads = mounted.calls.filter(([, method]) => !method).length;
    expect(mounted.runtime.count(PROJECTION_POLL_INTERVAL_MS)).toBe(1);

    mounted.runtime.setVisible(false);
    expect(mounted.runtime.count(PROJECTION_POLL_INTERVAL_MS)).toBe(0);
    mounted.runtime.tick(PROJECTION_POLL_INTERVAL_MS);
    await flush();
    expect(mounted.calls.filter(([, method]) => !method)).toHaveLength(
      initialReads,
    );

    mounted.runtime.setVisible(true);
    await flush();
    expect(mounted.runtime.count(PROJECTION_POLL_INTERVAL_MS)).toBe(1);
    expect(
      mounted.calls.filter(([, method]) => !method).length,
    ).toBeGreaterThan(initialReads);
    mounted.dispose();
  });

  test("polls only while the WebSocket channel is in fallback", async () => {
    const mounted = mountHostedProvider({ stateChannel: true });
    await flush();

    expect(mounted.runtime.count(PROJECTION_POLL_INTERVAL_MS)).toBe(0);
    mounted.channelStatus("fallback");
    expect(mounted.runtime.count(PROJECTION_POLL_INTERVAL_MS)).toBe(1);
    mounted.channelStatus("open");
    expect(mounted.runtime.count(PROJECTION_POLL_INTERVAL_MS)).toBe(0);
    mounted.dispose();
  });
});

test("the hosted provider stays absent when only the local RPC transport exists", () => {
  let provides = 0;
  const slots: string[] = [];
  const context: ClientPluginContext = {
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
    },
    inject: () => {
      throw new Error("the local path must not inject hosted state");
    },
    provide: () => {
      provides += 1;
      return () => {};
    },
    slot: (registration) => {
      slots.push(registration.slot);
      return () => {};
    },
  };

  const dispose = createComputerClientPlugin(new FakeRuntime())(context);

  expect(provides).toBe(0);
  expect(slots).toEqual(["frockbot.computer", "frockbot.overlays"]);
  if (typeof dispose === "function") dispose();
});
