import { describe, expect, test } from "bun:test";
import { Context } from "cordis";
import {
  createFoundationResidentRuntime,
  type FoundationResidentRuntime,
} from "@frockbot/agent-runtime/runtime";
import type { SessionEvent } from "@frockbot/agent-core";
import type {
  BotConfigurationReadRpcV1,
  BotSettingsViewV1,
  ConfigurationCommandV1,
  ConfigurationQueryV1,
  ConfigurationViewV1,
  OperationReceiptV1,
  UserConfigurationReadRpcV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type { StoredRun } from "@frockbot/plugin-shell/backend-contracts";
import { randomSheepRecipeV1 } from "@frockbot/plugin-flock/shared";
import {
  createClientRunStopReceiptV1,
  decodeClientRunLookupV1,
  decodeClientRunListV1,
  decodeClientRunStopReceiptV1,
  decodeClientTurnV1,
  projectClientRunLookupV1,
  projectClientRunListV1,
  projectClientRunV1,
  projectClientTurnV1,
  type ClientRunLookupQueryV1,
  type ClientRunLookupV1,
  type ClientRunListQueryV1,
  type ClientRunListV1,
  type ClientRunStopCommandV1,
  type ClientRunStopReceiptV1,
} from "@frockbot/plugin-shell/run-protocol";
import type {
  BotNotificationIntent,
  BotConfigurationBinding,
  BotStateBinding,
  BotTurnCommand,
  BotTurnResult,
  ConnectionBinding,
  GatewayAuth,
  LoadedWorker,
  UserBotStateBinding,
  UserConfigurationBinding,
  WorkerCode,
  WorkerLoader,
} from "./contracts.js";
import { executeResidentBotTurn } from "./bot-runner.js";
import { applicationDeploymentId, createGateway } from "./gateway.js";
import { createUserApplication } from "./user-application.js";

class MemoryBotState implements BotStateBinding {
  private readonly runs = new Map<string, StoredRun[]>();
  private readonly sessions = new Map<string, SessionEvent[]>();
  private readonly admissionFences = new Set<string>();
  private readonly residentRuntimes = new Map<
    string,
    Promise<FoundationResidentRuntime>
  >();
  readonly notifications = new Map<string, BotNotificationIntent[]>();

  private residentRuntime(botId: string): Promise<FoundationResidentRuntime> {
    let runtime = this.residentRuntimes.get(botId);
    if (!runtime) {
      runtime = createFoundationResidentRuntime(new Context()).then(
        async (created) => {
          await created.project({
            generation: 0,
            agentPackages: [],
            systemPromptSection: "You are Internal Bot configuration.",
          });
          return created;
        },
      );
      this.residentRuntimes.set(botId, runtime);
    }
    return runtime;
  }

  async run(botId: string, command: BotTurnCommand): Promise<BotTurnResult> {
    if (this.admissionFences.has(`${botId}:${command.runId}`)) {
      throw new Error(`run "${command.runId}" admission was fenced`);
    }
    const runs = this.runs.get(botId) ?? [];
    const existing = runs.find(
      (candidate) => candidate.runId === command.runId,
    );
    if (existing?.status === "completed") {
      return projectClientTurnV1({
        runId: existing.runId,
        text: existing.responseText ?? "",
        events: structuredClone(existing.events),
      });
    }
    if (existing) throw new Error("duplicate run is still active");
    if (runs.some((candidate) => candidate.status === "running")) {
      throw new Error("bot already has an active run");
    }
    const previousEvents = this.sessions.get(botId) ?? [];
    const run: StoredRun = {
      runId: command.runId,
      commandFingerprint: "internal-command-fingerprint",
      sessionId: command.sessionId,
      acceptedAt: command.acceptedAt,
      input: command.text,
      events: [],
      effectAdmissions: [],
      status: "running",
      phase: "admitted",
      configurationSnapshot: {
        schemaVersion: 1,
        botId,
        revision: 0,
        profile: { name: "Internal Bot configuration" },
        notifications: { enabled: false },
        assignments: [],
      },
      previousEventCount: previousEvents.length,
    };
    runs.push(run);
    this.runs.set(botId, runs);
    try {
      const result = await executeResidentBotTurn(
        await this.residentRuntime(botId),
        {
          botId,
          command,
          previousEvents,
          persistSessionEvents: () => Promise.resolve(),
          beforeStart: () => Promise.resolve(true),
          admitEffect: () => Promise.resolve(true),
        },
      );
      run.events = structuredClone(result.events);
      run.status = "completed";
      run.responseText = result.text;
      this.sessions.set(botId, [...previousEvents, ...result.events]);
      return projectClientTurnV1(result);
    } catch (error) {
      run.status = "failed";
      run.failure = error instanceof Error ? error.message : "Bot turn failed";
      throw error;
    }
  }

  listRuns(
    botId: string,
    _query: ClientRunListQueryV1,
  ): Promise<ClientRunListV1> {
    return Promise.resolve(
      projectClientRunListV1(structuredClone(this.runs.get(botId) ?? [])),
    );
  }

  lookupRun(
    botId: string,
    query: ClientRunLookupQueryV1,
  ): Promise<ClientRunLookupV1> {
    return Promise.resolve(
      projectClientRunLookupV1(
        structuredClone(this.runs.get(botId) ?? []).find(
          (run) => run.runId === query.runId,
        ),
      ),
    );
  }

  fenceRunAdmission(
    botId: string,
    query: ClientRunLookupQueryV1,
  ): Promise<ClientRunLookupV1> {
    const run = structuredClone(this.runs.get(botId) ?? []).find(
      (candidate) => candidate.runId === query.runId,
    );
    if (!run) this.admissionFences.add(`${botId}:${query.runId}`);
    return Promise.resolve(projectClientRunLookupV1(run));
  }

  storedRuns(botId: string): StoredRun[] {
    return structuredClone(this.runs.get(botId) ?? []);
  }

  listNotifications(botId: string): Promise<BotNotificationIntent[]> {
    return Promise.resolve(
      structuredClone(this.notifications.get(botId) ?? []),
    );
  }

  acknowledgeNotification(
    botId: string,
    notificationId: string,
  ): Promise<void> {
    this.notifications.set(
      botId,
      (this.notifications.get(botId) ?? []).filter(
        (notification) => notification.notificationId !== notificationId,
      ),
    );
    return Promise.resolve();
  }

  stopRun(
    botId: string,
    command: ClientRunStopCommandV1,
  ): Promise<ClientRunStopReceiptV1> {
    const run = (this.runs.get(botId) ?? []).find(
      (candidate) => candidate.runId === command.runId,
    );
    if (!run) {
      return Promise.reject(
        new Error(`run "${command.runId}" was not admitted`),
      );
    }
    run.stopRequestedAt = run.stopRequestedAt ?? new Date().toISOString();
    return Promise.resolve(
      createClientRunStopReceiptV1(
        command,
        projectClientRunV1(structuredClone(run)),
      ),
    );
  }

  reconcileRun(botId: string, runId: string): Promise<BotTurnResult> {
    const run = (this.runs.get(botId) ?? []).find(
      (candidate) => candidate.runId === runId,
    );
    if (!run || run.status !== "completed") {
      return Promise.reject(new Error("run does not require reconciliation"));
    }
    return Promise.resolve(
      projectClientTurnV1({
        runId,
        text: run.responseText ?? "",
        events: structuredClone(run.events),
      }),
    );
  }
}

function rpcBindingFor(state: BotStateBinding): UserBotStateBinding {
  return {
    assertRegistered: () => Promise.resolve(),
    run: ({ botId, command }) => state.run(botId, command),
    listRuns: ({ botId, query }) => state.listRuns(botId, query),
    lookupRun: ({ botId, query }) => state.lookupRun(botId, query),
    fenceRunAdmission: ({ botId, query }) =>
      state.fenceRunAdmission(botId, query),
    listNotifications: ({ botId }) => state.listNotifications(botId),
    acknowledgeNotification: ({ botId, notificationId }) =>
      state.acknowledgeNotification(botId, notificationId),
    reconcileRun: ({ botId, runId }) => state.reconcileRun(botId, runId),
    stopRun: ({ botId, command }) => state.stopRun(botId, command),
  };
}

class MemoryConfiguration
  implements UserConfigurationBinding, BotConfigurationBinding
{
  private user: UserSettingsViewV1 = {
    schemaVersion: 1,
    revision: 0,
    profile: { name: "FrockBot user" },
    packages: [],
    connections: [],
  };
  private readonly bots = new Map<string, BotSettingsViewV1>();
  private readonly receipts = new Map<string, OperationReceiptV1>();

  private read(query: ConfigurationQueryV1): Promise<ConfigurationViewV1> {
    if (query.type === "user/get") return Promise.resolve(this.user);
    const current = this.bots.get(query.botId) ?? {
      schemaVersion: 1 as const,
      botId: query.botId,
      revision: 0,
      profile: { name: query.botId },
      notifications: { enabled: false },
      assignments: [],
    };
    this.bots.set(query.botId, current);
    return Promise.resolve(current);
  }

  private async execute(
    command: ConfigurationCommandV1,
  ): Promise<OperationReceiptV1> {
    const duplicate = this.receipts.get(command.commandId);
    if (duplicate) return duplicate;
    const current = await this.read(
      "botId" in command
        ? { schemaVersion: 1, type: "bot/get", botId: command.botId }
        : { schemaVersion: 1, type: "user/get" },
    );
    if (current.revision !== command.expectedRevision) {
      throw new Error(`configuration revision is ${current.revision}`);
    }
    const revision = current.revision + 1;
    if ("botId" in command) {
      const bot = current as BotSettingsViewV1;
      this.bots.set(command.botId, {
        ...bot,
        revision,
        ...(command.type === "bot/update-profile"
          ? { profile: command.profile }
          : command.type === "bot/update-notifications"
            ? { notifications: command.notifications }
            : command.type === "bot/select-model"
              ? { model: command.model }
              : {
                  assignments: [
                    ...bot.assignments.filter(
                      (assignment) =>
                        assignment.assignmentId !==
                        command.assignment.assignmentId,
                    ),
                    { ...command.assignment, state: "enabled" as const },
                  ],
                }),
      });
    } else {
      const user = current as UserSettingsViewV1;
      if (command.type === "user/update-profile") {
        this.user = { ...user, revision, profile: command.profile };
      } else if (command.type === "user/set-new-bot-model") {
        this.user = {
          ...user,
          revision,
          newBotModelTemplate: command.model,
        };
      } else if (command.type === "user/install-package") {
        this.user = {
          ...user,
          revision,
          packages: [
            ...user.packages.filter(
              (pkg) => pkg.packageId !== command.packageId,
            ),
            {
              packageId: command.packageId,
              version: command.version,
              state: "installed",
            },
          ],
        };
      } else {
        this.user = {
          ...user,
          revision,
          packages: user.packages.map((pkg) =>
            pkg.packageId === command.packageId
              ? {
                  ...pkg,
                  state: command.enabled ? "installed" : "disabled",
                }
              : pkg,
          ),
        };
      }
    }
    const receipt: OperationReceiptV1 = {
      schemaVersion: 1,
      commandId: command.commandId,
      revision,
      status: "applied",
    };
    this.receipts.set(command.commandId, receipt);
    return receipt;
  }

  readConfiguration(
    request: UserConfigurationReadRpcV1,
  ): Promise<UserSettingsViewV1>;
  readConfiguration(
    request: BotConfigurationReadRpcV1,
  ): Promise<BotSettingsViewV1>;
  readConfiguration(
    request:
      | Parameters<UserConfigurationBinding["readConfiguration"]>[0]
      | Parameters<BotConfigurationBinding["readConfiguration"]>[0],
  ): Promise<ConfigurationViewV1> {
    return this.read(
      "botId" in request
        ? { schemaVersion: 1, type: "bot/get", botId: request.botId }
        : { schemaVersion: 1, type: "user/get" },
    );
  }

  executeConfiguration(
    request:
      | Parameters<UserConfigurationBinding["executeConfiguration"]>[0]
      | Parameters<BotConfigurationBinding["executeConfiguration"]>[0],
  ): Promise<OperationReceiptV1> {
    return this.execute(request.command);
  }

  listBots() {
    return Promise.resolve({
      schemaVersion: 1 as const,
      revision: this.bots.size,
      bots: [...this.bots.keys()].map((botId) => ({
        schemaVersion: 1 as const,
        botId,
        registeredAt: "2026-08-29T00:00:00.000Z",
        initialName: botId,
        sheep: randomSheepRecipeV1(() => 0),
      })),
    });
  }
  createBot(request: Parameters<UserConfigurationBinding["createBot"]>[0]) {
    void this.read({
      schemaVersion: 1,
      type: "bot/get",
      botId: request.command.botId,
    });
    return Promise.resolve({
      schemaVersion: 1 as const,
      commandId: request.command.commandId,
      status: "applied" as const,
      revision: this.bots.size,
    });
  }
  getBotRegistration(
    request: Parameters<UserConfigurationBinding["getBotRegistration"]>[0],
  ) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      botId: request.botId,
      registeredAt: "2026-08-29T00:00:00.000Z",
      initialName: request.botId,
      sheep: randomSheepRecipeV1(() => 0),
    });
  }
  hasBot(request: Parameters<UserConfigurationBinding["hasBot"]>[0]) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      botId: request.botId,
      registered: true,
    });
  }
  readSheep(request: Parameters<BotConfigurationBinding["readSheep"]>[0]) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      botId: request.botId,
      revision: 0,
      sheep: randomSheepRecipeV1(() => 0),
    });
  }
  updateSheep(request: Parameters<BotConfigurationBinding["updateSheep"]>[0]) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      commandId: request.command.commandId,
      status: "applied" as const,
      revision: request.command.expectedRevision + 1,
    });
  }
}

class MemoryConnections implements ConnectionBinding {
  completed: Array<{ connectionId: string; connectedAccountId: string }> = [];

  start(input: {
    commandId: string;
    connectionTypeId: string;
    botId: string;
    alias?: string;
  }) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      status: "authorization-required" as const,
      connectionId: `connection-${input.connectionTypeId}`,
      redirectUrl: "https://connect.composio.dev/link/test",
      expiresAt: "2026-08-28T01:00:00.000Z",
    });
  }

  complete(input: {
    connectionId: string;
    connectedAccountId: string;
  }): Promise<{
    returnTarget: "browser" | "desktop";
    status: "ready" | "pending";
  }> {
    this.completed.push(input);
    return Promise.resolve({ returnTarget: "browser", status: "ready" });
  }

  fail(
    _connectionId: string,
    _message: string,
  ): Promise<{
    returnTarget: "browser" | "desktop";
    status: "ready" | "pending";
  }> {
    return Promise.resolve({ returnTarget: "browser", status: "ready" });
  }

  revoke(_connectionId: string) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      status: "revoked" as const,
    });
  }
}

class DirectWorkerLoader implements WorkerLoader {
  readonly ids: string[] = [];
  readonly codes: WorkerCode[] = [];
  private readonly fetchApplication = createUserApplication();

  get(id: string, callback: () => Promise<WorkerCode>): LoadedWorker {
    this.ids.push(id);
    return {
      getEntrypoint: () => ({
        fetch: async (request) => {
          const code = await callback();
          this.codes.push(code);
          return this.fetchApplication(request, code.env);
        },
      }),
    };
  }
}

const unauthenticatedAuth: GatewayAuth = {
  handler: () => Promise.resolve(new Response("auth handler")),
  getSession: () => Promise.resolve(null),
};

function createTestGateway(
  applicationHashFor: (userId: string) => Promise<string> = () =>
    Promise.resolve("foundation-v1"),
  auth: GatewayAuth = unauthenticatedAuth,
  allowDevelopmentIdentity = true,
  allowedClientOrigins?: string[],
) {
  const loader = new DirectWorkerLoader();
  const states = new Map<string, MemoryBotState>();
  const configurations = new Map<string, MemoryConfiguration>();
  const configurationRoutes: string[] = [];
  const connections = new Map<string, MemoryConnections>();
  const gateway = createGateway({
    loader,
    artifacts: { load: () => Promise.resolve("export default {}") },
    auth,
    applicationHashFor,
    botStateFor: (userId) => {
      const state = states.get(userId) ?? new MemoryBotState();
      states.set(userId, state);
      return rpcBindingFor(state);
    },
    userConfigurationFor: (userId) => {
      configurationRoutes.push(`user:${userId}`);
      const configuration =
        configurations.get(userId) ?? new MemoryConfiguration();
      configurations.set(userId, configuration);
      return configuration;
    },
    botConfigurationFor: (userId, botId) => {
      configurationRoutes.push(`bot:${userId}:${botId}`);
      const configuration =
        configurations.get(userId) ?? new MemoryConfiguration();
      configurations.set(userId, configuration);
      return configuration;
    },
    backendContributions: [
      {
        packageId: "composio",
        async route(request, url, context) {
          if (!url.pathname.startsWith("/api/plugins/composio/")) {
            return undefined;
          }
          if (!context.userId) {
            return Response.json(
              { error: "authentication required" },
              { status: 401 },
            );
          }
          const connection =
            connections.get(context.userId) ?? new MemoryConnections();
          connections.set(context.userId, connection);
          if (url.pathname === "/api/plugins/composio/connections") {
            const input = (await request.json()) as Parameters<
              ConnectionBinding["start"]
            >[0];
            return Response.json(await connection.start(input), {
              status: 201,
            });
          }
          if (url.pathname === "/api/plugins/composio/callback") {
            const connectionId = url.searchParams.get("connection") ?? "";
            const connectedAccountId =
              url.searchParams.get("connected_account_id") ?? "";
            await connection.complete({ connectionId, connectedAccountId });
            return Response.redirect(
              new URL("/?connection=composio-ready", url.origin),
              303,
            );
          }
          const connectionId = decodeURIComponent(
            url.pathname.split("/").at(-2) ?? "",
          );
          return Response.json(await connection.revoke(connectionId));
        },
      },
    ],
    allowedClientOrigins,
    allowDevelopmentIdentity,
  });
  return {
    gateway,
    loader,
    states,
    configurations,
    connections,
    configurationRoutes,
  };
}

function request(path: string, userId: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("x-frockbot-user-id", userId);
  return new Request(`https://frockbot.test${path}`, { ...init, headers });
}

describe("Cloudflare user application gateway", () => {
  test("uses an immutable user and application deployment id", () => {
    expect(
      applicationDeploymentId({
        userId: "alice",
        applicationHash: "sha256-abcd",
      }),
    ).toBe("alice:sha256-abcd");
    expect(() =>
      applicationDeploymentId({ userId: "../alice", applicationHash: "valid" }),
    ).toThrow("invalid user id");
  });

  test("selects each user's active immutable application", async () => {
    const { gateway, loader } = createTestGateway((userId) =>
      Promise.resolve(userId === "alice" ? "application-a" : "application-b"),
    );
    await gateway(request("/", "alice"));
    await gateway(request("/", "bob"));
    expect(loader.ids).toEqual(["alice:application-a", "bob:application-b"]);
  });

  test("reads and durably commands User and Bot settings before loading the app", async () => {
    const { gateway, loader, configurationRoutes } = createTestGateway();

    const initial = await gateway(
      request("/api/bots/primary/settings", "alice"),
    );
    expect(await initial.json()).toMatchObject({
      schemaVersion: 1,
      botId: "primary",
      revision: 0,
      notifications: { enabled: false },
    });

    const saved = await gateway(
      request("/api/bots/primary/settings", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "bot/update-profile",
          commandId: "profile-1",
          botId: "primary",
          expectedRevision: 0,
          profile: {
            name: "Housework",
            label: "Research, marketing, admin",
            description: "Keeps the household organized.",
          },
        }),
      }),
    );
    expect((await saved.json()) as OperationReceiptV1).toEqual({
      schemaVersion: 1,
      commandId: "profile-1",
      revision: 1,
      status: "applied",
    });

    const reloaded = await gateway(
      request("/api/bots/primary/settings", "alice"),
    );
    expect(await reloaded.json()).toMatchObject({
      revision: 1,
      profile: { name: "Housework" },
    });
    const initialUser = await gateway(request("/api/settings", "alice"));
    expect(await initialUser.json()).toMatchObject({ revision: 0 });
    const savedUser = await gateway(
      request("/api/settings", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "user/update-profile",
          commandId: "user-profile-1",
          expectedRevision: 0,
          profile: { name: "Alice" },
        }),
      }),
    );
    expect(await savedUser.json()).toMatchObject({
      commandId: "user-profile-1",
      status: "applied",
    });
    expect(configurationRoutes).toEqual([
      "bot:alice:primary",
      "bot:alice:primary",
      "bot:alice:primary",
      "user:alice",
      "user:alice",
    ]);
    expect(loader.ids).toEqual([]);
  });

  test("rejects invalid encoded Bot settings paths before configuration lookup", async () => {
    const { gateway, configurationRoutes } = createTestGateway();
    for (const botId of [
      "invalid%2Fbot",
      "%",
      "bad:bot",
      "bad@bot",
      "b".repeat(129),
    ]) {
      for (const method of ["GET", "POST"]) {
        const response = await gateway(
          request(`/api/bots/${botId}/settings`, "alice", { method }),
        );
        expect(response.status).toBe(400);
      }
    }
    expect(configurationRoutes).toEqual([]);
  });

  test("assigns a Connection only through an authenticated Bot command receipt", async () => {
    const { gateway } = createTestGateway();
    const assign = () =>
      gateway(
        request("/api/bots/primary/settings", "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            type: "bot/assign-capability",
            commandId: "assign-gmail-1",
            botId: "primary",
            expectedRevision: 0,
            assignment: {
              assignmentId: "gmail-primary",
              packageId: "composio",
              capabilityId: "gmail-tools",
              connectionId: "connection-gmail",
            },
          }),
        }),
      );

    expect((await (await assign()).json()) as OperationReceiptV1).toEqual({
      schemaVersion: 1,
      commandId: "assign-gmail-1",
      revision: 1,
      status: "applied",
    });
    expect((await (await assign()).json()) as OperationReceiptV1).toEqual({
      schemaVersion: 1,
      commandId: "assign-gmail-1",
      revision: 1,
      status: "applied",
    });
    const settings = await gateway(
      request("/api/bots/primary/settings", "alice"),
    );
    expect(await settings.json()).toMatchObject({
      revision: 1,
      assignments: [
        {
          assignmentId: "gmail-primary",
          connectionId: "connection-gmail",
          state: "enabled",
        },
      ],
    });
  });

  test("replays and acknowledges durable Bot notification intents", async () => {
    const { gateway, states } = createTestGateway();
    await gateway(request("/api/bots/primary/turns", "alice"));
    states.get("alice")?.notifications.set("primary", [
      {
        notificationId: "run-1",
        runId: "run-1",
        createdAt: "2026-08-28T01:00:00.000Z",
        title: "Housework replied",
        body: "Done.",
      },
    ]);

    const pending = await gateway(
      request("/api/bots/primary/notifications", "alice"),
    );
    expect(await pending.json()).toMatchObject({
      notifications: [{ notificationId: "run-1" }],
    });

    const acknowledged = await gateway(
      request("/api/bots/primary/notifications", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          action: "acknowledge",
          notificationId: "run-1",
        }),
      }),
    );
    expect(acknowledged.status).toBe(200);
    expect(states.get("alice")?.notifications.get("primary")).toEqual([]);
  });

  test("starts and verifies Composio Connections through the authenticated backend", async () => {
    const { gateway, connections } = createTestGateway();
    const started = await gateway(
      request("/api/plugins/composio/connections", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: "connection-command-1",
          connectionTypeId: "gmail",
          alias: "personal",
        }),
      }),
    );
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({
      connectionId: "connection-gmail",
      redirectUrl: "https://connect.composio.dev/link/test",
    });

    const callback = await gateway(
      request(
        "/api/plugins/composio/callback?connection=connection-gmail&connected_account_id=ca_123",
        "alice",
      ),
    );
    expect(callback.status).toBe(303);
    expect(connections.get("alice")?.completed).toEqual([
      { connectionId: "connection-gmail", connectedAccountId: "ca_123" },
    ]);
  });

  test("serves UI and agent behavior through the same user application", async () => {
    const { gateway, loader } = createTestGateway();

    const page = await gateway(request("/", "alice"));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-frockbot-user-id="alice"');
    expect(html).toContain('data-frockbot-user-application="foundation-v1"');
    const script = await gateway(request("/app.js", "alice"));
    expect(script.headers.get("content-type")).toContain("text/javascript");
    const stylesheet = await gateway(request("/app.css", "alice"));
    expect(stylesheet.headers.get("content-type")).toContain("text/css");

    const turn = await gateway(
      request("/api/bots/primary/turns", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          text: "/echo hello workers",
          commandId: "workers-turn-1",
        }),
      }),
    );
    expect(turn.status).toBe(200);
    const publicTurn: unknown = await turn.json();
    expect(decodeClientTurnV1(publicTurn)).toMatchObject({
      text: "Echo: hello workers",
      events: [
        { type: "tool/call", call: { name: "echo" } },
        { type: "tool/result", content: "hello workers" },
      ],
    });
    const wire = JSON.stringify(publicTurn);
    expect(Object.keys(publicTurn as Record<string, unknown>).sort()).toEqual([
      "events",
      "runId",
      "schemaVersion",
      "text",
    ]);
    expect(wire).not.toContain("model/request");
    expect(wire).not.toContain("input/queued");
    expect(wire).not.toContain('"input"');
    expect(new Set(loader.ids)).toEqual(new Set(["alice:foundation-v1"]));
    expect(loader.codes.every((code) => code.globalOutbound === null)).toBe(
      true,
    );
    expect(Object.keys(loader.codes[0]?.env ?? {}).sort()).toEqual([
      "BOT_STATE",
      "DEPLOYMENT",
    ]);
  });

  test("replays a duplicate Turn command without another model effect", async () => {
    const { gateway, states } = createTestGateway();
    const turn = () =>
      gateway(
        request("/api/bots/primary/turns", "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            text: "hello",
            commandId: "stable-turn-1",
          }),
        }),
      );

    const first = await turn();
    const second = await turn();

    expect(await first.json()).toEqual(await second.json());
    expect(
      (await states.get("alice")?.listRuns("primary", { schemaVersion: 1 }))
        ?.runs,
    ).toHaveLength(1);
  });

  test("shares the user deployment while isolating bot state", async () => {
    const { gateway, loader } = createTestGateway();
    for (const botId of ["alpha", "beta"]) {
      const response = await gateway(
        request(`/api/bots/${botId}/turns`, "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            text: `hello ${botId}`,
            commandId: `turn-${botId}`,
          }),
        }),
      );
      expect(response.status).toBe(200);
    }

    const alpha = await gateway(request("/api/bots/alpha/turns", "alice"));
    const beta = await gateway(request("/api/bots/beta/turns", "alice"));
    const alphaRuns = decodeClientRunListV1(await alpha.json());
    const betaRuns = decodeClientRunListV1(await beta.json());
    expect(alphaRuns).toHaveLength(1);
    expect(betaRuns).toHaveLength(1);
    expect(alphaRuns[0]?.input).toBe("hello alpha");
    expect(betaRuns[0]?.input).toBe("hello beta");
    expect(new Set(loader.ids)).toEqual(new Set(["alice:foundation-v1"]));
  });

  test("reads one admitted Turn without issuing another command", async () => {
    const { gateway, states } = createTestGateway();
    const admitted = await gateway(
      request("/api/bots/primary/turns", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          text: "hello",
          commandId: "lookup-turn-1",
        }),
      }),
    );
    expect(admitted.status).toBe(200);

    const response = await gateway(
      request("/api/bots/primary/turns/lookup-turn-1", "alice"),
    );

    expect(response.status).toBe(200);
    expect(decodeClientRunLookupV1(await response.json())).toMatchObject({
      state: "terminal",
      run: { runId: "lookup-turn-1", status: "completed" },
    });
    expect(states.get("alice")?.storedRuns("primary")).toHaveLength(1);
  });

  test("routes an authenticated Stop to the owning Bot and back", async () => {
    const { gateway, states } = createTestGateway();
    await gateway(
      request("/api/bots/primary/turns", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          text: "hello",
          commandId: "stop-turn-1",
        }),
      }),
    );

    const stop = (userId: string, body: unknown) =>
      gateway(
        request("/api/bots/primary/turns/stop-turn-1/stop", userId, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    const accepted = await stop("alice", {
      schemaVersion: 1,
      action: "stop",
      commandId: "stop-command-1",
      runId: "stop-turn-1",
    });
    expect(accepted.status).toBe(200);
    expect(decodeClientRunStopReceiptV1(await accepted.json())).toMatchObject({
      commandId: "stop-command-1",
      runId: "stop-turn-1",
    });
    expect(
      states.get("alice")?.storedRuns("primary")[0]?.stopRequestedAt,
    ).toBeString();

    // Another authenticated user reaches only their own isolated Bot state.
    const isolated = await stop("bob", {
      schemaVersion: 1,
      action: "stop",
      commandId: "stop-command-1",
      runId: "stop-turn-1",
    });
    expect(isolated.status).toBe(409);
    expect((await isolated.json()) as { error: string }).toEqual({
      error: 'run "stop-turn-1" was not admitted',
    });

    for (const invalid of [
      { schemaVersion: 1, action: "stop", commandId: "stop-command-2" },
      {
        schemaVersion: 1,
        action: "stop",
        commandId: "stop-command-2",
        runId: "other-run",
      },
      {
        schemaVersion: 2,
        action: "stop",
        commandId: "stop-command-2",
        runId: "stop-turn-1",
      },
    ]) {
      expect((await stop("alice", invalid)).status).toBe(400);
    }
  });

  test("returns only the versioned client run wire contract", async () => {
    const { gateway } = createTestGateway();
    await gateway(
      request("/api/bots/primary/turns", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          text: "hello",
          commandId: "wire-turn-1",
        }),
      }),
    );

    const response = await gateway(request("/api/bots/primary/turns", "alice"));
    const value = (await response.json()) as Record<string, unknown>;
    const runs = value.runs as Array<Record<string, unknown>>;

    expect(Object.keys(value).sort()).toEqual([
      "page",
      "runs",
      "schemaVersion",
    ]);
    expect(value.schemaVersion).toBe(1);
    expect(value.page).toEqual({ truncated: false });
    expect(Object.keys(runs[0] ?? {}).sort()).toEqual([
      "admittedAt",
      "events",
      "input",
      "outcome",
      "runId",
      "schemaVersion",
      "status",
    ]);
    const wire = JSON.stringify(value);
    for (const internalField of [
      "commandFingerprint",
      "sessionId",
      "configurationSnapshot",
      "phase",
      "previousEventCount",
      "deadline",
      "receipt",
    ]) {
      expect(wire).not.toContain(internalField);
    }
  });

  test("rehydrates one bot session across disposable application runtimes", async () => {
    const { gateway, states } = createTestGateway();
    const responses: BotTurnResult[] = [];
    for (const text of ["first turn", "second turn"]) {
      const response = await gateway(
        request("/api/bots/continuing/turns", "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            text,
            commandId: `turn-${responses.length + 1}`,
          }),
        }),
      );
      expect(response.status).toBe(200);
      responses.push((await response.json()) as BotTurnResult);
    }
    expect(responses.every((response) => response.schemaVersion === 1)).toBe(
      true,
    );
    expect(JSON.stringify(responses)).not.toContain("turn/start");
    const stored = states.get("alice")?.storedRuns("continuing") ?? [];
    expect(
      stored.map(
        (run) => run.events.find((event) => event.type === "turn/start")?.turn,
      ),
    ).toEqual([1, 2]);

    const history = await gateway(
      request("/api/bots/continuing/turns", "alice"),
    );
    const runs = decodeClientRunListV1(await history.json());
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.input)).toEqual(["first turn", "second turn"]);
    expect(runs.every((run) => run.status === "completed")).toBe(true);
  });

  test("separates different users and durably accepts before execution", async () => {
    const { gateway, loader, states } = createTestGateway();
    for (const userId of ["alice", "bob"]) {
      const response = await gateway(
        request("/api/bots/default/turns", userId, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            text: `hello ${userId}`,
            commandId: `turn-${userId}`,
          }),
        }),
      );
      expect(response.status).toBe(200);
    }

    expect(new Set(loader.ids)).toEqual(
      new Set(["alice:foundation-v1", "bob:foundation-v1"]),
    );
    const aliceRuns = states.get("alice")?.storedRuns("default");
    const bobRuns = states.get("bob")?.storedRuns("default");
    expect(aliceRuns?.[0]?.input).toBe("hello alice");
    expect(bobRuns?.[0]?.input).toBe("hello bob");
    expect(aliceRuns?.[0]?.events[0]?.type).toBe("session/created");
    expect(
      aliceRuns?.[0]?.events.findIndex(
        (event) => event.type === "model/request",
      ),
    ).toBeLessThan(
      aliceRuns?.[0]?.events.findIndex(
        (event) => event.type === "assistant/message",
      ) ?? -1,
    );
  });

  test("persists the browser development identity from the query seam", async () => {
    const { gateway } = createTestGateway();
    const page = await gateway(
      new Request("https://frockbot.test/?as_user=alice"),
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toContain("frockbot_dev_user=alice");
    const script = await gateway(
      new Request("https://frockbot.test/app.js", {
        headers: { cookie: "frockbot_dev_user=alice" },
      }),
    );
    expect(script.status).toBe(200);
  });

  test("consumes the development identity before strict hosted query decoding", async () => {
    const { gateway, loader } = createTestGateway();
    const response = await gateway(
      new Request(
        "https://frockbot.test/api/bots/default/turns?as_user=mobile-development",
      ),
    );

    expect(response.status).toBe(200);
    expect(decodeClientRunListV1(await response.json())).toEqual([]);
    expect(loader.ids).toEqual(["mobile-development:foundation-v1"]);
  });

  test("serves the public shell but rejects unauthenticated application APIs", async () => {
    const { gateway } = createTestGateway();
    const page = await gateway(new Request("https://frockbot.test/"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-frockbot-user-id="anonymous"');

    const response = await gateway(
      new Request("https://frockbot.test/api/bots/default/turns"),
    );
    expect(response.status).toBe(401);
  });

  test("ignores development identity headers unless explicitly enabled", async () => {
    const { gateway } = createTestGateway(
      undefined,
      unauthenticatedAuth,
      false,
    );
    const response = await gateway(request("/api/bots/default/turns", "alice"));
    expect(response.status).toBe(401);
  });

  test("mounts Better Auth routes before application routing", async () => {
    const { gateway, loader } = createTestGateway();
    const response = await gateway(
      new Request("https://frockbot.test/api/auth/get-session"),
    );
    expect(await response.text()).toBe("auth handler");
    expect(loader.ids).toEqual([]);
  });

  test("derives the application identity from the Better Auth session", async () => {
    const auth: GatewayAuth = {
      handler: unauthenticatedAuth.handler,
      getSession: () => Promise.resolve({ user: { id: "signed-in-user" } }),
    };
    const { gateway, loader } = createTestGateway(undefined, auth);
    const response = await gateway(new Request("https://frockbot.test/"));
    expect(response.status).toBe(200);
    expect(loader.ids).toEqual(["signed-in-user:foundation-v1"]);
  });

  test("projects authenticated identity through the hosted transport seam", async () => {
    const auth: GatewayAuth = {
      handler: unauthenticatedAuth.handler,
      getSession: () => Promise.resolve({ user: { id: "signed-in-user" } }),
    };
    const { gateway, loader } = createTestGateway(undefined, auth);

    const response = await gateway(
      new Request("https://frockbot.test/api/identity"),
    );

    expect(response.status).toBe(200);
    const identity: unknown = await response.json();
    expect(identity).toEqual({
      schemaVersion: 1,
      userId: "signed-in-user",
    });
    expect(loader.ids).toEqual([]);
  });
});

const MOBILE_ORIGIN = "capacitor://localhost";

const rejectingAuth: GatewayAuth = {
  handler: () => Promise.reject(new Error("auth handler was invoked")),
  getSession: () => Promise.reject(new Error("session was resolved")),
};

const bearerAuth: GatewayAuth = {
  handler: () =>
    Promise.resolve(
      new Response("auth handler", {
        headers: { "set-auth-token": "test-token" },
      }),
    ),
  getSession: (headers) =>
    Promise.resolve(
      headers.get("authorization") === "Bearer test-token"
        ? { user: { id: "mobile-user" } }
        : null,
    ),
};

function mobileRequest(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("origin", MOBILE_ORIGIN);
  return new Request(`https://frockbot.test${path}`, { ...init, headers });
}

describe("Cross-origin access for mobile clients", () => {
  test("answers preflight for allowed origins without touching auth", async () => {
    const { gateway, loader } = createTestGateway(
      undefined,
      rejectingAuth,
      false,
      [MOBILE_ORIGIN],
    );
    const response = await gateway(
      mobileRequest("/api/bots/primary/turns", { method: "OPTIONS" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      MOBILE_ORIGIN,
    );
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, OPTIONS",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type",
    );
    expect(response.headers.get("access-control-max-age")).toBe("600");
    expect(response.headers.get("vary")).toBe("origin");
    expect(loader.ids).toEqual([]);
  });

  test("denies cross-origin sharing to origins outside the allow list", async () => {
    const { gateway } = createTestGateway(
      undefined,
      unauthenticatedAuth,
      false,
      [MOBILE_ORIGIN],
    );
    const preflight = await gateway(
      new Request("https://frockbot.test/api/bots/primary/turns", {
        method: "OPTIONS",
        headers: { origin: "https://attacker.test" },
      }),
    );
    expect(preflight.status).toBe(401);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("vary")).toBeNull();
  });

  test("shares authenticated bearer turns with the mobile origin", async () => {
    const { gateway, loader } = createTestGateway(
      undefined,
      bearerAuth,
      false,
      [MOBILE_ORIGIN],
    );
    const response = await gateway(
      mobileRequest("/api/bots/primary/turns", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          text: "/echo hello mobile",
          commandId: "mobile-turn-1",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: "Echo: hello mobile" });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      MOBILE_ORIGIN,
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "set-auth-token",
    );
    expect(response.headers.get("vary")).toBe("origin");
    expect(loader.ids).toEqual(["mobile-user:foundation-v1"]);
  });

  test("shares rejections so the mobile client can read the status", async () => {
    const { gateway } = createTestGateway(undefined, bearerAuth, false, [
      MOBILE_ORIGIN,
    ]);
    const response = await gateway(mobileRequest("/api/bots/primary/turns"));
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      MOBILE_ORIGIN,
    );
    expect(response.headers.get("vary")).toBe("origin");
  });

  test("exposes the sign-in token header from Better Auth routes", async () => {
    const { gateway } = createTestGateway(undefined, bearerAuth, false, [
      MOBILE_ORIGIN,
    ]);
    const response = await gateway(
      mobileRequest("/api/auth/sign-in/social", { method: "POST" }),
    );
    expect(response.headers.get("set-auth-token")).toBe("test-token");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      MOBILE_ORIGIN,
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "set-auth-token",
    );
  });

  test("leaves same-origin and asset requests unchanged", async () => {
    const { gateway } = createTestGateway(undefined, bearerAuth, false, [
      MOBILE_ORIGIN,
    ]);
    const page = await gateway(new Request("https://frockbot.test/"));
    expect(page.status).toBe(200);
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    expect(page.headers.get("vary")).toBeNull();

    const asset = await gateway(mobileRequest("/app.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("carries no cross-origin headers when none are configured", async () => {
    const { gateway } = createTestGateway(undefined, bearerAuth, false);
    const response = await gateway(
      mobileRequest("/api/bots/primary/turns", { method: "OPTIONS" }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("authenticates bearer sessions through the identity seam", async () => {
    const { gateway, loader } = createTestGateway(undefined, bearerAuth, false);
    const rejected = await gateway(
      new Request("https://frockbot.test/api/bots/primary/turns"),
    );
    expect(rejected.status).toBe(401);
    expect(loader.ids).toEqual([]);

    const accepted = await gateway(
      new Request("https://frockbot.test/api/bots/primary/turns", {
        headers: { authorization: "Bearer test-token" },
      }),
    );
    expect(accepted.status).toBe(200);
    expect(loader.ids).toEqual(["mobile-user:foundation-v1"]);
  });
});
