import { describe, expect, it } from "bun:test";
import {
  clientSurfaceRegistryKey,
  type ClientPluginContext,
  type ClientSlotRegistration,
} from "@frockbot/client-core";
import { createClientSurfaceRegistry } from "@frockbot/client-ui";
import { settingsClientPlugin } from "./index.js";
import {
  assignmentHasPendingOperation,
  projectAssignmentOperations,
} from "./assignment-operations.js";

describe("settings client contribution", () => {
  it("projects every Assignment operation without catalog ownership", () => {
    const operations = [
      {
        commandId: "assign-1",
        kind: "assigning" as const,
        assignmentId: "orphan-assign",
        state: "retrying" as const,
        target: {
          assignmentId: "orphan-assign",
          packageId: "missing-package",
          capabilityId: "missing-capability",
        },
      },
      {
        commandId: "replace-1",
        kind: "replacing" as const,
        assignmentId: "orphan-replace",
        state: "pending" as const,
      },
      {
        commandId: "unassign-1",
        kind: "unassigning" as const,
        assignmentId: "orphan-unassign",
        state: "retrying" as const,
      },
    ];
    const projected = projectAssignmentOperations({
      assignmentOperations: operations,
    });
    expect(projected).toEqual(operations);
    expect(projected).not.toBe(operations);
    expect(assignmentHasPendingOperation(projected, "orphan-unassign")).toBe(
      true,
    );
    expect(assignmentHasPendingOperation(projected, "stable")).toBe(false);
  });

  it("registers feature surfaces and shell-owned trigger seats", () => {
    const surfaces = createClientSurfaceRegistry();
    const slots: ClientSlotRegistration[] = [];
    const provided: unknown[] = [];
    const context: ClientPluginContext = {
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      },
      inject: (key) => {
        if (key !== clientSurfaceRegistryKey) {
          throw new Error("unexpected client provider");
        }
        return surfaces as never;
      },
      provide: (key) => {
        provided.push(key);
        return () => {};
      },
      slot: (registration) => {
        slots.push(registration);
        return () => slots.splice(slots.indexOf(registration), 1);
      },
    };

    const result = settingsClientPlugin(context);
    if (!Array.isArray(result)) throw new Error("expected owned registrations");

    expect(slots.map((slot) => slot.slot)).toEqual([
      "frockbot.sidebar-actions",
      "frockbot.user-profile",
      "frockbot.right-panel",
      "frockbot.bot-actions",
    ]);
    // Composition is an internal detail the Settings Package no longer shows,
    // so it provides no client state of its own.
    expect(provided).toEqual([]);
    for (const id of ["bot-settings", "plugins", "user-settings"]) {
      expect(surfaces.has(id)).toBe(true);
    }

    for (const dispose of result.toReversed()) dispose();
    expect(slots).toEqual([]);
    expect(surfaces.active.value).toBeUndefined();
    for (const id of ["bot-settings", "plugins", "user-settings"]) {
      expect(surfaces.has(id)).toBe(false);
    }
  });
});
