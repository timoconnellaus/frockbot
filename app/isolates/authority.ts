// Whether one loopback call is admitted at all, shared by every grant handler
// and by the model transport that reaches upstream on a Plugin's behalf.
//
// A grant call names its scope, and the scope is untrusted — a Plugin writes
// it. What makes it a grant is that this object is running that Turn (or that
// standalone call), that generation, and that Plugin.
import type {
  ActiveTurnV1,
  ShellBotStateV1,
} from "@frockbot/app/shell/backend-state";

/** The scope fields every admitted call names, decoded by the RPC boundary. */
export interface IsolateCallIdentityV1 {
  runId: string;
  sessionId: string;
  turnId: string;
  packageId: string;
  generationId: string;
}

/**
 * Whether a loopback call is admitted at all: it names the resident Turn, or
 * a standalone call this object registered (a trigger delivery, a section
 * render, a control's press), and that Turn or call mounted the Plugin the
 * scope names. Grants that need nothing but the Bot's own storage or
 * authority gate on this; the `schedule` grant needs the Turn's runtime and
 * gates on {@link activeIsolateTurn}.
 */
export function isolateCallAdmittedV1(
  state: ShellBotStateV1,
  input: IsolateCallIdentityV1,
): boolean {
  if (activeIsolateTurn(state, input)) return true;
  const call = state.turn.standalone(input.runId);
  return (
    call !== undefined &&
    call.sessionId === input.sessionId &&
    call.turnId === input.turnId &&
    call.generationId === input.generationId &&
    call.members.some(
      (member) => member.packageId === input.packageId && member.artifact,
    )
  );
}

export function activeIsolateTurn(
  state: ShellBotStateV1,
  input: IsolateCallIdentityV1,
): ActiveTurnV1 | undefined {
  const active = state.turn.current;
  if (
    !active ||
    active.runId !== input.runId ||
    active.sessionId !== input.sessionId ||
    active.turnId !== input.turnId ||
    active.generationId !== input.generationId ||
    // Every capability call names the Plugin it is for, from the scope the
    // wrapper put on it; the gate is that this generation mounted that Plugin.
    !active.mounted.generation.members.some(
      (member) => member.packageId === input.packageId && member.artifact,
    )
  ) {
    return undefined;
  }
  return active;
}
