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
