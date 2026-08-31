import { describe, expect, test } from "bun:test";
import { ComputerRegistry } from "@frockbot/computer-core";
import { Context } from "cordis";
import {
  createSharedComputerProviderPlugin,
  SHARED_COMPUTER_PROVIDER_ID,
} from "./shared-provider.js";

describe("shared Computer provider", () => {
  test("forwards stable effect identity through the provider-neutral host", async () => {
    const requests: unknown[] = [];
    const root = new Context();
    await root.plugin(ComputerRegistry);
    await root.plugin(
      createSharedComputerProviderPlugin({
        effect: (request) => {
          requests.push(request);
          return Promise.resolve({
            schemaVersion: 1,
            effectId: request.effectId,
            status: "completed",
            result: {
              type: "exec",
              result: {
                exitCode: 0,
                stdout: Uint8Array.from([111, 107]),
                stderr: new Uint8Array(),
                outputTruncated: false,
              },
            },
          });
        },
      }),
    );
    const identity = { userId: "user-1" };
    const tenant = { botId: "bot-1" };
    root.computers.assign(identity, SHARED_COMPUTER_PROVIDER_ID);
    const computer = await root.computers.open(identity, tenant);
    const result = await computer.exec?.execute(
      { executable: "/bin/true" },
      { effectId: "tool:1:1:0" },
    );

    expect(result?.stdout).toEqual(Uint8Array.from([111, 107]));
    expect(requests).toMatchObject([
      {
        schemaVersion: 1,
        effectId: "tool:1:1:0",
        identity,
        tenant,
        operation: { type: "exec", request: { executable: "/bin/true" } },
      },
    ]);
    await root.fiber.dispose();
  });
});
