import { describe, expect, test } from "bun:test";
import {
  createFoundationEnabledRuntimePackages,
  createFoundationBackendContributions,
  createFoundationHostedRuntimePackages,
  createFoundationModelRuntimePackage,
  foundationBaseRuntimePackagesV1,
  FOUNDATION_PACKAGES_V1,
  foundationPackageV1,
} from "./runtime.js";
import { foundationDefaultPackageIds } from "./user.js";

describe("foundation application", () => {
  test("lists every Package this deployment ships, once", () => {
    const ids = FOUNDATION_PACKAGES_V1.map((pkg) => pkg.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "ui-theme",
      "auth",
      "admin",
      "identity",
      "provider-foundation",
      "skills",
      "echo",
      "shell",
      "settings",
      "custom-models",
      "routines",
      "credentials",
      "web",
      "provider-ollama-cloud",
      "provider-flock-ai",
      "provider-anthropic",
      "flock",
      "bot-template",
      "search",
      "audit",
      "clock",
      "memory",
      "image",
      "computer",
      "computer-host",
      "user-machine",
      "machine-messages",
      "subagents",
      "applets",
    ]);
  });

  test("every declared dependency names a Package this deployment ships", () => {
    const ids = new Set(FOUNDATION_PACKAGES_V1.map((pkg) => pkg.id));
    for (const pkg of FOUNDATION_PACKAGES_V1) {
      for (const dependency of pkg.dependencies ?? []) {
        expect(ids.has(dependency)).toBe(true);
      }
    }
  });

  test("seeds a default-disabled Package and its dependencies", () => {
    const packageIds = foundationDefaultPackageIds();

    expect(packageIds.has("custom-models")).toBe(true);
    expect(packageIds.has("settings")).toBe(true);
    expect(packageIds.has("shell")).toBe(true);
    expect(packageIds.has("ui-theme")).toBe(true);
    expect(foundationPackageV1("custom-models")?.defaultEnablement).toBe(
      "disabled",
    );
  });

  test("mounts an enabled Ollama model through its Package runtime Contribution", async () => {
    const runtimePackage = createFoundationModelRuntimePackage(
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

    expect(runtimePackage.id).toBe("provider-ollama-cloud");
    expect(() =>
      createFoundationModelRuntimePackage(
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
    const runtimePackage = createFoundationModelRuntimePackage(
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

    expect(runtimePackage.id).toBe("provider-flock-ai");
  });

  test("mounts five features on every Turn, whatever the host", () => {
    // Memory is absent: like Skills, it mounts only for a Turn whose Memory
    // roots the host can reach, so it is never a base feature.
    expect(foundationBaseRuntimePackagesV1()).toHaveLength(5);
  });

  test("names the Packages the platform owns rather than the User", () => {
    // The application root, the Packages with no enablement control to offer,
    // and the ambient zero-configuration model path.
    const platformOwned = FOUNDATION_PACKAGES_V1.filter(
      (pkg) => pkg.platformOwned,
    ).map((pkg) => pkg.id);

    expect(platformOwned.toSorted()).toEqual([
      "applets",
      "auth",
      "credentials",
      "provider-flock-ai",
      "settings",
      "shell",
      "ui-theme",
    ]);
    // Audit has no User control either, but it is not a default installation:
    // it is statically mounted rather than repaired into enablement state.
    expect(foundationPackageV1("audit")?.platformOwned).toBeUndefined();
    expect(foundationPackageV1("custom-models")?.platformOwned).toBeUndefined();
    expect(foundationPackageV1("web")?.platformOwned).toBeUndefined();
  });

  test("resolves declared backend and enabled runtime Contributions through host seams", async () => {
    const backend = await createFoundationBackendContributions({
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
      listUsers: () => Promise.resolve([]),
      readUserFeatures: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          applets: false,
          updatedAt: "2026-09-01T00:00:00.000Z",
          updatedBy: "deployment-default",
        }),
      setUserFeatures: () =>
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
      "bot-template",
      "computer",
      "flock",
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
      await createFoundationBackendContributions<TestContribution>({
        backendHost: "bot",
        resolve: (specifier, lifecycle) =>
          lifecycle.mount({ specifier, executeConfiguration() {} }),
      });
    const userBackend =
      await createFoundationBackendContributions<TestContribution>({
        backendHost: "user",
        resolve: (specifier, lifecycle) =>
          lifecycle.mount({ specifier, startConnection() {} }),
      });
    expect(botBackend.contributions).toHaveLength(3);
    expect(userBackend.contributions).toHaveLength(9);
    const userSpecifiers = userBackend.contributions.map(
      (contribution) => contribution.specifier,
    );
    expect(userSpecifiers.indexOf("@frockbot/app/settings/user")).toBeLessThan(
      userSpecifiers.indexOf("@frockbot/providers/ollama-cloud/user"),
    );
    expect(userSpecifiers.indexOf("@frockbot/app/settings/user")).toBeLessThan(
      userSpecifiers.indexOf("@frockbot/providers/frock-ai/user"),
    );
    expect(
      userSpecifiers.indexOf("@frockbot/app/credentials/user"),
    ).toBeLessThan(
      userSpecifiers.indexOf("@frockbot/providers/ollama-cloud/user"),
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
      createFoundationHostedRuntimePackages({
        userId: "user-1",
        readSecret: (name) => {
          requestedSecrets.push(name);
          return undefined;
        },
      }).map((pkg) => pkg.id),
    ).toEqual(["credentials", "computer-host", "computer"]);
    // Whether there is a Computer is the presence of a host and nothing else.
    // The application asks the shell for no secret to answer it: which
    // credential a particular host needs is that host's business, and is
    // settled where the host is chosen.
    expect(requestedSecrets).toEqual([]);

    // The Skills Package mounts only for a Turn whose instruction root the
    // host can read, and then it leads the hosted runtime packages.
    expect(
      createFoundationHostedRuntimePackages({
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
      }).map((pkg) => pkg.id),
    ).toEqual(["skills", "credentials", "computer-host", "computer"]);

    const webCapability = {
      packageId: "web",
      capabilityId: "web-fetch",
      kind: "tool" as const,
    };
    const freshBotRuntime = await createFoundationEnabledRuntimePackages(
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
    expect(freshBotRuntime.map((pkg) => pkg.id)).toEqual(["web"]);
  });
});
