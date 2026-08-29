import { projectDurableRuns } from "@frockbot/plugin-shell/client";
import type { ClientRunLookup } from "@frockbot/plugin-shell/run-protocol";
import type { MobileBotProjectionState } from "./bot-projection.ts";
import type { TurnResponse } from "./transport.ts";

export type MobileTurnAdmission =
  | {
      status: "confirmed";
      commandId: string;
      response: TurnResponse;
    }
  | {
      status: "not-started";
      commandId: string;
      error?: unknown;
    }
  | {
      status: "uncertain";
      commandId: string;
      error: unknown;
    };

export interface MobileTurnAdmissionOptions {
  commandId: string;
  prepare(): Promise<void>;
  isCurrent(): boolean;
  request(): Promise<TurnResponse>;
}

export async function admitMobileTurn(
  options: MobileTurnAdmissionOptions,
): Promise<MobileTurnAdmission> {
  try {
    await options.prepare();
  } catch (error) {
    return { status: "not-started", commandId: options.commandId, error };
  }
  if (!options.isCurrent()) {
    return { status: "not-started", commandId: options.commandId };
  }

  try {
    return {
      status: "confirmed",
      commandId: options.commandId,
      response: await options.request(),
    };
  } catch (error) {
    return {
      status: "uncertain",
      commandId: options.commandId,
      error,
    };
  }
}

export interface MobileTurnAdmissionReconciliationOptions {
  lookup(): Promise<ClientRunLookup>;
  fence(): Promise<ClientRunLookup>;
  observe(lookup: ClientRunLookup): void;
  transientFailure(error: unknown): void;
  wait(delayMs: number): Promise<void>;
  isCurrent(): boolean;
  initialDelayMs?: number;
  maximumDelayMs?: number;
}

export async function reconcileMobileTurnAdmission(
  options: MobileTurnAdmissionReconciliationOptions,
): Promise<ClientRunLookup | undefined> {
  const initialDelay = options.initialDelayMs ?? 250;
  const maximumDelay = options.maximumDelayMs ?? 5_000;
  let delay = initialDelay;
  while (options.isCurrent()) {
    try {
      const observed = await options.lookup();
      if (!options.isCurrent()) return undefined;
      const lookup =
        observed.state === "not-admitted" ? await options.fence() : observed;
      if (!options.isCurrent()) return undefined;
      options.observe(lookup);
      if (lookup.state === "not-admitted" || lookup.state === "terminal") {
        return lookup;
      }
    } catch (error) {
      if (!options.isCurrent()) return undefined;
      options.transientFailure(error);
    }
    let remainingDelay = delay;
    while (options.isCurrent() && remainingDelay > 0) {
      const slice = Math.min(remainingDelay, 100);
      await options.wait(slice);
      remainingDelay -= slice;
    }
    delay = Math.min(delay * 2, maximumDelay);
  }
  return undefined;
}

export function projectMobileTurnAdmissionLookup(
  state: MobileBotProjectionState,
  commandId: string,
  lookup: ClientRunLookup,
): void {
  if (lookup.state === "not-admitted") {
    state.messages = state.messages.filter(
      (message) => message.runId !== commandId,
    );
    if (state.activeRunId === commandId) state.activeRunId = undefined;
    if (state.activeRun?.runId === commandId) state.activeRun = undefined;
    return;
  }
  projectDurableRuns(state, [], [lookup.run]);
}
