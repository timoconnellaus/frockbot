import { describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import { ComposioClient } from "@frockbot/plugin-composio/client";
import {
  completeAssignmentCompensation,
  ComposioConnectionCoordinator,
  type ComposioConnectionStore,
} from "@frockbot/plugin-composio";
import { deriveRevocationCompensations } from "@frockbot/plugin-composio/user-configuration";
import type { StartConnectionInput } from "./user-configuration.js";

class MemoryConnectionStore implements ComposioConnectionStore {
  readonly log: string[] = [];
  readonly connections = new Map<string, ConnectionView>();
  packageInstalled = true;
  packagePolicyReads = 0;

  isPackageInstalled(_userId: string, packageId: string): Promise<boolean> {
    this.packagePolicyReads += 1;
    return Promise.resolve(
      this.packageInstalled && packageId === "composio",
    );
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
      authorizationStateId?: string;
    },
  ): Promise<boolean> {
    const current = this.connections.get(connectionId);
    if (!current) return Promise.resolve(false);
    if (update.authorizationStateId !== undefined) {
      if (
        current.safeMetadata.authorizationStateId !==
          update.authorizationStateId ||
        current.state === "ready" ||
        current.state === "failed" ||
        current.safeMetadata.revocationRequested === true ||
        (current.state !== "authorizing" &&
          !(
            current.state === "reconciliation-required" &&
            current.safeMetadata.reconciliationOperation === "link"
          )) ||
        (current.safeMetadata.authorizationStateConsumed !== true &&
          typeof current.safeMetadata.authorizationStateExpiresAt ===
            "number" &&
          current.safeMetadata.authorizationStateExpiresAt <= Date.now())
      ) {
        return Promise.resolve(false);
      }
      this.updateConnection(_userId, connectionId, {
        ...update,
        safeMetadata: {
          ...(update.safeMetadata ?? current.safeMetadata),
          authorizationStateConsumed: true,
        },
      });
      return Promise.resolve(true);
    }
    if (current.state !== "authorizing") return Promise.resolve(false);
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

  admitConnectionCallback(
    _userId: string,
    connectionId: string,
    input: {
      authorizationStateId: string;
      connectedAccountId: string;
      leaseId: string;
      verifiedMetadata?: ConnectionView["safeMetadata"];
    },
  ): Promise<{
    phase: "acquired" | "resumable" | "pending" | "done" | "invalid";
    connection: ConnectionView;
    leaseId?: string;
  }> {
    const current = this.connections.get(connectionId);
    if (!current) throw new Error("missing connection");
    if (
      (current.safeMetadata.authorizationStateId !== undefined &&
        current.safeMetadata.authorizationStateId !==
          input.authorizationStateId) ||
      current.safeMetadata.connectedAccountId !== input.connectedAccountId
    ) {
      return Promise.resolve({ phase: "invalid", connection: current });
    }
    if (current.safeMetadata.authorizationStateConsumed === true) {
      if (current.state === "ready") {
        return Promise.resolve({ phase: "done", connection: current });
      }
      if (
        current.state === "reconciliation-required" &&
        current.safeMetadata.reconciliationOperation === "assignment" &&
        typeof current.safeMetadata.assignmentLeaseId === "string" &&
        typeof current.safeMetadata.assignmentLeaseExpiresAt === "number" &&
        current.safeMetadata.assignmentLeaseExpiresAt > Date.now() &&
        current.safeMetadata.assignmentCompensationPending !== true &&
        current.safeMetadata.revocationRequested !== true
      ) {
        return Promise.resolve({
          phase: "resumable",
          connection: current,
          leaseId: current.safeMetadata.assignmentLeaseId,
        });
      }
      return Promise.resolve({ phase: "pending", connection: current });
    }
    if (
      typeof current.safeMetadata.authorizationStateExpiresAt === "number" &&
      current.safeMetadata.authorizationStateExpiresAt <= Date.now()
    ) {
      return Promise.resolve({ phase: "invalid", connection: current });
    }
    if (
      current.safeMetadata.revocationRequested === true ||
      (current.state !== "authorizing" &&
        !(
          current.state === "reconciliation-required" &&
          current.safeMetadata.reconciliationOperation === "link"
        ))
    ) {
      return Promise.resolve({ phase: "invalid", connection: current });
    }
    const claimed: ConnectionView = {
      ...current,
      state: "reconciliation-required",
      safeMetadata: {
        ...(input.verifiedMetadata ?? current.safeMetadata),
        authorizationStateConsumed: true,
        reconciliationOperation: "assignment",
        assignmentLeaseId: input.leaseId,
        assignmentLeaseExpiresAt: Date.now() + 60_000,
      },
    };
    this.connections.set(connectionId, claimed);
    return Promise.resolve({
      phase: "acquired",
      connection: claimed,
      leaseId: input.leaseId,
    });
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
    if (!current) return Promise.resolve(false);
    const completed = completeAssignmentCompensation(current, compensationId);
    if (!completed) return Promise.resolve(false);
    this.connections.set(connectionId, completed);
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
    const assignmentCompensations = deriveRevocationCompensations(connection);
    const claimed: ConnectionView = {
      ...connection,
      state: "revoking",
      safeMetadata: {
        ...connection.safeMetadata,
        reconciliationOperation: "revoke",
        revocationProviderCompleted: false,
        assignmentCompensations,
        assignmentCompensationPending: assignmentCompensations.length > 0,
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
        calendar: {
          authConfigId: "ac_calendar",
          displayName: "Calendar",
          toolkitSlug: "googlecalendar",
        },
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
    });

    expect(store.log).toEqual(["intent", "external-link", "authorizing"]);
    expect(result.connectionId).toBe("connection-1");
    expect(store.connections.get("connection-1")).toMatchObject({
      state: "authorizing",
      safeMetadata: {
        connectedAccountId: "ca_123",
        toolkitSlug: "gmail",
      },
    });
    expect(
      typeof store.connections.get("connection-1")?.safeMetadata
        .startCommandFingerprint,
    ).toBe("string");
    expect(
      store.connections.get("connection-1")?.safeMetadata,
    ).not.toHaveProperty("targetBotId");

    const duplicate = await coordinator.start("user-1", {
      commandId: "connection-1",
      connectionTypeId: "gmail",
    });
    expect(duplicate).toEqual(result);
    expect(store.packagePolicyReads).toBe(1);
    expect(store.log).toEqual(["intent", "external-link", "authorizing"]);

    const beforeCollision = structuredClone(
      store.connections.get("connection-1"),
    );
    await expect(
      coordinator.start("user-1", {
        commandId: "connection-1",
        connectionTypeId: "gmail",
        alias: "Work",
      }),
    ).rejects.toThrow(
      'Connection command idempotency key "connection-1" was reused for a different command',
    );
    await expect(
      coordinator.start("user-1", {
        commandId: "connection-1",
        connectionTypeId: "gmail",
        returnTarget: "desktop",
      }),
    ).rejects.toThrow(
      'Connection command idempotency key "connection-1" was reused for a different command',
    );
    await expect(
      coordinator.start("user-1", {
        commandId: "connection-1",
        connectionTypeId: "calendar",
      }),
    ).rejects.toThrow(
      'Connection command idempotency key "connection-1" was reused for a different command',
    );
    expect(store.connections.get("connection-1")).toEqual(beforeCollision);
    expect(store.log).toEqual(["intent", "external-link", "authorizing"]);
  });

  test("reconciles an uncertain Connect Link without repeating its effect", async () => {
    const store = new MemoryConnectionStore();
    let createCalls = 0;
    let reconciliationReads = 0;
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (_input, init) => {
        if (init?.method === "POST") {
          createCalls += 1;
          return Promise.reject(new Error("response lost"));
        }
        reconciliationReads += 1;
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
      }),
    ).rejects.toThrow("response lost");
    store.packageInstalled = false;
    const replayCoordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
    });
    const beforeCollision = structuredClone(
      store.connections.get("connection-1"),
    );
    await expect(
      replayCoordinator.start("user-1", {
        commandId: "connection-1",
        connectionTypeId: "gmail",
        alias: "Work",
      }),
    ).rejects.toThrow(
      'Connection command idempotency key "connection-1" was reused for a different command',
    );
    expect(store.connections.get("connection-1")).toEqual(beforeCollision);
    expect(reconciliationReads).toBe(0);
    expect(store.packagePolicyReads).toBe(1);
    const reconciled = await replayCoordinator.start("user-1", {
      commandId: "connection-1",
      connectionTypeId: "gmail",
    });

    expect(createCalls).toBe(1);
    expect(reconciliationReads).toBe(1);
    expect(store.packagePolicyReads).toBe(1);
    expect(reconciled.redirectUrl).toContain("connected_account_id=ca_123");
    expect(store.connections.get("connection-1")?.safeMetadata).toMatchObject({
      connectedAccountId: "ca_123",
    });
    await expect(
      replayCoordinator.start("user-1", {
        commandId: "connection-2",
        connectionTypeId: "gmail",
      }),
    ).rejects.toThrow("Composio Package is not installed");
    expect(store.packagePolicyReads).toBe(2);
    expect(createCalls).toBe(1);
    expect(reconciliationReads).toBe(1);
  });

  test("retires a persisted Link whose callback state expired first", async () => {
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
        toolkitSlug: "gmail",
        redirectUrl: "https://connect.example/still-live",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        authorizationStateId: "expired-state",
        authorizationStateExpiresAt: Date.now() - 1_000,
        startCommandFingerprint: `connection-start-command-v1:${JSON.stringify({
          userId: "user-1",
          packageId: "composio",
          connectionTypeId: "gmail",
          alias: null,
          safeMetadata: {
            returnTarget: "browser",
          },
        })}`,
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

  test("does not infer an Assignment from legacy target metadata alone", async () => {
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
    let invalidations = 0;
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({
        apiKey: "secret",
        fetch: () => Promise.resolve(Response.json({ success: true })),
      }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
      markBotUnavailable: () => {
        invalidations += 1;
        return Promise.resolve("applied");
      },
    });

    expect(await coordinator.revoke("user-1", "connection-1")).toEqual({
      status: "revoked",
    });
    expect(store.connections.get("connection-1")?.state).toBe("revoked");
    expect(invalidations).toBe(0);
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
        authorizationStateId: "state-1",
        authorizationStateExpiresAt: Date.now() + 60_000,
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
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
    });

    await coordinator.complete("user-1", {
      connectionId: "connection-1",
      connectedAccountId: "ca_123",
    });

    expect(store.connections.get("connection-1")).toMatchObject({
      state: "ready",
      safeMetadata: { toolkitSlug: "gmail", providerAlias: "personal" },
    });
    expect(
      store.connections.get("connection-1")?.safeMetadata.assignmentGeneration,
    ).toBeUndefined();

    await expect(
      coordinator.fail("user-1", "connection-1", "delayed failure", "state-1"),
    ).resolves.toMatchObject({ status: "ready" });
    expect(store.connections.get("connection-1")?.state).toBe("ready");
  });

  test("does not consume callback state for a mismatched account", async () => {
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
        authorizationStateId: "state-1",
        authorizationStateExpiresAt: Date.now() + 60_000,
        connectedAccountId: "ca_expected",
      },
    });
    let providerLookups = 0;
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({
        apiKey: "secret",
        fetch: () => {
          providerLookups += 1;
          return Promise.resolve(
            Response.json({
              items: [
                {
                  id: "ca_expected",
                  status: "ACTIVE",
                  toolkit: { slug: "gmail" },
                },
              ],
            }),
          );
        },
      }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
    });

    await expect(
      coordinator.complete("user-1", {
        connectionId: "connection-1",
        connectedAccountId: "ca_unexpected",
        authorizationStateId: "state-1",
      }),
    ).rejects.toThrow("does not match");
    expect(
      store.connections.get("connection-1")?.safeMetadata
        .authorizationStateConsumed,
    ).not.toBe(true);

    await expect(
      coordinator.complete("user-1", {
        connectionId: "connection-1",
        connectedAccountId: "ca_expected",
        authorizationStateId: "state-1",
      }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      coordinator.complete("user-1", {
        connectionId: "connection-1",
        connectedAccountId: "ca_expected",
        authorizationStateId: "state-1",
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(providerLookups).toBe(1);
  });

  test("atomically makes concurrent callbacks ready without assignment", async () => {
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
        authorizationStateId: "state-1",
        authorizationStateExpiresAt: Date.now() + 60_000,
        connectedAccountId: "ca_123",
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
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
    });

    const first = coordinator.complete("user-1", {
      connectionId: "connection-1",
      connectedAccountId: "ca_123",
      authorizationStateId: "state-1",
    });
    const second = coordinator.complete("user-1", {
      connectionId: "connection-1",
      connectedAccountId: "ca_123",
      authorizationStateId: "state-1",
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "ready" }),
      expect.objectContaining({ status: "ready" }),
    ]);

    expect(store.connections.get("connection-1")?.state).toBe("ready");
  });

  test("reports the durable terminal status when failure loses a race", async () => {
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
        authorizationStateId: "state-1",
        authorizationStateExpiresAt: Date.now() + 60_000,
      },
    });
    store.finishConnectionAuthorization = async (userId, connectionId) => {
      await store.updateConnection(userId, connectionId, { state: "ready" });
      return false;
    };
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({
        apiKey: "secret",
        fetch: () => Promise.reject(new Error("provider not expected")),
      }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
    });

    await expect(
      coordinator.fail("user-1", "connection-1", "stale failure", "state-1"),
    ).resolves.toMatchObject({ status: "ready" });
    expect(store.connections.get("connection-1")?.state).toBe("ready");
  });

  test("atomically consumes a failed callback into durable failure", async () => {
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
        authorizationStateId: "state-1",
        authorizationStateExpiresAt: Date.now() + 60_000,
      },
    });
    store.consumeAuthorizationState = () =>
      Promise.reject(new Error("separate state consumption is unsafe"));
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({ apiKey: "secret" }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
    });

    await expect(
      coordinator.fail(
        "user-1",
        "connection-1",
        "provider rejected authorization",
        "state-1",
      ),
    ).resolves.toMatchObject({ status: "failed" });
    expect(store.connections.get("connection-1")).toMatchObject({
      state: "failed",
      failure: "provider rejected authorization",
      safeMetadata: { authorizationStateConsumed: true },
    });
    await expect(
      coordinator.fail(
        "user-1",
        "connection-1",
        "duplicate callback",
        "state-1",
      ),
    ).resolves.toMatchObject({ status: "failed" });
  });

  test("does not re-enter a consumed callback after lease expiry", async () => {
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
        authorizationStateConsumed: true,
        reconciliationOperation: "assignment",
        assignmentLeaseId: "expired-lease",
        assignmentLeaseExpiresAt: Date.now() - 1,
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({
        apiKey: "secret",
        fetch: () => Promise.reject(new Error("provider not expected")),
      }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
    });

    const result = await coordinator.complete("user-1", {
      connectionId: "connection-1",
      connectedAccountId: "ca_123",
    });
    expect(result.status).toBe("pending");
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
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
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

  test("retires stale and applied generations during revocation", async () => {
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
          { botId: "primary", id: "old", expectedGeneration: "gen-old" },
          { botId: "primary", id: "new", expectedGeneration: "gen-new" },
        ],
      },
    });
    const results: string[] = [];
    const coordinator = new ComposioConnectionCoordinator({
      client: new ComposioClient({ apiKey: "secret" }),
      store,
      callbackBaseUrl: "https://bot.frockbot.com",
      connectionTypes: {},
      markBotUnavailable: (_userId, _botId, _connectionId, compensation) => {
        results.push(compensation.expectedGeneration);
        return Promise.resolve(
          compensation.expectedGeneration === "gen-old" ? "stale" : "applied",
        );
      },
    });

    await expect(coordinator.revoke("user-1", "connection-1")).resolves.toEqual(
      { status: "revoked" },
    );
    expect(results).toEqual(["gen-old", "gen-new"]);
    expect(store.connections.get("connection-1")).toMatchObject({
      state: "revoked",
      safeMetadata: { assignmentCompensations: [] },
    });
  });
});
