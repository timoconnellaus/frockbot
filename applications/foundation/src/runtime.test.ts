import { describe, expect, test } from "bun:test";
import {
  compileFoundationApplication,
  compileFoundationApplicationDeclarations,
  createFoundationEnabledRuntimePackages,
  mergeFoundationRuntimePackages,
  createFoundationBackendContributions,
  createFoundationHostedRuntimePackages,
  createFoundationModelRuntimePackage,
  createFoundationRuntimeApplication,
  isPlatformOwnedPackageV1,
  isUserInstallablePackageV1,
} from "./runtime.js";
import { Context, type Plugin } from "cordis";
import { resolveFoundationTrustedDesktopContribution } from "./desktop.js";
import { foundationDefaultPackageIds } from "./user.js";

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
      "admin",
      "applets",
      "flock",
      "audit",
      "auth",
      "authoring",
      "settings",
      "billing",
      "bot-template",
      "clock",
      "computer",
      "credentials",
      "custom-models",
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
      "package-catalog",
      "package-publisher",
      "provider-flock-ai",
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
        "admin",
        "flock",
        "audit",
        "settings",
        "billing",
        "bot-template",
        "computer",
        "credentials",
        "user-machine",
        "mcp",
        "package-publisher",
        "provider-flock-ai",
        "provider-ollama-cloud",
        "routines",
        "search",
        "subagents",
      ],
      runtime: [
        "shell",
        "applets",
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
        "package-catalog",
        "package-publisher",
        "provider-flock-ai",
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
        "admin",
        "applets",
        "flock",
        "audit",
        "auth",
        "settings",
        "billing",
        "bot-template",
        "computer",
        "custom-models",
        "user-machine",
        "package-publisher",
        "routines",
        "search",
      ],
      desktop: [
        "auth",
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

  test("seeds a default-disabled Package and its dependencies", async () => {
    const plan = await compileFoundationApplication();
    const packageIds = foundationDefaultPackageIds(plan);

    expect(packageIds.has("custom-models")).toBe(true);
    expect(packageIds.has("settings")).toBe(true);
    expect(packageIds.has("shell")).toBe(true);
    expect(packageIds.has("ui-theme")).toBe(true);
    expect(
      plan.packages.find((pkg) => pkg.id === "custom-models")?.manifest
        .defaultEnablement,
    ).toBe("disabled");
  });

  test("mounts an enabled Ollama model through its Package runtime Contribution", async () => {
    const plan = await compileFoundationApplication();
    const runtimePackage = createFoundationModelRuntimePackage(
      plan,
      {
        model: {
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
          model: {
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

  test("mounts an enabled Frock AI model through the gateway host seam", async () => {
    const plan = await compileFoundationApplication();
    const runtimePackage = createFoundationModelRuntimePackage(
      plan,
      {
        model: {
          connectionId: "flock-ai-ambient",
          providerModelId: "@frock/auto",
        },
        state: "ready",
        packageId: "provider-flock-ai",
        providerType: "flock-ai",
        connection: {
          connectionId: "flock-ai-ambient",
          packageId: "provider-flock-ai",
          connectionTypeId: "flock-ai-account",
          displayName: "Frock AI",
          state: "ready",
          generation: "flock-ai-ambient-v1",
          providerType: "flock-ai",
          safeMetadata: {},
        },
      },
      {
        accountId: "account-1",
        connectionId: "flock-ai-ambient",
        frockAiAutoRoute: "flock-auto",
        runFrockAiChatCompletion: () =>
          Promise.reject(new Error("not executed")),
      },
    );

    expect(runtimePackage).toMatchObject({
      specifier: "@frockbot/plugin-provider-frock-ai",
      contributionSpecifier: "@frockbot/plugin-provider-frock-ai/runtime",
    });
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

  test("offers only Packages whose enablement is a User choice", async () => {
    const plan = await compileFoundationApplication();
    const listed = plan.packages
      .filter((pkg) => isUserInstallablePackageV1(pkg.manifest))
      .map((pkg) => pkg.id);

    expect(listed).toEqual([
      "flock",
      "bot-template",
      "custom-models",
      "image",
      "user-machine",
      "machine-messages",
      "mcp",
      "web",
      "provider-ollama-cloud",
      "routines",
      "subagents",
    ]);
    expect(listed).not.toContain("shell");
    expect(listed).not.toContain("provider-flock-ai");
  });

  test("derives platform ownership from application-root, control, and ambient-model facts", async () => {
    const plan = await compileFoundationApplication();
    const defaultPackageIds = foundationDefaultPackageIds(plan);
    const manifest = (packageId: string) =>
      plan.packages.find((pkg) => pkg.id === packageId)!.manifest;

    const platformOwned = (packageId: string) =>
      isPlatformOwnedPackageV1(
        manifest(packageId),
        defaultPackageIds.has(packageId),
      );
    expect(platformOwned("shell")).toBe(true);
    expect(platformOwned("settings")).toBe(true);
    expect(platformOwned("provider-flock-ai")).toBe(true);
    expect(platformOwned("billing")).toBe(true);
    expect(platformOwned("custom-models")).toBe(false);
    expect(platformOwned("web")).toBe(false);
    expect(platformOwned("provider-ollama-cloud")).toBe(false);
    // Audit has no User control, but it is not a default installation. It is
    // statically mounted rather than repaired into User enablement state.
    expect(platformOwned("audit")).toBe(false);
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

  test("resolves declared backend and enabled runtime Contributions through host seams", async () => {
    const plan = await compileFoundationApplication();
    const backend = await createFoundationBackendContributions(plan, {
      backendHost: "gateway",
      readDeploymentPolicy: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          revision: 0,
          signups: { open: false },
          updatedAt: "2026-09-01T00:00:00.000Z",
          updatedBy: "deployment-default",
        }),
      setDeploymentSignups: () =>
        Promise.reject(new Error("not used while composing")),
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
      readComputer: () =>
        Promise.resolve({
          version: 1 as const,
          botId: "bot",
          providerLabel: "Fake Computer",
          phase: "idle" as const,
          message: "Persistent Computer available",
          screenshots: [],
        }),
      executeComputerCommand: () =>
        Promise.reject(new Error("not used while composing")),
      searchTranscripts: () =>
        Promise.reject(new Error("not used while composing")),
      rebuildSearchIndex: () =>
        Promise.reject(new Error("not used while composing")),
      readAudit: () => Promise.reject(new Error("not used while composing")),
      readUsage: () => Promise.reject(new Error("not used while composing")),
      readBilling: () => Promise.reject(new Error("not used while composing")),
      applyStripeEvent: () =>
        Promise.reject(new Error("not used while composing")),
      prepareStripeCommand: () =>
        Promise.reject(new Error("not used while composing")),
      recordStripeCustomer: () =>
        Promise.reject(new Error("not used while composing")),
      completeStripeCommand: () =>
        Promise.reject(new Error("not used while composing")),
      rebuildAuditIndex: () =>
        Promise.reject(new Error("not used while composing")),
      listBotUnread: () =>
        Promise.resolve({ schemaVersion: 1 as const, unread: [] }),
      listBotNotifications: () =>
        Promise.resolve({ schemaVersion: 1 as const, notifications: [] }),
      executeBotUnreadCommand: () =>
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
      "admin",
      "audit",
      "billing",
      "bot-template",
      "computer",
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
    expect(botBackend.contributions).toHaveLength(3);
    expect(userBackend.contributions).toHaveLength(12);
    const userSpecifiers = userBackend.contributions.map(
      (contribution) => contribution.specifier,
    );
    expect(
      userSpecifiers.indexOf("@frockbot/plugin-settings/user"),
    ).toBeLessThan(
      userSpecifiers.indexOf("@frockbot/plugin-provider-ollama-cloud/user"),
    );
    expect(
      userSpecifiers.indexOf("@frockbot/plugin-settings/user"),
    ).toBeLessThan(
      userSpecifiers.indexOf("@frockbot/plugin-provider-frock-ai/user"),
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

    const capability = {
      packageId: "composio",
      capabilityId: "gmail-tools",
      kind: "tool" as const,
      connectionId: "connection-1",
    };
    const runtime = await createFoundationEnabledRuntimePackages(
      plan,
      {
        schemaVersion: 1,
        botId: "primary",
        revision: 1,
        capabilities: [capability],
      },
      {
        userId: "user-1",
        readSecret: () => undefined,
        authorizeConnection: () =>
          Promise.reject(new Error("unavailable Package must not authorize")),
      },
    );
    expect(runtime).toEqual([]);

    const webCapability = {
      packageId: "web",
      capabilityId: "web-fetch",
      kind: "tool" as const,
    };
    const freshBotRuntime = await createFoundationEnabledRuntimePackages(
      plan,
      {
        schemaVersion: 1,
        botId: "fresh",
        revision: 0,
        capabilities: [webCapability],
      },
      {
        userId: "user-1",
        readSecret: () => undefined,
        authorizeConnection: () =>
          Promise.reject(
            new Error("connection-less Web Capability must not authorize"),
          ),
      },
    );
    expect(freshBotRuntime.map((pkg) => pkg.specifier)).toEqual([
      "@frockbot/plugin-web",
    ]);
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
