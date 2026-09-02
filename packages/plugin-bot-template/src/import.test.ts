// The planner: what a review card says, and what the apply would therefore do.
//
// The card is the contract. Every claim here is one the User is shown before
// they confirm, and the step list is derived from the same function, so the
// two cannot drift.
import { describe, expect, it } from "bun:test";
import type { BotTemplateV1 } from "@frockbot/template-core";
import {
  describeImportPlanV1,
  importedBotIdV1,
  importedRoutineIdV1,
  planBotTemplateImportV1,
  type TemplateImportPlanInputV1,
} from "./import.ts";

const sheep = {
  schemaVersion: 1 as const,
  background: "meadow",
  upper: "wool",
  middle: "scarf",
  lower: "boots",
};

function template(overrides: Partial<BotTemplateV1> = {}): BotTemplateV1 {
  return {
    schemaVersion: 1,
    profile: {
      name: "Budget",
      description: "Watches the ledger.",
      avatar: { kind: "sheep", recipe: sheep },
    },
    skills: [{ slug: "reconcile", name: "Reconcile", body: "# Reconcile" }],
    routines: [
      {
        slug: "daily",
        name: "Daily",
        prompt: "Check it.",
        schedule: "0 9 * * *",
        timezone: "UTC",
        triggerKind: "cron",
      },
    ],
    packages: [
      {
        packageId: "mcp",
        catalogId: "example-connector",
        version: "0.0.1",
        displayName: "Example",
      },
    ],
    mcpServers: [
      {
        kind: "needs-connection",
        name: "Beeper",
        connectionTypeId: "mcp-remote-key",
        hint: "Bring your own key.",
      },
    ],
    ...overrides,
  };
}

function input(
  overrides: Partial<TemplateImportPlanInputV1> = {},
): TemplateImportPlanInputV1 {
  return {
    importId: "import-1",
    shareId: `user-a.${"a".repeat(32)}`,
    hash: "b".repeat(64),
    botId: "budget-abc123456789",
    template: template(),
    installedPackages: [],
    catalogGeneration: "gen-7",
    availableCatalogIds: ["example-connector"],
    ...overrides,
  };
}

describe("diffing against the importing User's pinned generation", () => {
  it("marks a Package present in the pinned index as will-install", () => {
    const plan = planBotTemplateImportV1(input());
    expect(plan.packages).toEqual([
      {
        catalogId: "example-connector",
        packageId: "mcp",
        displayName: "Example",
        version: "0.0.1",
        status: "will-install",
      },
    ]);
    expect(plan.steps.map((step) => step.key)).toContain(
      "install:example-connector",
    );
  });

  it("marks a Package the User already has as already-installed", () => {
    const plan = planBotTemplateImportV1(
      input({
        installedPackages: [
          {
            packageId: "mcp",
            state: "installed",
            catalogId: "example-connector",
          },
        ],
      }),
    );
    expect(plan.packages[0]!.status).toBe("already-installed");
    expect(plan.steps.map((step) => step.key)).not.toContain(
      "install:example-connector",
    );
  });

  it("marks a Package absent from the pinned generation as missing", () => {
    const plan = planBotTemplateImportV1(
      input({ availableCatalogIds: ["something-else"] }),
    );
    expect(plan.packages[0]!.status).toBe("missing");
    expect(
      plan.steps.some((step) => step.kind === "user/install-package"),
    ).toBe(false);
  });

  it("marks every Package missing when the User is not pinned at all", () => {
    const plan = planBotTemplateImportV1(
      input({
        catalogGeneration: undefined,
        availableCatalogIds: ["example-connector"],
      }),
    );
    expect(plan.packages[0]!.status).toBe("missing");
    expect(plan.catalogGeneration).toBeUndefined();
  });

  it("does not treat a failed installation as already installed", () => {
    const plan = planBotTemplateImportV1(
      input({
        installedPackages: [
          { packageId: "mcp", state: "failed", catalogId: "example-connector" },
        ],
      }),
    );
    expect(plan.packages[0]!.status).toBe("will-install");
  });
});

describe("the step list", () => {
  it("creates the Bot first, then installs, then Skills, then Routines", () => {
    const plan = planBotTemplateImportV1(input());
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "bot/create",
      "user/install-package",
      "skill/write",
      "routine/create",
    ]);
  });

  it("disables an imported webhook Routine as its own step", () => {
    const plan = planBotTemplateImportV1(
      input({
        template: template({
          routines: [
            {
              slug: "hook",
              name: "Hook",
              prompt: "go",
              timezone: "UTC",
              triggerKind: "webhook",
            },
          ],
        }),
      }),
    );
    expect(
      plan.steps
        .filter((step) => step.kind.startsWith("routine"))
        .map((step) => step.kind),
    ).toEqual(["routine/create", "routine/disable"]);
  });

  it("leaves a cron Routine enabled", () => {
    const plan = planBotTemplateImportV1(input());
    expect(plan.steps.some((step) => step.kind === "routine/disable")).toBe(
      false,
    );
  });
});

describe("what an import never does", () => {
  it("plans no Connection or credential, only lines telling the User", () => {
    const plan = planBotTemplateImportV1(input());
    expect(plan.connections).toEqual([
      {
        name: "Beeper",
        connectionTypeId: "mcp-remote-key",
        hint: "Bring your own key.",
      },
    ]);
    expect(plan.steps.some((step) => step.kind.includes("connection"))).toBe(
      false,
    );
  });

  it("lists a public server too, because no Connection is created for it", () => {
    const plan = planBotTemplateImportV1(
      input({
        template: template({
          mcpServers: [
            {
              kind: "public",
              name: "Example",
              url: "https://mcp.example.test/mcp",
              transport: "streamable-http",
            },
          ],
        }),
      }),
    );
    expect(plan.connections[0]).toMatchObject({
      name: "Example",
      url: "https://mcp.example.test/mcp",
    });
    expect(plan.steps.some((step) => step.kind === "bot/create")).toBe(true);
  });
});

describe("derived identity", () => {
  it("derives the same Bot id for the same User and import", async () => {
    const first = await importedBotIdV1("user-b", "import-1", "Budget");
    const second = await importedBotIdV1("user-b", "import-1", "Budget");
    expect(second).toBe(first);
    expect(first.startsWith("budget-")).toBe(true);
  });

  it("derives a different Bot id for a different import", async () => {
    expect(await importedBotIdV1("user-b", "import-1", "Budget")).not.toBe(
      await importedBotIdV1("user-b", "import-2", "Budget"),
    );
  });

  it("derives a different Bot id for a different User", async () => {
    expect(await importedBotIdV1("user-b", "import-1", "Budget")).not.toBe(
      await importedBotIdV1("user-c", "import-1", "Budget"),
    );
  });

  it("derives a stable, safe Routine id", () => {
    expect(importedRoutineIdV1("import-1", "on delivery/x")).toBe(
      "import-1-on-delivery-x",
    );
  });
});

describe("the card's prose", () => {
  it("says what will be created, installed, skipped and connected", () => {
    const plan = planBotTemplateImportV1(
      input({ availableCatalogIds: [], catalogGeneration: "gen-7" }),
    );
    const described = describeImportPlanV1(plan);
    expect(described).toContain('Will create the Bot "Budget"');
    expect(described).toContain("missing from your catalog");
    expect(described).toContain("need your own Connection");
    expect(described).toContain("No Connection or credential");
  });
});
