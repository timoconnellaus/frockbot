import { describe, expect, test } from "bun:test";
import { createAdminBackendContribution } from "./backend.js";
import {
  DeploymentPolicyConflictError,
  type DeploymentPolicyV1,
} from "./shared.js";

function initialPolicy(): DeploymentPolicyV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    signups: { open: false },
    updatedAt: "2026-09-01T00:00:00.000Z",
    updatedBy: "deployment-default",
  };
}

describe("admin gateway contribution", () => {
  test("refuses non-admins before reading deployment policy", async () => {
    let reads = 0;
    const contribution = createAdminBackendContribution({
      readDeploymentPolicy: () => {
        reads += 1;
        return Promise.resolve(initialPolicy());
      },
      setDeploymentSignups: () => Promise.resolve(initialPolicy()),
    });

    const response = await contribution.route(
      new Request("https://frockbot.test/api/admin/policy"),
      new URL("https://frockbot.test/api/admin/policy"),
      { userId: "ordinary-user", client: "browser", isAdmin: false },
    );

    expect(response?.status).toBe(403);
    expect(reads).toBe(0);
  });

  test("reads and updates the policy with an optimistic revision", async () => {
    let policy = initialPolicy();
    const contribution = createAdminBackendContribution({
      readDeploymentPolicy: () => Promise.resolve(policy),
      setDeploymentSignups: (command, updatedBy) => {
        if (command.revision !== policy.revision) {
          throw new DeploymentPolicyConflictError(policy.revision);
        }
        policy = {
          schemaVersion: 1,
          revision: policy.revision + 1,
          signups: { open: command.open },
          updatedAt: "2026-09-01T01:00:00.000Z",
          updatedBy,
        };
        return Promise.resolve(policy);
      },
    });
    const context = {
      userId: "owner-id",
      client: "browser" as const,
      isAdmin: true,
    };

    const read = await contribution.route(
      new Request("https://frockbot.test/api/admin/policy"),
      new URL("https://frockbot.test/api/admin/policy"),
      context,
    );
    expect(await read?.json()).toEqual(initialPolicy());

    const update = await contribution.route(
      new Request("https://frockbot.test/api/admin/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "deployment/set-signups",
          open: true,
          revision: 0,
        }),
      }),
      new URL("https://frockbot.test/api/admin/policy"),
      context,
    );
    expect(update?.status).toBe(200);
    expect(await update?.json()).toMatchObject({
      revision: 1,
      signups: { open: true },
      updatedBy: "owner-id",
    });

    const conflict = await contribution.route(
      new Request("https://frockbot.test/api/admin/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "deployment/set-signups",
          open: false,
          revision: 0,
        }),
      }),
      new URL("https://frockbot.test/api/admin/policy"),
      context,
    );
    expect(conflict?.status).toBe(409);
    expect(await conflict?.json()).toMatchObject({
      code: "revision-conflict",
      currentRevision: 1,
    });
  });
});
