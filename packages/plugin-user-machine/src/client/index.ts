/// <reference path="../env.d.ts" />

// The Computer settings section: the user's own machines, live.
//
// Everything here goes through `ctx.transport.hostedRequest`, which is the
// session, and through `@frockbot/machine-protocol`'s decoders, which are the
// seam. The one thing that does not is the desktop bridge — `window
// .frockbotMachineAgent`, exposed by the Electron preload — and its answers
// are decoded too, because a different runtime is a seam whoever owns it.
//
// The pairing UX is two-sided on purpose:
//
//   * in the **desktop shell**, "Pair this computer" mints a code and hands it
//     straight to the agent in the main process; the code never leaves the
//     app. There is also a field to paste a code minted elsewhere, which is
//     what "enter pairing code" means when the browser and the laptop are two
//     different devices.
//   * in a **browser**, there is no agent to hand a code to, so the section
//     shows the code and its expiry and says where to type it.
//
// Revoking is the browser's, always: a machine cannot un-revoke itself, and
// the token dies on the next verify wherever the laptop is.

import {
  clientSurfaceRegistryKey,
  type ClientPlugin,
} from "@frockbot/client-core";
import {
  decodeMachineListViewV1,
  decodeMachinePairingOfferV1,
  machineRoutePathV1,
} from "@frockbot/machine-protocol";
import { ref } from "vue";
import { decodeMachineDeviceAgentStatusV1 } from "../device.js";
import MachineSection from "./MachineSection.vue";
import MachineSurface from "./MachineSurface.vue";
import {
  machinesStateKey,
  type MachineAgentBridgeV1,
  type MachinesClientState,
} from "./state.js";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";

/** The surface the section opens. Not a settings anchor: a registered surface. */
export const MACHINE_SURFACE_ID_V1 = "user-machines";

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** The desktop bridge, if this client is running inside the Electron shell. */
export function machineAgentBridgeV1(): MachineAgentBridgeV1 | undefined {
  const bridge = (globalThis as { frockbotMachineAgent?: MachineAgentBridgeV1 })
    .frockbotMachineAgent;
  return typeof bridge?.pair === "function" ? bridge : undefined;
}

export const userMachineClientPlugin: ClientPlugin = (ctx) => {
  const surfaces = ctx.inject(clientSurfaceRegistryKey);
  const bridge = machineAgentBridgeV1();
  const request = (
    path: string,
    method?: "GET" | "POST",
    body?: string,
  ): Promise<unknown> => {
    if (!ctx.transport.hostedRequest) {
      throw new Error("Registered machines are unavailable on this client");
    }
    return ctx.transport.hostedRequest(path, method, body);
  };

  const mintOffer = async (label?: string): Promise<void> => {
    state.value.offer = decodeMachinePairingOfferV1(
      await request(
        machineRoutePathV1("pair"),
        "POST",
        JSON.stringify(label === undefined ? {} : { label }),
      ),
    );
  };

  const readAgent = async (): Promise<void> => {
    if (!bridge) return;
    state.value.agent = decodeMachineDeviceAgentStatusV1(await bridge.status());
  };

  const guarded = async (work: () => Promise<void>): Promise<void> => {
    state.value.busy = true;
    try {
      await work();
      state.value.error = undefined;
    } catch (error) {
      state.value.error = message(error, "The machine registry refused");
    } finally {
      state.value.busy = false;
    }
  };

  const state = ref<MachinesClientState>({
    busy: false,
    desktop: bridge !== undefined,
    async load() {
      await guarded(async () => {
        state.value.view = decodeMachineListViewV1(
          await request(machineRoutePathV1("list")),
        );
        await readAgent();
      });
    },
    async requestCode(label?: string) {
      await guarded(() => mintOffer(label));
    },
    async pairThisComputer() {
      await guarded(async () => {
        if (!bridge) throw new Error("This client is not the desktop app");
        await mintOffer();
        const offer = state.value.offer;
        if (!offer) throw new Error("No pairing code was issued");
        state.value.agent = decodeMachineDeviceAgentStatusV1(
          await bridge.pair(offer.code),
        );
        // The code is one-time: once it has been spent it is not a secret to
        // keep showing, and showing it invites a second, failing, attempt.
        state.value.offer = undefined;
        state.value.view = decodeMachineListViewV1(
          await request(machineRoutePathV1("list")),
        );
      });
    },
    async enterCode(code: string) {
      await guarded(async () => {
        if (!bridge) throw new Error("This client is not the desktop app");
        state.value.agent = decodeMachineDeviceAgentStatusV1(
          await bridge.pair(code.trim()),
        );
        state.value.offer = undefined;
        state.value.view = decodeMachineListViewV1(
          await request(machineRoutePathV1("list")),
        );
      });
    },
    async revoke(machineId: string) {
      await guarded(async () => {
        // Revocation answers with the whole registry, so the row's new state
        // comes from the authority rather than from a local edit.
        state.value.view = decodeMachineListViewV1(
          await request(
            machineRoutePathV1("revoke", { machineId }),
            "POST",
            JSON.stringify({}),
          ),
        );
        if (state.value.agent?.machineId === machineId) await readAgent();
      });
    },
    async forgetThisComputer() {
      await guarded(async () => {
        if (!bridge) throw new Error("This client is not the desktop app");
        state.value.agent = decodeMachineDeviceAgentStatusV1(
          await bridge.unpair(),
        );
      });
    },
  });

  return [
    ctx.provide(machinesStateKey, state),
    surfaces.register({
      id: MACHINE_SURFACE_ID_V1,
      title: "Registered machines",
      component: MachineSurface,
    }),
    ctx.slot({
      slot: "frockbot.user-settings-sections",
      order: 30,
      component: MachineSection,
    }),
  ];
};

export default userMachineClientPlugin;

/**
 * The manifest's `client` entry, resolved by specifier. The application looks
 * this descriptor up in its Contribution table; it never branches on which
 * Package it belongs to.
 */
export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-user-machine/client",
  plugin: userMachineClientPlugin,
});
