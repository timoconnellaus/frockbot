// The one channel between the settings section and the device agent.
//
// The renderer is a remote page. It cannot be handed the machine token, and it
// is not trusted to name what runs — so this bridge exposes exactly three
// verbs, each of which is a desktop command the Package registered, and each
// answer is a status object with nothing secret on it.
//
// The pairing code is the only thing that crosses inward, and it is not a
// capability: it is one-time, five minutes old at most, and the renderer only
// has one because it just asked the backend for it *with the user's session*.

import type { DesktopCommandRegistry } from "@frockbot/desktop-core";
import {
  MACHINE_AGENT_PAIR_COMMAND_V1,
  MACHINE_AGENT_STATUS_COMMAND_V1,
  MACHINE_AGENT_UNPAIR_COMMAND_V1,
} from "@frockbot/plugin-user-machine/desktop";
import {
  decodeDesktopMachineRequest,
  decodeDesktopMachineStatus,
  isTrustedRendererUrl,
} from "./desktop-api.js";

export const MACHINE_CHANNEL = "frockbot:machine";

export interface MachineBridgeHostV1 {
  desktopCommands: Pick<DesktopCommandRegistry, "invoke">;
}

/**
 * The handler, without Electron.
 *
 * `senderUrl` is `event.senderFrame?.url`, and the origin check is the same
 * one the auth bridge makes: a frame that is not the hosted application may
 * not reach the agent, whatever it claims to be.
 */
export function createMachineBridgeHandlerV1(
  host: MachineBridgeHostV1,
  applicationOrigin: string,
): (senderUrl: string | undefined, value: unknown) => Promise<unknown> {
  return async (senderUrl, value) => {
    if (!isTrustedRendererUrl(senderUrl, applicationOrigin)) {
      throw new Error("untrusted renderer");
    }
    const request = decodeDesktopMachineRequest(value);
    if (request.type === "machine/status") {
      return decodeDesktopMachineStatus(
        await host.desktopCommands.invoke(MACHINE_AGENT_STATUS_COMMAND_V1, {}),
      );
    }
    if (request.type === "machine/unpair") {
      return decodeDesktopMachineStatus(
        await host.desktopCommands.invoke(MACHINE_AGENT_UNPAIR_COMMAND_V1, {}),
      );
    }
    return decodeDesktopMachineStatus(
      await host.desktopCommands.invoke(MACHINE_AGENT_PAIR_COMMAND_V1, {
        code: request.code,
      }),
    );
  };
}
