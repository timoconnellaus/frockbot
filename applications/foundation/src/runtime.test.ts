import { describe, expect, test } from "bun:test";
import {
  compileFoundationApplication,
  createFoundationAssignedRuntimePackages,
  createFoundationBackendContributions,
  createFoundationRuntimeApplication,
} from "./runtime.js";

describe("foundation application", () => {
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
      backend: ["composio"],
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
        "clock",
        "desktop-clipboard",
        "desktop-directory-picker",
        "desktop-notifications",
        "fly-sprite",
      ],
      mobile: ["mobile-clipboard", "mobile-notifications"],
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

  test("resolves declared backend and assigned runtime Contributions through host seams", async () => {
    const plan = await compileFoundationApplication();
    const secrets: Record<string, string> = {
      COMPOSIO_API_KEY: "project-secret",
      COMPOSIO_GMAIL_AUTH_CONFIG_ID: "gmail-auth",
      FROCKBOT_AUTHORIZATION_STATE_SECRET: "state-secret",
    };
    const backend = createFoundationBackendContributions(plan, {
      callbackBaseUrl: "https://bot.frockbot.com",
      readSecret: (name) => secrets[name],
      storeFor: () => {
        throw new Error("not used while composing");
      },
      assignCapability: () => Promise.resolve(),
      markConnectionUnavailable: () => Promise.resolve("applied"),
    });
    expect(backend.map((contribution) => contribution.packageId)).toEqual([
      "composio",
    ]);

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
