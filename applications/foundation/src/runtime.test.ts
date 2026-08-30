import { describe, expect, test } from "bun:test";
import {
  compileFoundationApplication,
  compileFoundationApplicationDeclarations,
  createFoundationAssignedRuntimePackages,
  createFoundationBackendContributions,
  createFoundationHostedRuntimePackages,
  createFoundationModelRuntimePackage,
  createFoundationRuntimeApplication,
} from "./runtime.js";
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
      "auth",
      "shell",
      "clock",
      "computer",
      "credentials",
      "desktop-clipboard",
      "desktop-directory-picker",
      "desktop-notifications",
      "echo",
      "flock",
      "fly-sprite",
      "identity",
      "memory",
      "mobile-clipboard",
      "mobile-notifications",
      "provider-foundation",
      "settings",
      "provider-ollama-cloud",
    ]);
    expect(first.contributions).toEqual({
      backend: [
        "shell",
        "credentials",
        "flock",
        "settings",
        "provider-ollama-cloud",
      ],
      runtime: [
        "clock",
        "computer",
        "credentials",
        "echo",
        "fly-sprite",
        "identity",
        "memory",
        "provider-foundation",
        "provider-ollama-cloud",
      ],
      client: [
        "ui-theme",
        "auth",
        "shell",
        "clock",
        "computer",
        "flock",
        "settings",
      ],
      desktop: [
        "auth",
        "clock",
        "desktop-clipboard",
        "desktop-directory-picker",
        "desktop-notifications",
        "fly-sprite",
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
    ).toEqual([{ entry: "./user", host: "user" }]);
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
  });

  test("exposes only compiled runtime packages to the runtime host", async () => {
    const application = await createFoundationRuntimeApplication();

    expect(application.packages.map((pkg) => pkg.manifest)).toHaveLength(5);
    expect(application.packages.map((pkg) => pkg.specifier)).toEqual([
      "@frockbot/plugin-clock",
      "@frockbot/plugin-echo",
      "@frockbot/plugin-identity",
      "@frockbot/plugin-memory",
      "@frockbot/plugin-provider-foundation",
    ]);
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
      createBot: () =>
        Promise.resolve({
          schemaVersion: 1,
          commandId: "test",
          status: "applied",
          revision: 1,
        }),
      readSheep: () => Promise.reject(new Error("not used while composing")),
      updateSheep: () => Promise.reject(new Error("not used while composing")),
    });
    expect(
      backend.contributions.map((contribution) => contribution.packageId),
    ).toEqual(["flock"]);
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
    expect(userBackend.contributions).toHaveLength(4);
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
      }).map((pkg) => pkg.specifier),
    ).toEqual([
      "@frockbot/plugin-credentials",
      "@frockbot/plugin-fly-sprite",
      "@frockbot/plugin-computer",
    ]);
    expect(requestedSecrets).toEqual(["SPRITES_TOKEN"]);

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
