import { describe, expect, test } from "bun:test";
import {
  clientSurfaceRegistryKey,
  type ClientPluginContext,
} from "@frockbot/client-core";
import { createClientSurfaceRegistry } from "@frockbot/client-ui";
import { adminClientPlugin } from "./index.js";

describe("admin client contribution", () => {
  test("registers and disposes the Admin overlay", () => {
    const surfaces = createClientSurfaceRegistry();
    const context: ClientPluginContext = {
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        hostedRequest: () => Promise.resolve({}),
      },
      inject: (key) => {
        if (key !== clientSurfaceRegistryKey) {
          throw new Error("unexpected client provider");
        }
        return surfaces as never;
      },
      provide: () => () => {},
      slot: () => () => {},
    };

    const result = adminClientPlugin(context);
    if (!Array.isArray(result)) throw new Error("expected owned registrations");
    expect(surfaces.has("admin")).toBe(true);

    for (const dispose of result.toReversed()) dispose();
    expect(surfaces.has("admin")).toBe(false);
  });
});
