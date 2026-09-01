// What one machine command becomes on the laptop.
//
// This is the half of the device agent the plan calls "everything but actual
// `child_process` execution": it turns a `MachineOpV1` into calls on the
// desktop host seam and turns what came back into a `MachineCommandResultV1`.
// Every classification decision lives here — which outcome a killed process
// gets, what `truncated` means for a file read, what a machine without the
// capability an op needs answers — so all of it runs in `bun test` against a
// fake host, and the Electron file it is wired to holds no policy at all.
//
// One refusal is stated rather than hidden. `copy-from-computer` names a
// Workspace path, and machine protocol v1 carries no Workspace bytes: the
// command DTO has `path` and `workspacePath` and nothing else, and there is no
// route on which an agent could fetch the file. So the agent refuses it
// visibly, in the vocabulary the audit classifier already reads, instead of
// inventing a transfer the protocol does not have. Widening the protocol is a
// version bump and belongs with whoever adds the route.

import type {
  DesktopMachineExecResult,
  DesktopMachineFileResult,
  DesktopMachineExecRequest,
  DesktopMachineFileRequest,
  DesktopMachineIdentity,
} from "@frockbot/desktop-core";
import {
  MACHINE_LIMITS_V1,
  type MachineCapabilityV1,
  type MachineCommandV1,
  type MachineMessagesCallV1,
  machineOpCapabilityV1,
} from "@frockbot/machine-protocol";
import type {
  MachineCommandReportV1,
  MachineCommandRunnerV1,
} from "./device.js";

/**
 * The desktop host, structurally.
 *
 * `DesktopMachineHostCapability` satisfies this, and so does a plain object in
 * a test. The runner never needs the cordis `Service` half of the capability,
 * so it does not ask for it.
 */
export interface MachineDeviceHostV1 {
  identity(): DesktopMachineIdentity;
  exec(
    request: DesktopMachineExecRequest,
    signal: AbortSignal,
  ): Promise<DesktopMachineExecResult>;
  readFile(
    request: DesktopMachineFileRequest,
    signal: AbortSignal,
  ): Promise<DesktopMachineFileResult>;
}

/**
 * What runs one Messages.app call on this laptop (register row 57g).
 *
 * A seam rather than a branch, and typed in the protocol's own vocabulary, so
 * this Package never learns what `chat.db` is: the Messages Package builds the
 * handler, the Electron shell hands it in, and an agent given no handler
 * reports no `messages` capability and refuses the op if one arrives anyway.
 */
export type MachineMessagesOpRunnerV1 = (
  call: MachineMessagesCallV1,
  signal: AbortSignal,
) => Promise<MachineCommandReportV1>;

export interface MachineDeviceRunnerOptionsV1 {
  host: MachineDeviceHostV1;
  /** What this agent told the backend it can do. An op outside it is refused. */
  capabilities: readonly MachineCapabilityV1[];
  /** Present only on a macOS agent whose shell wired the Messages handlers. */
  messages?: MachineMessagesOpRunnerV1;
  now?(): number;
}

/**
 * The refusal wording, once.
 *
 * It begins "Refused:" because `plugin-audit`'s `outcomeFor` classifies on
 * that prefix: a refusal that reads as an error would show up in the audit as
 * a failure of the machine rather than a decision by it.
 */
export function machineRefusalV1(reason: string): string {
  return `Refused: ${reason}`;
}

const CAPABILITY_REASON: Record<MachineCapabilityV1, string> = {
  exec: "this machine's agent does not offer shell execution",
  files: "this machine's agent does not offer file access",
  messages: "this machine's agent does not offer Messages access",
};

/**
 * The runner the desktop contribution hands to `MachineDeviceAgentV1`.
 *
 * It never throws: the agent wraps it anyway, but a runner that answers
 * instead of throwing is the difference between a Bot reading "the file was
 * not there" and a Bot reading a stack trace.
 */
export function createMachineDeviceRunnerV1(
  options: MachineDeviceRunnerOptionsV1,
): MachineCommandRunnerV1 {
  const now = (): string =>
    new Date(options.now?.() ?? Date.now()).toISOString();

  const refuse = (reason: string): MachineCommandReportV1 => ({
    finishedAt: now(),
    outcome: "refused",
    truncated: false,
    message: machineRefusalV1(reason),
  });

  const failed = (error: unknown): MachineCommandReportV1 => ({
    finishedAt: now(),
    outcome: "error",
    truncated: false,
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      MACHINE_LIMITS_V1.message,
    ),
  });

  return {
    async run(
      command: MachineCommandV1,
      signal: AbortSignal,
    ): Promise<MachineCommandReportV1> {
      const op = command.op;
      const needed = machineOpCapabilityV1(op);
      // The backend refuses a tool call against a machine that never reported
      // the capability; this is the same check on the other side of the wire,
      // because a record can go stale between enrollment and dispatch.
      if (!options.capabilities.includes(needed)) {
        return refuse(CAPABILITY_REASON[needed]);
      }
      try {
        if (op.kind === "exec") {
          const result = await options.host.exec(
            {
              command: op.command,
              ...(op.cwd === undefined ? {} : { cwd: op.cwd }),
              timeoutMs: op.timeoutMs,
              maxOutputBytes: op.maxOutputBytes,
            },
            signal,
          );
          return {
            finishedAt: now(),
            // A killed command is `timeout`, not `error`: the Bot's next move
            // differs — raise the timeout, or stop asking — and the audit
            // vocabulary distinguishes them for the same reason.
            outcome: result.timedOut
              ? "timeout"
              : result.exitCode === 0
                ? "ok"
                : "error",
            truncated: result.truncated,
            ...(result.exitCode === undefined
              ? {}
              : { exitCode: result.exitCode }),
            stdout: result.stdout,
            stderr: result.stderr,
            ...(result.timedOut
              ? {
                  message: `the command was killed after ${op.timeoutMs}ms`,
                }
              : {}),
          };
        }
        if (op.kind === "messages") {
          // The capability check above already refused a machine that never
          // reported `messages`; this is the second half of the same fact —
          // an agent that reported it and was wired no handler must say so
          // rather than answer an empty result that reads like an empty inbox.
          if (!options.messages) {
            return refuse(CAPABILITY_REASON.messages);
          }
          return await options.messages(op.call, signal);
        }
        if (op.kind === "read" || op.kind === "copy-to-computer") {
          const maxBytes =
            op.kind === "read" ? op.maxBytes : MACHINE_LIMITS_V1.readBytes;
          const file = await options.host.readFile(
            { path: op.path, maxBytes },
            signal,
          );
          return {
            finishedAt: now(),
            outcome: "ok",
            truncated: file.truncated,
            bytesBase64: file.bytesBase64,
          };
        }
        return refuse(
          "machine protocol v1 carries no Workspace bytes, so a copy onto the machine cannot be performed by the agent",
        );
      } catch (error) {
        return failed(error);
      }
    },
  };
}
