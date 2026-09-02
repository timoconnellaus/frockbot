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
import {
  initialComputerMachineState,
  transitionComputerState,
  type ComputerMachineEvent,
  type ComputerMachineState,
} from "./state-machine.js";
import "./styles.css";

const CONTROL_REFRESH_INTERVAL_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const computerClientPlugin: ClientPlugin = (ctx) => {
  const slot = ctx.slot({
    slot: "frockbot.computer",
    order: 10,
    component: ComputerCard,
  });
  // The Cordis local host publishes through `useRpc`; when no hosted
  // transport exists we deliberately provide nothing, so that provider wins.
  if (!ctx.transport.hostedRequest) return slot;

  const request = ctx.transport.hostedRequest.bind(ctx.transport);
  const shell = ctx.inject(frockBotWebDataKey);
  let machine = initialComputerMachineState();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const state = ref<ComputerState>({
    ...machine,
    connect: () => connect("connect-requested"),
    takeControl: () => takeControl(),
    releaseControl: () => releaseControl(),
    runDoctor: () => execute("runDoctor"),
    retry: () => connect("retry-requested"),
  });

  function apply(event: ComputerMachineEvent): void {
    machine = transitionComputerState(machine, event);
    Object.assign(state.value, machine);
    syncHeartbeat(machine);
  }

  function syncHeartbeat(current: ComputerMachineState): void {
    if (current.phase === "human-control") {
      if (!heartbeat) {
        heartbeat = setInterval(
          () => void refreshControl(),
          CONTROL_REFRESH_INTERVAL_MS,
        );
      }
      return;
    }
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function botId(): string {
    const selected = shell.value.activeBotId?.trim();
    if (!selected) throw new Error("Select a Bot before opening its Computer");
    return selected;
  }

  async function load(selectedBotId = botId()): Promise<void> {
    const projection = decodeComputerProjectionV1(
      await request(`/api/bots/${encodeURIComponent(selectedBotId)}/computer`),
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

  async function takeControl(): Promise<void> {
    if (!machine.viewerUrl) await connect("connect-requested");
    if (!machine.viewerUrl) return;
    apply({ type: "take-control-requested" });
    await execute("takeControl");
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

  const stopSelection = watch(
    () => shell.value.activeBotId,
    (selectedBotId) => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      machine = initialComputerMachineState();
      Object.assign(state.value, machine);
      if (!selectedBotId) return;
      void load(selectedBotId).catch((error) =>
        apply({ type: "failed", message: errorMessage(error) }),
      );
    },
    { immediate: true },
  );

  const provided = ctx.provide(computerKey, state);
  return [
    slot,
    provided,
    () => {
      stopSelection();
      if (heartbeat) clearInterval(heartbeat);
    },
  ];
};

export default computerClientPlugin;
