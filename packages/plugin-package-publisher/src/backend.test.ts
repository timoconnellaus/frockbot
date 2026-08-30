import { describe, expect, test } from "bun:test";
import {
  createPackagePublisherBackendContribution,
  type PackagePublisherGatewayHost,
} from "./backend.js";
import type {
  PackagePublicationReceiptV1,
  PackageRevisionHistoryV1,
} from "./shared.js";

const history: PackageRevisionHistoryV1 = {
  schemaVersion: 1,
  revision: 2,
  activePackageRevision: 2,
  revisions: [
    {
      packageRevision: 1,
      applicationHash: "sha256:one",
      publishedAt: "2026-09-01T00:00:00.000Z",
      checks: [{ name: "test", status: "passed" }],
    },
    {
      packageRevision: 2,
      applicationHash: "sha256:two",
      publishedAt: "2026-09-02T00:00:00.000Z",
      checks: [{ name: "test", status: "passed" }],
    },
  ],
};

function receipt(commandId: string): PackagePublicationReceiptV1 {
  return {
    schemaVersion: 1,
    commandId,
    status: "active",
    revision: 3,
    packageRevision: 1,
    applicationHash: "sha256:one",
  };
}

describe("Package Publisher gateway contribution", () => {
  test("exposes authenticated history and rollback without direct publication", async () => {
    const calls: unknown[] = [];
    const host: PackagePublisherGatewayHost = {
      read: (userId) => {
        calls.push(["read", userId]);
        return Promise.resolve(history);
      },
      rollback: (userId, command) => {
        calls.push(["rollback", userId, command]);
        return Promise.resolve(receipt(command.commandId));
      },
    };
    const contribution = createPackagePublisherBackendContribution(host);
    const context = { userId: "user-1", client: "browser" as const };

    const listed = await contribution.route(
      new Request("https://bot.test/api/package-revisions"),
      new URL("https://bot.test/api/package-revisions"),
      context,
    );
    const published = await contribution.route(
      new Request("https://bot.test/api/package-revisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "publish-1",
          expectedRevision: 2,
          candidate: {
            source: "source",
            applicationArtifact: "artifact",
            checks: [{ name: "test", status: "passed" }],
          },
        }),
      }),
      new URL("https://bot.test/api/package-revisions"),
      context,
    );
    const rolledBack = await contribution.route(
      new Request("https://bot.test/api/package-revisions/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "rollback-1",
          expectedRevision: 2,
          packageRevision: 1,
        }),
      }),
      new URL("https://bot.test/api/package-revisions/rollback"),
      context,
    );

    expect(await listed?.json()).toEqual(history);
    expect(published?.status).toBe(405);
    expect(await rolledBack?.json()).toEqual(receipt("rollback-1"));
    expect(calls.map((call) => (call as unknown[])[0])).toEqual([
      "read",
      "rollback",
    ]);
  });

  test("rejects unauthenticated and malformed publication requests", async () => {
    const unexpected = () => Promise.reject(new Error("unexpected host call"));
    const contribution = createPackagePublisherBackendContribution({
      read: unexpected,
      rollback: unexpected,
    });
    const url = new URL("https://bot.test/api/package-revisions");

    expect(
      await contribution.route(new Request(url), url, {
        client: "browser",
      }),
    ).toBeUndefined();
    const response = await contribution.route(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1 }),
      }),
      url,
      { userId: "user-1", client: "browser" },
    );
    expect(response?.status).toBe(405);
  });
});
