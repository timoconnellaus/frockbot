import { expect, test } from "bun:test";
import type {
  ClientPluginContext,
  ClientSlotRegistration,
} from "@frockbot/client-core";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { nextTick, ref } from "vue";
import { computerKey, type ComputerState } from "../shared.js";
import { computerClientPlugin } from "./application.js";

test("the hosted Computer provider drives the card through a fake transport", async () => {
  const shell = ref({ activeBotId: "scout" });
  const calls: Array<[string, string | undefined, string | undefined]> = [];
  let phase: "idle" | "ready" | "human-control" = "idle";
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
            type: "connect" | "takeControl" | "releaseControl";
          };
          if (command.type === "connect") phase = "ready";
          if (command.type === "takeControl") phase = "human-control";
          if (command.type === "releaseControl") phase = "ready";
          return Promise.resolve({
            version: 1,
            commandId: command.commandId,
            type: command.type,
            status: "applied",
            completedAt: "2026-09-02T00:00:00.000Z",
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
              : "Computer ready",
          ...(phase === "idle"
            ? {}
            : {
                viewerSession: {
                  version: 1,
                  id: "viewer-1",
                  url: "https://viewer.invalid/secret",
                  expiresAt: "2099-09-02T00:01:30.000Z",
                },
              }),
          ...(phase === "human-control"
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
  const disposers = computerClientPlugin(context);
  await nextTick();
  await Promise.resolve();
  expect(state?.value.phase).toBe("idle");
  await state?.value.connect();
  expect(state?.value).toMatchObject({
    phase: "ready",
    viewerUrl: "https://viewer.invalid/secret",
  });
  await state?.value.takeControl();
  expect(state?.value.phase).toBe("human-control");
  await state?.value.releaseControl();
  expect(state?.value.phase).toBe("ready");
  expect(
    calls
      .filter(([, method]) => method === "POST")
      .map(([, , body]) => (JSON.parse(body ?? "{}") as { type: string }).type),
  ).toEqual(["connect", "takeControl", "releaseControl"]);
  if (Array.isArray(disposers)) {
    for (const dispose of disposers.toReversed()) dispose();
  }
});

test("the hosted provider stays absent when only the local RPC transport exists", () => {
  let provides = 0;
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
    slot: () => () => {},
  };

  const dispose = computerClientPlugin(context);

  expect(provides).toBe(0);
  if (typeof dispose === "function") dispose();
});
