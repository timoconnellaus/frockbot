import {
  ComputerError,
  type ComputerAssignment,
  type ComputerHandle,
  type ComputerOperationOptions,
  type ComputerProvider,
  type ComputerTarget,
} from "@frockbot/computer-core";
import type {
  ComputerHostEffectRequestV1,
  ComputerHostEffectResponseV1,
} from "@frockbot/computer-core/host-protocol";
import type { Plugin } from "cordis";

export const SHARED_COMPUTER_PROVIDER_ID = "shared-computer";

export interface SharedComputerHostClient {
  effect(
    request: ComputerHostEffectRequestV1,
    options?: ComputerOperationOptions,
  ): Promise<ComputerHostEffectResponseV1>;
}

function effectId(options: ComputerOperationOptions | undefined): string {
  const value = options?.effectId?.trim();
  if (!value) {
    throw new ComputerError(
      "invalid-request",
      "Computer effect identity is required",
    );
  }
  return value;
}

function completed(
  response: ComputerHostEffectResponseV1,
): Extract<ComputerHostEffectResponseV1, { status: "completed" }> {
  if (response.status === "completed") return response;
  throw new ComputerError(
    response.status === "rejected" ? "provider-failure" : "conflict",
    response.failure,
    response.status === "unresolved",
  );
}

class SharedComputerProvider implements ComputerProvider {
  readonly id = SHARED_COMPUTER_PROVIDER_ID;

  constructor(private readonly host: SharedComputerHostClient) {}

  open(
    target: ComputerTarget,
    assignment: ComputerAssignment,
  ): Promise<ComputerHandle> {
    return Promise.resolve({
      assignment,
      exec: {
        execute: async (request, options) => {
          const response = completed(
            await this.host.effect(
              {
                schemaVersion: 1,
                effectId: effectId(options),
                target,
                assignment,
                operation: { type: "exec", request },
              },
              options,
            ),
          );
          if (response.result.type !== "exec") {
            throw new ComputerError(
              "provider-failure",
              "Computer host returned the wrong effect result",
            );
          }
          return response.result.result;
        },
      },
      browser: {
        perform: async (action, options) => {
          const response = completed(
            await this.host.effect(
              {
                schemaVersion: 1,
                effectId: effectId(options),
                target,
                assignment,
                operation: { type: "browser", action },
              },
              options,
            ),
          );
          if (response.result.type !== "browser") {
            throw new ComputerError(
              "provider-failure",
              "Computer host returned the wrong effect result",
            );
          }
          return response.result.result;
        },
      },
      close: () => Promise.resolve(),
    });
  }
}

export function createSharedComputerProviderPlugin(
  host: SharedComputerHostClient,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.computers.register(new SharedComputerProvider(host));
  plugin.inject = ["computers"];
  return plugin;
}
