import { describe, expect, test } from "bun:test";
import {
  compileFoundationApplication,
  compileFoundationApplicationDeclarations,
  createFoundationAssignedRuntimePackages,
  createFoundationBackendContributions,
  createFoundationHostedRuntimePackages,
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
      "auth",
      "clock",
      "composio",
      "computer",
      "desktop-clipboard",
      "desktop-directory-picker",
      "desktop-notifications",
      "echo",
      "fly-sprite",
      "identity",
      "memory",
      "mobile-clipboard",
      "mobile-notifications",
      "provider-foundation",
      "shell",
    ]);
    expect(first.contributions).toEqual({
      backend: ["composio", "shell"],
      runtime: [
        "clock",
        "composio",
        "computer",
        "echo",
        "fly-sprite",
        "identity",
        "memory",
        "provider-foundation",
      ],
      client: ["auth", "clock", "computer", "shell"],
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
      first.packages.find((pkg) => pkg.id === "composio")?.manifest
        .contributions.backend,
    ).toEqual([
      { entry: "./backend", host: "gateway" },
      { entry: "./user-configuration", host: "user" },
    ]);
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
    const secrets: Record<string, string> = {
      COMPOSIO_API_KEY: "project-secret",
      COMPOSIO_GMAIL_AUTH_CONFIG_ID: "gmail-auth",
      FROCKBOT_AUTHORIZATION_STATE_SECRET:
        "test-authorization-state-secret-0001",
    };
    const backend = createFoundationBackendContributions(plan, {
      backendHost: "gateway",
      callbackBaseUrl: "https://bot.frockbot.com",
      readSecret: (name) => secrets[name],
      storeFor: () => {
        throw new Error("not used while composing");
      },
      markConnectionUnavailable: () => Promise.resolve("applied"),
    });
    expect(backend.map((contribution) => contribution.packageId)).toEqual([
      "composio",
    ]);
    const botBackend = createFoundationBackendContributions(plan, {
      backendHost: "bot",
      mount: (specifier) => ({ specifier, executeConfiguration() {} }),
    });
    const userBackend = createFoundationBackendContributions(plan, {
      backendHost: "user",
      mount: (specifier) => ({ specifier, startConnection() {} }),
    });
    expect(botBackend).toHaveLength(1);
    expect(userBackend).toHaveLength(1);
    expect(typeof botBackend[0]?.executeConfiguration).toBe("function");
    expect(typeof userBackend[0]?.startConnection).toBe("function");
    const requestedSecrets: string[] = [];
    expect(
      createFoundationHostedRuntimePackages(plan, {
        userId: "user-1",
        readSecret: (name) => {
          requestedSecrets.push(name);
          return undefined;
        },
      }).map((pkg) => pkg.specifier),
    ).toEqual(["@frockbot/plugin-fly-sprite", "@frockbot/plugin-computer"]);
    expect(requestedSecrets).toEqual(["SPRITES_TOKEN"]);

    const assignment = {
      assignmentId: "gmail-primary",
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
        readSecret: (name) => secrets[name],
        authorizeConnection: () =>
          Promise.resolve({
            connectionId: "connection-1",
            packageId: "composio",
            connectionTypeId: "gmail",
            displayName: "Gmail",
            state: "ready",
            safeMetadata: {
              connectedAccountId: "ca_123",
              toolkitSlug: "gmail",
            },
          }),
      },
    );
    expect(runtime.map((pkg) => pkg.contributionSpecifier)).toEqual([
      "@frockbot/plugin-composio/agent",
    ]);
  });
});
