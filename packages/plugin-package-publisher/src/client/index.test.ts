import { describe, expect, test } from "bun:test";
import {
  clientSurfaceRegistryKey,
  type ClientPluginContext,
  type ClientSlotRegistration,
} from "@frockbot/client-core";
import { createClientSurfaceRegistry } from "@frockbot/client-ui";
import { packagePublisherClientPlugin } from "./index.js";
import { packagePublisherStateKey } from "./state.js";

const history = {
  schemaVersion: 1 as const,
  revision: 2,
  activePackageRevision: 2,
  revisions: [
    {
      packageRevision: 1,
      applicationHash: "sha256:one",
      publishedAt: "2026-09-01T00:00:00.000Z",
      checks: [{ name: "test", status: "passed" as const }],
    },
    {
      packageRevision: 2,
      applicationHash: "sha256:two",
      publishedAt: "2026-09-02T00:00:00.000Z",
      checks: [{ name: "test", status: "passed" as const }],
    },
  ],
};

describe("Package Publisher client contribution", () => {
  test("registers revision UI and rolls back through the hosted protocol", async () => {
    const surfaces = createClientSurfaceRegistry();
    const slots: ClientSlotRegistration[] = [];
    const calls: Array<[string, string | undefined, string | undefined]> = [];
    let state: unknown;
    const context: ClientPluginContext = {
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        hostedRequest: (path, method, body) => {
          calls.push([path, method, body]);
          if (path.endsWith("/rollback")) {
            return Promise.resolve({
              schemaVersion: 1,
              commandId: JSON.parse(body ?? "{}").commandId,
              status: "active",
              revision: 3,
              packageRevision: 1,
              applicationHash: "sha256:one",
            });
          }
          return Promise.resolve(history);
        },
      },
      inject: (key) => {
        if (key !== clientSurfaceRegistryKey) {
          throw new Error("unexpected client provider");
        }
        return surfaces as never;
      },
      provide: (key, value) => {
        if (key === packagePublisherStateKey) state = value;
        return () => {};
      },
      slot: (registration) => {
        slots.push(registration);
        return () => slots.splice(slots.indexOf(registration), 1);
      },
    };

    const disposers = packagePublisherClientPlugin(context);
    if (!Array.isArray(disposers)) throw new Error("expected registrations");
    expect(surfaces.has("package-publisher")).toBe(true);
    expect(slots.map((slot) => slot.slot)).toEqual([
      "frockbot.user-settings-sections",
    ]);

    const publisher = state as {
      value: {
        load(): Promise<void>;
        rollback(revision: number): Promise<void>;
      };
    };
    await publisher.value.load();
    await publisher.value.rollback(1);
    expect(calls.map(([path]) => path)).toEqual([
      "/api/package-revisions",
      "/api/package-revisions/rollback",
      "/api/package-revisions",
    ]);
    expect(JSON.parse(calls[1]![2] ?? "{}")).toMatchObject({
      expectedRevision: 2,
      packageRevision: 1,
    });

    for (const dispose of disposers.toReversed()) dispose();
    expect(surfaces.has("package-publisher")).toBe(false);
  });
});
