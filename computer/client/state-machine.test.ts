import { describe, expect, test } from "bun:test";
import {
  initialComputerMachineState,
  transitionComputerState,
} from "./state-machine.js";

describe("Computer client state machine", () => {
  test("moves through every viewer and control transition used by the card", () => {
    let state = transitionComputerState(initialComputerMachineState(), {
      type: "configured",
      botId: "scout",
      providerLabel: "Fly Sprites",
      configured: true,
      message: "Persistent Fly Sprite computer",
    });
    expect(state.phase).toBe("idle");
    state = transitionComputerState(state, { type: "connect-requested" });
    expect(state.phase).toBe("provisioning");
    state = transitionComputerState(state, {
      type: "connected",
      viewerUrl: "https://viewer.invalid/session",
    });
    expect(state).toMatchObject({ phase: "ready", takingControl: false });
    state = transitionComputerState(state, {
      type: "take-control-requested",
    });
    expect(state.phase).toBe("taking-control");
    state = transitionComputerState(state, { type: "control-acquired" });
    expect(state).toMatchObject({
      phase: "human-control",
      takingControl: true,
    });
    state = transitionComputerState(state, { type: "control-released" });
    expect(state).toMatchObject({ phase: "ready", takingControl: false });
  });

  test("moves to error without discarding whether control was held", () => {
    const state = transitionComputerState(
      {
        ...initialComputerMachineState(),
        phase: "human-control",
        takingControl: true,
      },
      { type: "failed", message: "lease was lost" },
    );
    expect(state).toMatchObject({
      phase: "error",
      message: "lease was lost",
      takingControl: true,
    });
  });

  test("retry returns an error state to provisioning", () => {
    const failed = transitionComputerState(initialComputerMachineState(), {
      type: "failed",
      message: "wake failed",
    });
    const retried = transitionComputerState(failed, {
      type: "retry-requested",
    });
    expect(retried).toMatchObject({
      phase: "provisioning",
      takingControl: false,
    });
  });

  test("moves into updating with its label and out when connection completes", () => {
    const updating = transitionComputerState(initialComputerMachineState(), {
      type: "update-reported",
      message: "Updating the Computer runtime",
    });
    const ready = transitionComputerState(updating, {
      type: "connected",
      viewerUrl: "https://viewer.invalid/session",
    });

    expect(updating).toMatchObject({
      phase: "updating",
      message: "Updating the Computer runtime",
      viewerUrl: undefined,
    });
    expect(ready).toMatchObject({
      phase: "ready",
      message: "Computer ready",
      viewerUrl: "https://viewer.invalid/session",
    });
  });

  test("marks a dead viewer disconnected and clears the frozen session", () => {
    const disconnected = transitionComputerState(
      {
        ...initialComputerMachineState(),
        phase: "ready",
        viewerUrl: "https://viewer.invalid/secret",
      },
      { type: "viewer-disconnected", message: "Viewer session expired" },
    );

    expect(disconnected).toMatchObject({
      phase: "disconnected",
      message: "Viewer session expired",
      viewerUrl: undefined,
      takingControl: false,
    });
  });

  test("a dead viewer preserves a held control lease so close can release it", () => {
    const disconnected = transitionComputerState(
      {
        ...initialComputerMachineState(),
        phase: "human-control",
        viewerUrl: "https://viewer.invalid/secret",
        takingControl: true,
      },
      { type: "viewer-disconnected", message: "Viewer session expired" },
    );

    expect(disconnected).toMatchObject({
      phase: "disconnected",
      viewerUrl: undefined,
      takingControl: true,
    });
  });

  test("an idle card click expands before its connect request", () => {
    const idle = {
      ...initialComputerMachineState(),
      phase: "idle" as const,
    };
    const expanded = transitionComputerState(idle, {
      type: "viewer-expanded",
    });
    const connecting = transitionComputerState(expanded, {
      type: "connect-requested",
    });

    expect(expanded).toMatchObject({ phase: "idle", expanded: true });
    expect(connecting).toMatchObject({
      phase: "provisioning",
      expanded: true,
    });
  });

  test("keeps the durable capture object until its content hash changes", () => {
    const first = {
      version: 1 as const,
      path: "scout/first.png",
      capturedAt: "2026-09-02T00:00:00.000Z",
      contentHash: "sha256:first",
      url: "/workspace/first",
    };
    const state = {
      ...initialComputerMachineState(),
      screenshots: [first],
    };
    const unchanged = transitionComputerState(state, {
      type: "projection-received",
      projection: {
        version: 1,
        botId: "scout",
        providerLabel: "Fake Computer",
        phase: "idle",
        message: "Computer available",
        screenshots: [{ ...first, url: "/workspace/reissued" }],
      },
    });
    const changed = transitionComputerState(unchanged, {
      type: "projection-received",
      projection: {
        version: 1,
        botId: "scout",
        providerLabel: "Fake Computer",
        phase: "idle",
        message: "Computer available",
        screenshots: [
          {
            ...first,
            contentHash: "sha256:second",
            url: "/workspace/second",
          },
        ],
      },
    });

    expect(unchanged.screenshots[0]).toBe(first);
    expect(changed.screenshots[0]).not.toBe(first);
  });

  test("projects durable opening progress without inventing a client step", () => {
    const progress = {
      version: 1 as const,
      kind: "connect" as const,
      startedAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:02.000Z",
      index: 3,
      total: 5,
      steps: [
        {
          version: 1 as const,
          id: "starting-desktop",
          label: "Starting the desktop",
          status: "active" as const,
        },
      ],
    };
    const state = transitionComputerState(initialComputerMachineState(), {
      type: "projection-received",
      projection: {
        version: 1,
        botId: "scout",
        providerLabel: "Fake Computer",
        phase: "provisioning",
        message: "Starting the desktop",
        progress,
        screenshots: [],
      },
    });

    expect(state.progress).toEqual(progress);
  });

  test("reset explicitly clears viewer secrets from an existing projection", () => {
    const projected = {
      ...initialComputerMachineState(),
      phase: "ready" as const,
      viewerUrl: "https://viewer.invalid/secret",
    };

    Object.assign(projected, initialComputerMachineState());

    expect(projected.viewerUrl).toBeUndefined();
  });
});
