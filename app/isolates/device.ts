// The `device` grant's one call: a Plugin tool asking its own device module
// to do something on the person's computer (ADR 0037).
//
// Everything that can be refused is refused here, before anything is
// recorded: a call outside the Turn, from outside one of this Plugin's tool
// calls, to a module or a call its descriptor does not declare, or with an
// input too large to send. What passes goes to the User's object, which
// records it under an id derived from the tool call's effect and answers a
// replay from that record.
import type {
  IsolateDeviceCallOutcomeV1,
  IsolateDeviceCallRequestV1,
} from "@frockbot/core/contracts";
import { MACHINE_LIMITS_V1 } from "@frockbot/core/machine-protocol";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { activeIsolateTurn } from "./authority.js";
import type { IsolateCallScopeV1 } from "./bot.js";

function failed(error: string): IsolateDeviceCallOutcomeV1 {
  return { ok: false, outcome: "failed", error };
}

/**
 * The id one device call is recorded under: the Bot, the Session (an effect
 * id is unique only inside one), the tool call's effect and the call's place
 * among that tool call's device calls.
 */
export async function deviceCallIdV1(input: {
  botId: string;
  sessionId: string;
  effectId: string;
  sequence: number;
}): Promise<string> {
  const digest = await sha256HexTextV1(
    `${input.botId}\n${input.sessionId}\n${input.effectId}\n${input.sequence}`,
  );
  return `mc-${digest.slice(0, 40)}`;
}

export async function isolateDeviceCall(
  state: ShellBotStateV1,
  input: IsolateCallScopeV1 & { request: IsolateDeviceCallRequestV1 },
): Promise<IsolateDeviceCallOutcomeV1> {
  const request = input.request;
  const active = activeIsolateTurn(state, input);
  if (!active) {
    return failed("a device module is called only from a tool call in a Turn");
  }
  const member = active.mounted.generation.members.find(
    (candidate) => candidate.packageId === input.packageId,
  );
  const module = member?.descriptor?.device?.modules?.find(
    (candidate) => candidate.id === request.moduleId,
  );
  if (!module) {
    return failed(
      `this Plugin declares no device module "${request.moduleId}"`,
    );
  }
  if (!module.calls.includes(request.call)) {
    return failed(
      `device module "${request.moduleId}" declares no call "${request.call}"`,
    );
  }
  // Plugin code writes the effect id, so it is taken only while this Plugin's
  // tool call under that id is running here: a hook, a page or a section
  // cannot borrow one.
  if (
    request.effectId === undefined ||
    active.mounted.runtime.services.pluginToolEffects?.get(request.effectId) !==
      input.packageId
  ) {
    return failed(
      "a device module is called only from this Plugin's tool call",
    );
  }
  if (JSON.stringify(request.input).length > MACHINE_LIMITS_V1.moduleCallJson) {
    return failed(
      `the input is larger than ${MACHINE_LIMITS_V1.moduleCallJson} characters of JSON`,
    );
  }
  const callId = await deviceCallIdV1({
    botId: input.botId,
    sessionId: input.sessionId,
    effectId: request.effectId,
    sequence: request.sequence,
  });
  try {
    const user = state.env.USER_CONFIGURATIONS.get(
      state.env.USER_CONFIGURATIONS.idFromName(input.userId),
    );
    return decodeDeviceCallOutcomeV1(
      await user.callDeviceModule({
        schemaVersion: 1,
        userId: input.userId,
        botId: input.botId,
        callId,
        pluginId: input.packageId,
        moduleId: request.moduleId,
        call: request.call,
        input: request.input,
        ...(request.deviceId === undefined
          ? {}
          : { deviceId: request.deviceId }),
      }),
    );
  } catch {
    // The call may have gone down the socket before the answer was lost.
    return {
      ok: false,
      outcome: "unknown",
      error:
        "the answer from the computer was lost; the call may have taken effect",
    };
  }
}

function decodeDeviceCallOutcomeV1(value: unknown): IsolateDeviceCallOutcomeV1 {
  const outcome = value as Record<string, unknown> | null;
  if (outcome?.ok === true) return { ok: true, value: outcome.value ?? null };
  if (
    outcome?.ok === false &&
    (outcome.outcome === "failed" || outcome.outcome === "unknown") &&
    typeof outcome.error === "string"
  ) {
    return { ok: false, outcome: outcome.outcome, error: outcome.error };
  }
  throw new Error("device call outcome is invalid");
}
