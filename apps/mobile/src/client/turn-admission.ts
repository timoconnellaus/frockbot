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
      reconciliation: Promise<TurnResponse>;
    };

export interface MobileTurnAdmissionOptions {
  commandId: string;
  prepare(): Promise<void>;
  isCurrent(): boolean;
  request(): Promise<TurnResponse>;
  reconcile(): Promise<TurnResponse>;
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
      reconciliation: options.reconcile(),
    };
  }
}
