import { describe, expect, test } from "bun:test";
import {
  compileFoundationApplication,
  compileFoundationApplicationDeclarations,
  createFoundationAssignedRuntimePackages,
  mergeFoundationRuntimePackages,
  createFoundationBackendContributions,
  createFoundationHostedRuntimePackages,
  createFoundationModelRuntimePackage,
  createFoundationRuntimeApplication,
  isUserInstallablePackageV1,
} from "./runtime.js";
import { Context, type Plugin } from "cordis";
import { resolveFoundationTrustedDesktopContribution } from "./desktop.js";

describe("foundation application", () => {
  test("resolves trusted desktop declarations without asynchronous startup work", () => {
    const declarations = compileFoundationApplicationDeclarations();
    expect(
      resolveFoundationTrustedDesktopContribution(declarations, "auth"),
    ).toMatchObject({
      packageId: "auth",
      contributionSpecifier: "@frockbot/plugin-auth/desktop",
    });
  });

  test("compiles one deterministic package graph for every contribution kind", async () => {
    const first = await compileFoundationApplication();
    const second = await compileFoundationApplication();

    expect(first.applicationHash).toBe(second.applicationHash);
    expect(first.packages.map((pkg) => pkg.id)).toEqual([
      "ui-theme",
      "shell",
      "flock",
      "audit",
      "auth",
      "authoring",
      "settings",
      "bot-template",
      "clock",
      "computer",
      "credentials",
      "desktop-clipboard",
      "desktop-directory-picker",
      "desktop-notifications",
      "echo",
      "fly-sprite",
      "identity",
      "image",
      "user-machine",
      "machine-messages",
      "mcp",
      "memory",
      "mobile-clipboard",
      "mobile-notifications",
      "package-publisher",
      "provider-foundation",
      "web",
      "provider-ollama-cloud",
      "routines",
      "search",
      "skills",
      "subagents",
    ]);
    expect(first.contributions).toEqual({
      backend: [
        "shell",
        "flock",
        "audit",
        "settings",
        "bot-template",
        "credentials",
        "user-machine",
        "mcp",
        "package-publisher",
        "provider-ollama-cloud",
        "routines",
        "search",
        "subagents",
      ],
      runtime: [
        "shell",
        "flock",
        "authoring",
        "bot-template",
        "clock",
        "computer",
        "credentials",
        "echo",
        "fly-sprite",
        "identity",
        "image",
        "user-machine",
        "machine-messages",
        "mcp",
        "memory",
        "package-publisher",
        "provider-foundation",
        "web",
        "provider-ollama-cloud",
        "routines",
        "skills",
        "subagents",
      ],
      client: [
        "ui-theme",
        "shell",
        "flock",
        "audit",
        "auth",
        "settings",
        "bot-template",
        "clock",
        "computer",
        "user-machine",
        "package-publisher",
        "routines",
        "search",
      ],
      desktop: [
        "auth",
        "clock",
        "desktop-clipboard",
        "desktop-directory-picker",
        "desktop-notifications",
        "fly-sprite",
        "user-machine",
      ],
      mobile: ["mobile-clipboard", "mobile-notifications"],
    });
    expect(
      first.packages.find((pkg) => pkg.id === "shell")?.manifest.contributions
        .backend,
    ).toEqual([{ entry: "./backend", host: "bot" }]);
    expect(
      first.packages.find((pkg) => pkg.id === "settings")?.manifest
        .contributions.backend,
    ).toEqual([
      { entry: "./backend", host: "gateway" },
      { entry: "./user", host: "user" },
    ]);
    expect(first.packages.some((pkg) => pkg.id === "composio")).toBe(false);
  });

  test("mounts an assigned Ollama model through its Package runtime Contribution", async () => {
    const plan = await compileFoundationApplication();
    const runtimePackage = createFoundationModelRuntimePackage(
      plan,
      {
        assignment: {
          connectionId: "ollama-work",
          providerModelId: "glm-5.3-flash:cloud",
        },
        state: "ready",
        packageId: "provider-ollama-cloud",
        providerType: "ollama-cloud",
        connection: {
          connectionId: "ollama-work",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          displayName: "Work",
          state: "ready",
          providerType: "ollama-cloud",
          safeMetadata: {},
        },
      },
      {
        accountId: "account-1",
        connectionId: "ollama-work",
        leaseCredential: () => Promise.reject(new Error("not executed")),
        settleCredential: () => Promise.resolve(),
      },
    );

    expect(runtimePackage).toMatchObject({
      specifier: "@frockbot/plugin-provider-ollama-cloud",
      contributionSpecifier: "@frockbot/plugin-provider-ollama-cloud/runtime",
    });
    expect(() =>
      createFoundationModelRuntimePackage(
        plan,
        {
          assignment: {
            connectionId: "ollama-work",
            providerModelId: "glm-5.3-flash:cloud",
          },
          state: "ready",
          packageId: "provider-ollama-cloud",
          providerType: "foundation",
          connection: {
            connectionId: "ollama-work",
            packageId: "provider-ollama-cloud",
            connectionTypeId: "ollama-cloud-account",
            displayName: "Work",
            state: "ready",
            providerType: "foundation",
            safeMetadata: {},
          },
        },
        {
          accountId: "account-1",
          connectionId: "ollama-work",
          leaseCredential: () => Promise.reject(new Error("not executed")),
          settleCredential: () => Promise.resolve(),
        },
      ),
    ).toThrow('Bot model provider "foundation" is unavailable');
  });

  test("exposes only compiled runtime packages to the runtime host", async () => {
    const application = await createFoundationRuntimeApplication();

    // Memory is absent: like Skills, it mounts only for a Turn whose Memory
    // roots the host can reach, so it is never a default runtime package.
    expect(application.packages.map((pkg) => pkg.manifest)).toHaveLength(5);
    expect(application.packages.map((pkg) => pkg.specifier)).toEqual([
      // The Shell contributes the user-facing send tool and the parent
      // hand-off, and needs no host to do it.
      "@frockbot/plugin-shell",
      "@frockbot/plugin-clock",
      "@frockbot/plugin-echo",
      "@frockbot/plugin-identity",
      "@frockbot/plugin-provider-foundation",
    ]);
  });

  test("offers every Package a User can install, and not the shell", async () => {
    const plan = await compileFoundationApplication();
    const listed = plan.packages
      .filter((pkg) => isUserInstallablePackageV1(pkg.manifest))
      .map((pkg) => pkg.id);

    // The application mounts its own shell: the User never chose it, cannot
    // uninstall it, and assigns nothing from it.
    expect(listed).not.toContain("shell");
    // Everything the Plugins surface can install or assign today survives —
    // including Flock and Routines, whose only Capability is a tool that takes
    // no Connection, which is the shape a tool Package has.
    for (const packageId of [
      "flock",
      "routines",
      "provider-ollama-cloud",
      "package-publisher",
      "settings",
      "clock",
      "memory",
    ]) {
      expect(listed).toContain(packageId);
    }
    // Exactly one Package is held back, so the rule is not quietly hiding
    // anything else.
    expect(
      plan.packages.map((pkg) => pkg.id).filter((id) => !listed.includes(id)),
    ).toEqual(["shell"]);
  });

  test("keys installability on the application root slot, not on Connections", () => {
    const client = (slots: string[]) => ({
      contributions: {
        client: { mounts: slots.map((slot) => ({ slot })) },
      },
    });

    // A tool Package with no client Contribution at all, which is what a
    // connection-less tool Package looks like.
    expect(isUserInstallablePackageV1({ contributions: {} })).toBe(true);
    expect(isUserInstallablePackageV1(client([]))).toBe(true);
    expect(isUserInstallablePackageV1(client(["frockbot.sidebar-bots"]))).toBe(
      true,
    );
    expect(isUserInstallablePackageV1(client(["authenticated-root"]))).toBe(
      false,
    );
  });

  test("resolves trusted desktop code only from the compiled declaration", async () => {
    const plan = await compileFoundationApplication();
    expect(
      resolveFoundationTrustedDesktopContribution(plan, "auth"),
    ).toMatchObject({
      packageId: "auth",
      contributionSpecifier: "@frockbot/plugin-auth/desktop",
    });

    expect(() =>
      resolveFoundationTrustedDesktopContribution(
        {
          ...plan,
          contributions: {
            ...plan.contributions,
            desktop: plan.contributions.desktop.filter((id) => id !== "auth"),
          },
        },
        "auth",
      ),
    ).toThrow('foundation desktop package "auth" is not declared');
  });

  test("resolves declared backend and assigned runtime Contributions through host seams", async () => {
    const plan = await compileFoundationApplication();
    const backend = await createFoundationBackendContributions(plan, {
      backendHost: "gateway",
      listBots: () =>
        Promise.resolve({ schemaVersion: 1, revision: 0, bots: [] }),
      listTemplateShares: () =>
        Promise.resolve({ schemaVersion: 1 as const, shares: [] }),
      executeTemplateCommand: () =>
        Promise.reject(new Error("not used while composing")),
      readPublishedTemplate: () => Promise.resolve(undefined),
      listTemplateImports: () =>
        Promise.resolve({ schemaVersion: 1 as const, imports: [] }),
      executeTemplateImport: () =>
        Promise.reject(new Error("not used while composing")),
      createBot: () =>
        Promise.resolve({
          schemaVersion: 1,
          commandId: "test",
          status: "applied",
          revision: 1,
        }),
      listBotLifecycles: () =>
        Promise.resolve({ schemaVersion: 1, lifecycles: [] }),
      executeBotLifecycle: () =>
        Promise.reject(new Error("not used while composing")),
      readMcpServers: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          servers: [],
          refusals: [],
          quotas: {
            maxServers: 16,
            maxToolsPerServer: 64,
            maxResponseBytes: 262_144,
          },
        }),
      executeMcpCommand: () =>
        Promise.reject(new Error("not used while composing")),
      readSheep: () => Promise.reject(new Error("not used while composing")),
      updateSheep: () => Promise.reject(new Error("not used while composing")),
      listBotIdentities: () =>
        Promise.resolve({ schemaVersion: 1 as const, identities: [] }),
      searchTranscripts: () =>
        Promise.reject(new Error("not used while composing")),
      rebuildSearchIndex: () =>
        Promise.reject(new Error("not used while composing")),
      readAudit: () => Promise.reject(new Error("not used while composing")),
      rebuildAuditIndex: () =>
        Promise.reject(new Error("not used while composing")),
      listBotUnread: () =>
        Promise.resolve({ schemaVersion: 1 as const, unread: [] }),
      listBotNotifications: () =>
        Promise.resolve({ schemaVersion: 1 as const, notifications: [] }),
      executeBotUnreadCommand: () =>
        Promise.reject(new Error("not used while composing")),
      readBotAvatar: () => Promise.resolve(undefined),
      uploadBotAvatar: () =>
        Promise.reject(new Error("not used while composing")),
      executeConnection: () =>
        Promise.reject(new Error("not used while composing")),
      lookupConnectionCommand: () =>
        Promise.reject(new Error("not used while composing")),
      listCompositionGenerations: () =>
        Promise.reject(new Error("not used while composing")),
      getCompositionGeneration: () =>
        Promise.reject(new Error("not used while composing")),
      revertComposition: () =>
        Promise.reject(new Error("not used while composing")),
      read: () =>
        Promise.resolve({ schemaVersion: 1, revision: 0, revisions: [] }),
      rollback: () => Promise.reject(new Error("not used while composing")),
      listRoutines: () => Promise.reject(new Error("not used while composing")),
      executeRoutineCommand: () =>
        Promise.reject(new Error("not used while composing")),
      deliverRoutineHook: () =>
        Promise.reject(new Error("not used while composing")),
      listRoutineRuns: () =>
        Promise.reject(new Error("not used while composing")),
      readRoutineRun: () =>
        Promise.reject(new Error("not used while composing")),
      listRoutineInbox: () =>
        Promise.reject(new Error("not used while composing")),
      executeRoutineInboxCommand: () =>
        Promise.reject(new Error("not used while composing")),
      listTasks: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          botId: "bot",
          active: 0,
          tasks: [],
        }),
      createMachinePairing: () =>
        Promise.reject(new Error("not used while composing")),
      enrollMachine: () =>
        Promise.reject(new Error("not used while composing")),
      pollMachine: () => Promise.reject(new Error("not used while composing")),
      claimMachineCommand: () =>
        Promise.reject(new Error("not used while composing")),
      recordMachineResult: () =>
        Promise.reject(new Error("not used while composing")),
      listMachines: () => Promise.reject(new Error("not used while composing")),
      revokeMachine: () =>
        Promise.reject(new Error("not used while composing")),
      readTask: () => Promise.reject(new Error("not used while composing")),
      stopTask: () => Promise.reject(new Error("not used while composing")),
    });
    expect(
      backend.contributions
        .map((contribution) => contribution.packageId)
        .sort(),
    ).toEqual([
      "audit",
      "bot-template",
      "flock",
      "mcp",
      "package-publisher",
      "routines",
      "search",
      "settings",
      "subagents",
      "user-machine",
    ]);
    interface TestContribution {
      specifier: string;
      executeConfiguration?(): void;
      startConnection?(): void;
    }
    const botBackend =
      await createFoundationBackendContributions<TestContribution>(plan, {
        backendHost: "bot",
        resolve: (specifier, lifecycle) => () =>
          lifecycle.mount({ specifier, executeConfiguration() {} }),
      });
    const userBackend =
      await createFoundationBackendContributions<TestContribution>(plan, {
        backendHost: "user",
        resolve: (specifier, lifecycle) => () =>
          lifecycle.mount({ specifier, startConnection() {} }),
      });
    expect(botBackend.contributions).toHaveLength(2);
    expect(userBackend.contributions).toHaveLength(10);
    const userSpecifiers = userBackend.contributions.map(
      (contribution) => contribution.specifier,
    );
    expect(
      userSpecifiers.indexOf("@frockbot/plugin-settings/user"),
    ).toBeLessThan(
      userSpecifiers.indexOf("@frockbot/plugin-provider-ollama-cloud/user"),
    );
    expect(
      userSpecifiers.indexOf("@frockbot/plugin-credentials/user"),
    ).toBeLessThan(
      userSpecifiers.indexOf("@frockbot/plugin-provider-ollama-cloud/user"),
    );
    expect(typeof botBackend.contributions[0]?.executeConfiguration).toBe(
      "function",
    );
    expect(typeof userBackend.contributions[0]?.startConnection).toBe(
      "function",
    );
    await Promise.all([
      backend.dispose(),
      botBackend.dispose(),
      userBackend.dispose(),
    ]);
    expect(backend.contributions).toHaveLength(0);
    expect(botBackend.contributions).toHaveLength(0);
    expect(userBackend.contributions).toHaveLength(0);
    const requestedSecrets: string[] = [];
    expect(
      createFoundationHostedRuntimePackages(plan, {
        userId: "user-1",
        readSecret: (name) => {
          requestedSecrets.push(name);
          return undefined;
        },
        computerHost: {
          effect: () => Promise.reject(new Error("not invoked while mounting")),
        },
        packagePublisher: {
          read: () =>
            Promise.resolve({ schemaVersion: 1, revision: 0, revisions: [] }),
          publish: () => Promise.reject(new Error("not used while composing")),
          rollback: () => Promise.reject(new Error("not used while composing")),
        },
      }).map((pkg) => pkg.specifier),
    ).toEqual([
      "@frockbot/plugin-credentials",
      "@frockbot/plugin-package-publisher",
      "@frockbot/plugin-fly-sprite",
      "@frockbot/plugin-computer",
    ]);
    expect(requestedSecrets).toEqual(["SPRITES_TOKEN"]);

    // The Skills Package mounts only for a Turn whose instruction root the
    // host can read, and then it leads the hosted runtime packages.
    expect(
      createFoundationHostedRuntimePackages(plan, {
        userId: "user-1",
        readSecret: () => undefined,
        skills: {
          owner: { userId: "user-1", botId: "bot-1" },
          reads: {
            read: () => Promise.resolve({ status: "not-found", reason: "n/a" }),
            stat: () => Promise.resolve({ status: "not-found", reason: "n/a" }),
            list: () => Promise.resolve({ status: "ok", entries: [] }),
          },
        },
        packagePublisher: {
          read: () =>
            Promise.resolve({ schemaVersion: 1, revision: 0, revisions: [] }),
          publish: () => Promise.reject(new Error("not used while composing")),
          rollback: () => Promise.reject(new Error("not used while composing")),
        },
      }).map((pkg) => pkg.specifier),
    ).toEqual([
      "@frockbot/plugin-skills",
      "@frockbot/plugin-credentials",
      "@frockbot/plugin-package-publisher",
      "@frockbot/plugin-fly-sprite",
      "@frockbot/plugin-computer",
    ]);

    const assignment = {
      assignmentId: "unavailable-assignment",
      packageId: "composio",
      capabilityId: "gmail-tools",
      connectionId: "connection-1",
      state: "enabled" as const,
    };
    const runtime = await createFoundationAssignedRuntimePackages(
      plan,
      {
        schemaVersion: 1,
        botId: "primary",
        revision: 1,
        profile: { name: "Primary" },
        notifications: { enabled: false },
        assignments: [assignment],
        assignmentOperations: [],
      },
      {
        schemaVersion: 1,
        botId: "primary",
        revision: 1,
        assignments: [assignment],
      },
      {
        userId: "user-1",
        readSecret: () => undefined,
        authorizeConnection: () =>
          Promise.reject(new Error("unavailable Package must not authorize")),
      },
    );
    expect(runtime).toEqual([]);
  });
});

describe("merging runtime Contributions that share a specifier", () => {
  test("mounts every one of them, in order, under one Contribution", async () => {
    const mounted: string[] = [];
    const pkg = (name: string) => ({
      specifier: "@frockbot/plugin-mcp",
      contributionSpecifier: "@frockbot/plugin-mcp/agent",
      manifest: {},
      plugin: (() => {
        mounted.push(name);
      }) as Plugin,
    });
    const merged = mergeFoundationRuntimePackages([
      pkg("lifecycle"),
      pkg("server-1"),
      pkg("server-2"),
      {
        specifier: "@frockbot/plugin-echo",
        contributionSpecifier: "@frockbot/plugin-echo/agent",
        manifest: {},
        plugin: (() => {
          mounted.push("echo");
        }) as Plugin,
      },
    ]);

    // One entry per Contribution: the runtime resolves a Package's runtime
    // entry to exactly one Plugin, so a second entry would be lost silently.
    expect(merged).toHaveLength(2);
    const root = new Context();
    try {
      for (const entry of merged) await root.plugin(entry.plugin);
      expect(mounted).toEqual(["lifecycle", "server-1", "server-2", "echo"]);
    } finally {
      await root.fiber.dispose();
    }
  });
});
