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

function mountHostedProvider() {
  const shell = ref({ activeBotId: "scout" });
  const calls: Array<[string, string | undefined, string | undefined]> = [];
  const runtime = new FakeRuntime();
  let phase: Phase = "idle";
  let hostUpdating = false;
  let controlHeld = false;
  let renewFails = false;
  let state: { value: ComputerState } | undefined;
  const slots: ClientSlotRegistration[] = [];
  const context: ClientPluginContext = {
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      hostedRequest: (path, method, body) => {
        calls.push([path, method, body]);
        if (method === "POST") {
          const command = JSON.parse(body ?? "{}") as {
            commandId: string;
            type:
              "connect" | "takeControl" | "releaseControl" | "refreshViewer";
          };
          if (command.type === "connect") {
            phase = hostUpdating ? "updating" : "ready";
          }
          if (command.type === "takeControl") {
            phase = "human-control";
            controlHeld = true;
          }
          if (command.type === "releaseControl") {
            controlHeld = false;
            if (phase !== "disconnected") phase = "ready";
          }
          if (command.type === "refreshViewer" && renewFails) {
            phase = "disconnected";
          }
          return Promise.resolve({
            version: 1,
            commandId: command.commandId,
            type: command.type,
            status:
              command.type === "refreshViewer" && renewFails
                ? "rejected"
                : "applied",
            completedAt: "2026-09-02T00:00:00.000Z",
            ...(command.type === "refreshViewer" && renewFails
              ? { failure: "viewer session expired" }
              : {}),
          });
        }
        return Promise.resolve({
          version: 1,
          botId: "scout",
          providerLabel: "Fake Computer",
          phase,
          message:
            phase === "idle"
              ? "Persistent Computer available"
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
    setUpdating() {
      phase = "updating";
      hostUpdating = true;
    },
    setReady() {
      hostUpdating = false;
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
  test("mounts the card and strip without connecting the Computer", async () => {
    const mounted = mountHostedProvider();
    await flush();

    expect(mounted.state.phase).toBe("idle");
    expect(mounted.slots.map((slot) => slot.slot)).toEqual([
      "frockbot.computer",
      "frockbot.sidebar-computer",
      "frockbot.overlays",
    ]);
    expect(postedTypes(mounted.calls)).toEqual([]);

    await mounted.state.openViewer();
    expect(mounted.state).toMatchObject({ phase: "ready", expanded: true });
    expect(postedTypes(mounted.calls)).toEqual(["connect"]);
    expect(mounted.runtime.count(ACTIVE_PROJECTION_POLL_INTERVAL_MS)).toBe(0);
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
    expect(postedTypes(mounted.calls)).toEqual(["connect", "refreshViewer"]);
    mounted.dispose();
  });

  test("an updating strip click rejoins the update and lands on ready when it finishes", async () => {
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
    // A collapsed strip never asks the host anything while it updates.
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
    ).toEqual(["connect", "takeControl", "refreshViewer", "releaseControl"]);
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
    ]);
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
  expect(slots).toEqual([
    "frockbot.computer",
    "frockbot.sidebar-computer",
    "frockbot.overlays",
  ]);
  if (typeof dispose === "function") dispose();
});
