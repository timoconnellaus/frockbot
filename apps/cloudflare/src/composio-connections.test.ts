import { describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import { ComposioClient } from "@frockbot/plugin-composio/client";
import {
  ComposioConnectionCoordinator,
  type ComposioConnectionStore,
} from "@frockbot/plugin-composio";
import type { StartConnectionInput } from "./user-configuration.js";

class MemoryConnectionStore implements ComposioConnectionStore {
  readonly log: string[] = [];
  readonly connections = new Map<string, ConnectionView>();

  isPackageInstalled(_userId: string, packageId: string): Promise<boolean> {
    return Promise.resolve(packageId === "composio");
  }

  getConnection(
    _userId: string,
    connectionId: string,
  ): Promise<ConnectionView | undefined> {
    return Promise.resolve(this.connections.get(connectionId));
  }

  startConnection(
    _userId: string,
    input: StartConnectionInput,
  ): Promise<boolean> {
    if (this.connections.has(input.connectionId)) return Promise.resolve(false);
    this.log.push("intent");
    this.connections.set(input.connectionId, {
      ...input,
      state: "authorizing",
      safeMetadata: input.safeMetadata ?? {},
    });
    return Promise.resolve(true);
  }

  recordConnectLinkResult(
    _userId: string,
    connectionId: string,
    safeMetadata: ConnectionView["safeMetadata"],
  ): Promise<boolean> {
    this.updateConnection(_userId, connectionId, {
      state: "authorizing",
      safeMetadata,
    });
    return Promise.resolve(true);
  }

  finishConnectionAuthorization(
    _userId: string,
    connectionId: string,
    update: {
      state: "ready" | "failed";
      safeMetadata?: ConnectionView["safeMetadata"];
      failure?: string;
    },
  ): Promise<boolean> {
    const current = this.connections.get(connectionId);
    if (!current || current.state !== "authorizing")
      return Promise.resolve(false);
    this.updateConnection(_userId, connectionId, update);
    return Promise.resolve(true);
  }

  consumeAuthorizationState(
    _userId: string,
    connectionId: string,
    authorizationStateId: string,
  ): Promise<"claimed" | "duplicate" | "invalid"> {
    const current = this.connections.get(connectionId);
    if (
      !current ||
      (current.safeMetadata.authorizationStateId !== undefined &&
        current.safeMetadata.authorizationStateId !== authorizationStateId)
    ) {
      return Promise.resolve("invalid");
    }
    if (current.safeMetadata.authorizationStateConsumed === true) {
      return Promise.resolve("duplicate");
    }
    this.connections.set(connectionId, {
      ...current,
      safeMetadata: {
        ...current.safeMetadata,
        authorizationStateConsumed: true,
      },
    });
    return Promise.resolve("claimed");
  }

  claimConnectionAssignment(
    _userId: string,
    connectionId: string,
    leaseId: string,
    verifiedMetadata?: ConnectionView["safeMetadata"],
  ): Promise<{
    phase: "acquired" | "pending" | "done";
    connection: ConnectionView;
  }> {
    const current = this.connections.get(connectionId);
    if (!current) throw new Error("missing connection");
    if (current.state === "ready") {
      return Promise.resolve({ phase: "done", connection: current });
    }
    if (
      current.state === "reconciliation-required" &&
      current.safeMetadata.reconciliationOperation === "assignment" &&
      typeof current.safeMetadata.assignmentLeaseExpiresAt === "number" &&
      current.safeMetadata.assignmentLeaseExpiresAt > Date.now()
    ) {
      return Promise.resolve({ phase: "pending", connection: current });
    }
    if (
      current.state !== "authorizing" &&
      !(
        current.state === "reconciliation-required" &&
        (current.safeMetadata.reconciliationOperation === "link" ||
          current.safeMetadata.reconciliationOperation === "assignment")
      )
    ) {
      return Promise.resolve({ phase: "pending", connection: current });
    }
    const claimed: ConnectionView = {
      ...current,
      state: "reconciliation-required",
      safeMetadata: {
        ...(verifiedMetadata ?? current.safeMetadata),
        reconciliationOperation: "assignment",
        assignmentLeaseId: leaseId,
        assignmentLeaseExpiresAt: Date.now() + 60_000,
      },
    };
    this.connections.set(connectionId, claimed);
    return Promise.resolve({ phase: "acquired", connection: claimed });
  }

  finishConnectionAssignment(
    _userId: string,
    connectionId: string,
    leaseId: string,
  ): Promise<boolean> {
    const current = this.connections.get(connectionId);
    if (
      !current ||
      current.state !== "reconciliation-required" ||
      current.safeMetadata.reconciliationOperation !== "assignment" ||
      current.safeMetadata.assignmentLeaseId !== leaseId ||
      typeof current.safeMetadata.assignmentLeaseExpiresAt !== "number" ||
      current.safeMetadata.assignmentLeaseExpiresAt <= Date.now()
    ) {
      return Promise.resolve(false);
    }
    const {
      reconciliationOperation: _,
      assignmentLeaseId: __,
      assignmentLeaseExpiresAt: ___,
      ...safeMetadata
    } = current.safeMetadata;
    this.updateConnection(_userId, connectionId, {
      state: "ready",
      safeMetadata: { ...safeMetadata, assignmentGeneration: leaseId },
    });
    return Promise.resolve(true);
  }

  requireAssignmentCompensation(
    _userId: string,
    connectionId: string,
    leaseId: string,
  ): Promise<boolean> {
    const current = this.connections.get(connectionId);
    if (
      !current ||
      current.state === "ready" ||
      current.safeMetadata.assignmentLeaseId !== leaseId
    ) {
      return Promise.resolve(false);
    }
    this.connections.set(connectionId, {
      ...current,
      safeMetadata: {
        ...current.safeMetadata,
        assignmentCompensationPending: true,
        assignmentCompensationId: leaseId,
        assignmentCompensationGeneration: leaseId,
      },
    });
    return Promise.resolve(true);
  }

  recordAssignmentCompensated(
    _userId: string,
    connectionId: string,
    compensationId: string,
  ): Promise<boolean> {
    const current = this.connections.get(connectionId);
    if (
      current &&
      Array.isArray(current.safeMetadata.assignmentCompensations)
    ) {
      const remaining = current.safeMetadata.assignmentCompensations.filter(
        (candidate) =>
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate) ||
          (candidate as Record<string, unknown>).id !== compensationId,
      );
      if (
        remaining.length === current.safeMetadata.assignmentCompensations.length
      ) {
        return Promise.resolve(false);
      }
      this.connections.set(connectionId, {
        ...current,
        safeMetadata: {
          ...current.safeMetadata,
          assignmentCompensations: remaining,
        },
      });
      return Promise.resolve(true);
    }
    if (
      !current ||
      current.safeMetadata.assignmentCompensationId !== compensationId
    ) {
      return Promise.resolve(false);
    }
    const {
      assignmentCompensationPending: _,
      assignmentCompensationId: __,
      assignmentCompensationGeneration: ___,
      ...safeMetadata
    } = current.safeMetadata;
    this.connections.set(connectionId, { ...current, safeMetadata });
    return Promise.resolve(true);
  }

  recordConnectionDependency(): Promise<boolean> {
    return Promise.resolve(true);
  }

  requireConnectionReconciliation(
    _userId: string,
    connectionId: string,
    operation: "link" | "revoke",
    failure: string,
  ): Promise<boolean> {
    const current = this.connections.get(connectionId);
    if (!current) return Promise.resolve(false);
    this.updateConnection(_userId, connectionId, {
      state: "reconciliation-required",
      safeMetadata: {
        ...current.safeMetadata,
        reconciliationOperation: operation,
      },
      failure,
    });
    return Promise.resolve(true);
  }

  claimConnectionRevocation(
    _userId: string,
    connectionId: string,
  ): Promise<{
    phase: "provider" | "finalize" | "pending" | "done";
    connection: ConnectionView;
  }> {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error("missing connection");
    if (connection.state === "revoked") {
      return Promise.resolve({ phase: "done", connection });
    }
    if (
      connection.state === "reconciliation-required" &&
      connection.safeMetadata.reconciliationOperation === "assignment" &&
      typeof connection.safeMetadata.assignmentLeaseExpiresAt === "number" &&
      connection.safeMetadata.assignmentLeaseExpiresAt > Date.now()
    ) {
      return Promise.resolve({ phase: "pending", connection });
    }
    if (
      connection.state === "revoking" ||
      (connection.state === "reconciliation-required" &&
        connection.safeMetadata.reconciliationOperation === "revoke")
    ) {
      return Promise.resolve({
        phase:
          connection.safeMetadata.revocationProviderCompleted === true
            ? "finalize"
            : "pending",
        connection,
      });
    }
    const claimed: ConnectionView = {
      ...connection,
      state: "revoking",
      safeMetadata: {
        ...connection.safeMetadata,
        reconciliationOperation: "revoke",
        revocationProviderCompleted: false,
        ...(typeof connection.safeMetadata.targetBotId === "string"
          ? {
              assignmentCompensationPending: true,
              assignmentCompensationId: `revoke:${connectionId}`,
              assignmentCompensationGeneration:
                typeof connection.safeMetadata.assignmentGeneration === "string"
                  ? connection.safeMetadata.assignmentGeneration
                  : "legacy:any",
            }
          : {}),
      },
    };
    this.connections.set(connectionId, claimed);
    this.log.push("revoking");
    return Promise.resolve({ phase: "provider", connection: claimed });
  }

  recordRevocationProviderCompleted(
    _userId: string,
    connectionId: string,
  ): Promise<boolean> {
    const current = this.connections.get(connectionId);
    if (!current) return Promise.resolve(false);
    this.connections.set(connectionId, {
      ...current,
      safeMetadata: {
        ...current.safeMetadata,
        revocationProviderCompleted: true,
      },
    });
    return Promise.resolve(true);
  }

  finishConnectionRevocation(
    _userId: string,
    connectionId: string,
  ): Promise<boolean> {
    this.updateConnection(_userId, connectionId, { state: "revoked" });
    return Promise.resolve(true);
  }

  updateConnection(
    _userId: string,
    connectionId: string,
    update: {
      state: ConnectionView["state"];
      safeMetadata?: ConnectionView["safeMetadata"];
      failure?: string;
    },
  ): Promise<void> {
    const current = this.connections.get(connectionId);
    if (!current) throw new Error("missing connection");
    this.log.push(update.state);
    this.connections.set(connectionId, {
      ...current,
      ...update,
      safeMetadata: update.safeMetadata ?? current.safeMetadata,
    });
    return Promise.resolve();
  }
}

describe("ComposioConnectionCoordinator", () => {
  test("records durable intent before creating a hosted Connect Link", async () => {
    const store = new MemoryConnectionStore();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: () => {
        store.log.push("external-link");
        return Promise.resolve(
          Response.json(
            {
              connected_account_id: "ca_123",
              redirect_url: "https://connect.composio.dev/link/test",
              expires_at: expiresAt,
            },
            { status: 201 },
          ),
        );
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {
        gmail: {
          authConfigId: "ac_gmail",
          displayName: "Gmail",
          toolkitSlug: "gmail",
        },
      },
    });

    const result = await coordinator.start("user-1", {
      commandId: "connection-1",
      connectionTypeId: "gmail",
      botId: "primary",
    });

    expect(store.log).toEqual(["intent", "external-link", "authorizing"]);
    expect(result.connectionId).toBe("connection-1");
    expect(store.connections.get("connection-1")).toMatchObject({
      state: "authorizing",
      safeMetadata: {
        connectedAccountId: "ca_123",
        toolkitSlug: "gmail",
        targetBotId: "primary",
      },
    });

    const duplicate = await coordinator.start("user-1", {
      commandId: "connection-1",
      connectionTypeId: "gmail",
      botId: "primary",
    });
    expect(duplicate).toEqual(result);
    expect(store.log).toEqual(["intent", "external-link", "authorizing"]);
  });

  test("reconciles an uncertain Connect Link without repeating its effect", async () => {
    const store = new MemoryConnectionStore();
    let createCalls = 0;
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (_input, init) => {
        if (init?.method === "POST") {
          createCalls += 1;
          return Promise.reject(new Error("response lost"));
        }
        return Promise.resolve(
          Response.json({
            items: [
              {
                id: "ca_123",
                status: "ACTIVE",
                toolkit: { slug: "gmail" },
                alias: "connection-1",
              },
            ],
          }),
        );
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {
        gmail: {
          authConfigId: "ac_gmail",
          displayName: "Gmail",
          toolkitSlug: "gmail",
        },
      },
    });

    await expect(
      coordinator.start("user-1", {
        commandId: "connection-1",
        connectionTypeId: "gmail",
        botId: "primary",
      }),
    ).rejects.toThrow("response lost");
    const reconciled = await coordinator.start("user-1", {
      commandId: "connection-1",
      connectionTypeId: "gmail",
      botId: "primary",
    });

    expect(createCalls).toBe(1);
    expect(reconciled.redirectUrl).toContain("connected_account_id=ca_123");
    expect(store.connections.get("connection-1")?.safeMetadata).toMatchObject({
      connectedAccountId: "ca_123",
      targetBotId: "primary",
    });
  });

  test("retires an expired persisted Connect Link operation", async () => {
    const store = new MemoryConnectionStore();
    await store.startConnection("user-1", {
      connectionId: "connection-expired",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await store.updateConnection("user-1", "connection-expired", {
      state: "authorizing",
      safeMetadata: {
        redirectUrl: "https://connect.example/expired",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({
        apiKey: "secret",
        fetch: () => Promise.reject(new Error("provider not expected")),
      }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {
        gmail: {
          authConfigId: "ac_gmail",
          displayName: "Gmail",
          toolkitSlug: "gmail",
        },
      },
    });

    await expect(
      coordinator.start("user-1", {
        commandId: "connection-expired",
        connectionTypeId: "gmail",
        botId: "primary",
      }),
    ).rejects.toMatchObject({
      name: "DefinitiveConnectionOperationError",
    });
    expect(store.connections.get("connection-expired")?.state).toBe("failed");
  });

  test("records revocation intent before the provider effect", async () => {
    const store = new MemoryConnectionStore();
    await store.startConnection("user-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await store.updateConnection("user-1", "connection-1", {
      state: "ready",
      safeMetadata: { connectedAccountId: "ca_123" },
    });
    let providerCalls = 0;
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: () => {
        providerCalls += 1;
        expect(store.connections.get("connection-1")?.state).toBe("revoking");
        return Promise.resolve(Response.json({ success: true }));
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
    });

    await coordinator.revoke("user-1", "connection-1");
    await coordinator.revoke("user-1", "connection-1");

    expect(store.connections.get("connection-1")?.state).toBe("revoked");
    expect(providerCalls).toBe(1);

    let delayedCallbackFailure: unknown;
    try {
      await coordinator.complete("user-1", {
        connectionId: "connection-1",
        connectedAccountId: "ca_123",
      });
    } catch (error) {
      delayedCallbackFailure = error;
    }
    expect(delayedCallbackFailure).toBeInstanceOf(Error);
    expect(store.connections.get("connection-1")?.state).toBe("revoked");
  });

  test("revokes a targeted legacy assignment without generation metadata", async () => {
    const store = new MemoryConnectionStore();
    await store.startConnection("user-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await store.updateConnection("user-1", "connection-1", {
      state: "ready",
      safeMetadata: {
        connectedAccountId: "ca_123",
        targetBotId: "primary",
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({
        apiKey: "secret",
        fetch: () => Promise.resolve(Response.json({ success: true })),
      }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
      markBotUnavailable: (_userId, _botId, _connectionId, compensation) => {
        expect(compensation.expectedGeneration).toBe("legacy:any");
        return Promise.resolve("applied");
      },
    });

    expect(await coordinator.revoke("user-1", "connection-1")).toEqual({
      status: "revoked",
    });
    expect(store.connections.get("connection-1")?.state).toBe("revoked");
  });

  test("durably retains normal revocation compensation after Bot RPC failure", async () => {
    const store = new MemoryConnectionStore();
    await store.startConnection("user-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await store.updateConnection("user-1", "connection-1", {
      state: "ready",
      safeMetadata: {
        connectedAccountId: "ca_123",
        targetBotId: "primary",
        assignmentGeneration: "assigned-lease",
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({
        apiKey: "secret",
        fetch: () => Promise.resolve(Response.json({ success: true })),
      }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
      markBotUnavailable: () =>
        Promise.reject(new Error("Bot RPC unavailable")),
    });

    await expect(coordinator.revoke("user-1", "connection-1")).rejects.toThrow(
      "Bot RPC unavailable",
    );
    expect(store.connections.get("connection-1")).toMatchObject({
      state: "revoking",
      safeMetadata: {
        revocationProviderCompleted: true,
        assignmentCompensationPending: true,
      },
    });
  });

  test("does not repeat an uncertain revocation effect", async () => {
    const store = new MemoryConnectionStore();
    await store.startConnection("user-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await store.updateConnection("user-1", "connection-1", {
      state: "ready",
      safeMetadata: { connectedAccountId: "ca_123" },
    });
    let revokeCalls = 0;
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (_input, init) => {
        if (init?.method === "POST") {
          revokeCalls += 1;
          return Promise.reject(new Error("response lost"));
        }
        return Promise.resolve(
          Response.json({
            items: [
              {
                id: "ca_123",
                status: "ACTIVE",
                toolkit: { slug: "gmail" },
              },
            ],
          }),
        );
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
    });

    await expect(coordinator.revoke("user-1", "connection-1")).rejects.toThrow(
      "response lost",
    );
    const retried = await coordinator.revoke("user-1", "connection-1");

    expect(revokeCalls).toBe(1);
    expect(retried.status).toBe("reconciliation-required");
    expect(store.connections.get("connection-1")?.state).toBe(
      "reconciliation-required",
    );
  });

  test("verifies account ownership and active state before readiness", async () => {
    const store = new MemoryConnectionStore();
    await store.startConnection("user-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await store.updateConnection("user-1", "connection-1", {
      state: "authorizing",
      safeMetadata: {
        connectedAccountId: "ca_123",
        targetBotId: "primary",
      },
    });
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: () =>
        Promise.resolve(
          Response.json({
            items: [
              {
                id: "ca_123",
                status: "ACTIVE",
                toolkit: { slug: "gmail" },
                alias: "personal",
              },
            ],
          }),
        ),
    });
    const assignments: Array<{
      userId: string;
      botId: string;
      connectionId: string;
    }> = [];
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
      assignBot: (userId, botId, connectionId) => {
        assignments.push({ userId, botId, connectionId });
        return Promise.resolve();
      },
    });

    await coordinator.complete("user-1", {
      connectionId: "connection-1",
      connectedAccountId: "ca_123",
    });

    expect(store.connections.get("connection-1")).toMatchObject({
      state: "ready",
      safeMetadata: { toolkitSlug: "gmail", providerAlias: "personal" },
    });
    expect(assignments).toEqual([
      { userId: "user-1", botId: "primary", connectionId: "connection-1" },
    ]);

    const failed = await coordinator.fail(
      "user-1",
      "connection-1",
      "delayed failure",
    );
    expect(failed.status).toBe("failed");
    expect(store.connections.get("connection-1")?.state).toBe("ready");
  });

  test("serializes concurrent successful callbacks behind one assignment lease", async () => {
    const store = new MemoryConnectionStore();
    await store.startConnection("user-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await store.updateConnection("user-1", "connection-1", {
      state: "authorizing",
      safeMetadata: {
        connectedAccountId: "ca_123",
        targetBotId: "primary",
      },
    });
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: () =>
        Promise.resolve(
          Response.json({
            items: [
              {
                id: "ca_123",
                status: "ACTIVE",
                toolkit: { slug: "gmail" },
              },
            ],
          }),
        ),
    });
    let releaseAssignment!: () => void;
    let assignmentStarted!: () => void;
    const assignmentGate = new Promise<void>((resolve) => {
      releaseAssignment = resolve;
    });
    const started = new Promise<void>((resolve) => {
      assignmentStarted = resolve;
    });
    let assignments = 0;
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
      assignBot: () => {
        assignments += 1;
        assignmentStarted();
        return assignmentGate;
      },
      markBotUnavailable: () => {
        throw new Error("valid assignment must not be compensated");
      },
    });

    const first = coordinator.complete("user-1", {
      connectionId: "connection-1",
      connectedAccountId: "ca_123",
    });
    await started;
    await coordinator.complete("user-1", {
      connectionId: "connection-1",
      connectedAccountId: "ca_123",
    });
    releaseAssignment();
    await first;

    expect(assignments).toBe(1);
    expect(store.connections.get("connection-1")?.state).toBe("ready");
  });

  test("does not let a stale callback compensate a newer assignment lease", async () => {
    const store = new MemoryConnectionStore();
    await store.startConnection("user-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await store.updateConnection("user-1", "connection-1", {
      state: "authorizing",
      safeMetadata: {
        connectedAccountId: "ca_123",
        targetBotId: "primary",
      },
    });
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: () =>
        Promise.resolve(
          Response.json({
            items: [
              {
                id: "ca_123",
                status: "ACTIVE",
                toolkit: { slug: "gmail" },
              },
            ],
          }),
        ),
    });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const firstStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondStart = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let assignmentAttempt = 0;
    let invalidations = 0;
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
      assignBot: () => {
        assignmentAttempt += 1;
        if (assignmentAttempt === 1) {
          firstStarted();
          return firstGate;
        }
        secondStarted();
        return secondGate;
      },
      markBotUnavailable: () => {
        invalidations += 1;
        return Promise.resolve("applied" as const);
      },
    });

    const first = coordinator.complete("user-1", {
      connectionId: "connection-1",
      connectedAccountId: "ca_123",
    });
    await firstStart;
    const leased = store.connections.get("connection-1");
    if (!leased) throw new Error("missing leased connection");
    store.connections.set("connection-1", {
      ...leased,
      safeMetadata: {
        ...leased.safeMetadata,
        assignmentLeaseExpiresAt: Date.now() - 1,
      },
    });
    const second = coordinator.complete("user-1", {
      connectionId: "connection-1",
      connectedAccountId: "ca_123",
    });
    await secondStart;
    releaseFirst();
    await expect(first).rejects.toThrow("state changed");
    expect(invalidations).toBe(0);
    releaseSecond();
    await second;

    expect(store.connections.get("connection-1")?.state).toBe("ready");
    expect(invalidations).toBe(0);
  });

  test("reacquires an expired assignment lease with a fresh command id", async () => {
    const store = new MemoryConnectionStore();
    await store.startConnection("user-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await store.updateConnection("user-1", "connection-1", {
      state: "reconciliation-required",
      safeMetadata: {
        connectedAccountId: "ca_123",
        targetBotId: "primary",
        reconciliationOperation: "assignment",
        assignmentLeaseId: "expired-lease",
        assignmentLeaseExpiresAt: Date.now() - 1,
      },
    });
    const leaseIds: string[] = [];
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({
        apiKey: "secret",
        fetch: () => Promise.reject(new Error("provider lookup not expected")),
      }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
      assignBot: (_userId, _botId, _connectionId, leaseId) => {
        leaseIds.push(leaseId);
        return Promise.resolve();
      },
    });

    await coordinator.complete("user-1", {
      connectionId: "connection-1",
      connectedAccountId: "ca_123",
    });

    expect(leaseIds).toHaveLength(1);
    expect(leaseIds[0]).not.toBe("expired-lease");
    expect(store.connections.get("connection-1")?.state).toBe("ready");
  });

  test("persists compensation before repairing a lost assignment race", async () => {
    const store = new MemoryConnectionStore();
    await store.startConnection("user-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await store.updateConnection("user-1", "connection-1", {
      state: "authorizing",
      safeMetadata: {
        connectedAccountId: "ca_123",
        targetBotId: "primary",
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({
        apiKey: "secret",
        fetch: () =>
          Promise.resolve(
            Response.json({
              items: [
                {
                  id: "ca_123",
                  status: "ACTIVE",
                  toolkit: { slug: "gmail" },
                },
              ],
            }),
          ),
      }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
      assignBot: async () => {
        await store.updateConnection("user-1", "connection-1", {
          state: "revoking",
        });
      },
      markBotUnavailable: () =>
        Promise.reject(new Error("Bot RPC unavailable")),
    });

    await expect(
      coordinator.complete("user-1", {
        connectionId: "connection-1",
        connectedAccountId: "ca_123",
      }),
    ).rejects.toThrow("Bot RPC unavailable");
    expect(
      store.connections.get("connection-1")?.safeMetadata
        .assignmentCompensationPending,
    ).toBe(true);
  });

  test("does not resurrect a connection when revocation wins the callback race", async () => {
    const store = new MemoryConnectionStore();
    await store.startConnection("user-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await store.updateConnection("user-1", "connection-1", {
      state: "authorizing",
      safeMetadata: {
        connectedAccountId: "ca_123",
        targetBotId: "primary",
      },
    });

    let releaseLookup!: (response: Response) => void;
    let lookupStarted!: () => void;
    const lookup = new Promise<Response>((resolve) => {
      releaseLookup = resolve;
    });
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (_input, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(Response.json({ success: true }));
        }
        lookupStarted();
        return lookup;
      },
    });
    let assignments = 0;
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
      assignBot: () => {
        assignments += 1;
        return Promise.resolve();
      },
    });

    const completion = coordinator.complete("user-1", {
      connectionId: "connection-1",
      connectedAccountId: "ca_123",
    });
    await started;
    await coordinator.revoke("user-1", "connection-1");
    releaseLookup(
      Response.json({
        items: [
          {
            id: "ca_123",
            status: "ACTIVE",
            toolkit: { slug: "gmail" },
          },
        ],
      }),
    );

    await expect(completion).rejects.toThrow("state changed");
    expect(store.connections.get("connection-1")?.state).toBe("revoked");
    expect(assignments).toBe(0);
  });

  test("invalidates every Bot that depends on a revoked Connection", async () => {
    const store = new MemoryConnectionStore();
    store.connections.set("connection-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
      state: "revoking",
      safeMetadata: {
        connectedAccountId: "ca_123",
        revocationProviderCompleted: true,
        assignmentCompensationPending: true,
        assignmentCompensations: [
          { botId: "bot-a", id: "comp-a", expectedGeneration: "gen-a" },
          { botId: "bot-b", id: "comp-b", expectedGeneration: "gen-b" },
        ],
      },
    });
    const invalidated: string[] = [];
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({ apiKey: "secret" }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
      markBotUnavailable: (_userId, botId) => {
        invalidated.push(botId);
        return Promise.resolve("applied");
      },
    });

    expect(await coordinator.revoke("user-1", "connection-1")).toEqual({
      status: "revoked",
    });
    expect(invalidated).toEqual(["bot-a", "bot-b"]);
  });
});
