// The apply saga: per-step receipts, replay, resumption and visible failure.
//
// The writer seam is a recording fake, because the claims here are about the
// *saga* — how many times each command is issued, in what order, and what the
// record says when one fails. That the underlying commands are themselves
// idempotent is the workerd suite's claim, against the real authorities.
import { describe, expect, it } from "bun:test";
import {
  createUserSettingsBackendContribution,
  type UserSettingsStorage,
  type UserSettingsTransaction,
} from "@frockbot/plugin-settings/user";
import {
  canonicalBotTemplateDocumentV1,
  templateContentHashV1,
  type BotTemplateV1,
} from "@frockbot/template-core";
import { createBotTemplateUserBackendContribution } from "./user.ts";
import type {
  TemplateBlobStoreV1,
  TemplateBotReaderV1,
  TemplateImportWriterV1,
} from "./user.ts";

const USER = "user-b";
const SHARE_ID = `user-a.${"a".repeat(32)}`;

const sheep = {
  schemaVersion: 1 as const,
  background: "meadow",
  upper: "wool",
  middle: "scarf",
  lower: "boots",
};

class MemoryStorage implements UserSettingsStorage {
  readonly values = new Map<string, unknown>();
  /**
   * The order durable writes and alarm arming happened in. An import that is
   * mid-apply has to be recoverable from the alarm alone, so "the deadline was
   * recorded before the record said `applying`" is the claim, not merely "an
   * alarm was set at some point".
   */
  readonly trace: string[] = [];
  alarm: number | null = null;
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(
    keyOrEntries: string | Record<string, unknown>,
    value?: T,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") this.record(keyOrEntries, value);
    else {
      for (const [key, entry] of Object.entries(keyOrEntries)) {
        this.record(key, entry);
      }
    }
    return Promise.resolve();
  }
  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }
  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm =
      typeof scheduledTime === "number"
        ? scheduledTime
        : scheduledTime.getTime();
    this.trace.push("alarm:set");
    return Promise.resolve();
  }
  private record(key: string, value: unknown): void {
    this.values.set(key, value);
    if (key === "bot-template:import-recovery-at") {
      this.trace.push(value ? "recovery:owed" : "recovery:clear");
    }
    const status = (value as { status?: unknown } | undefined)?.status;
    if (key.startsWith("bot-template:import:") && typeof status === "string") {
      this.trace.push(`import:${status}`);
    }
  }
  async transaction<T>(
    callback: (storage: UserSettingsTransaction) => Promise<T>,
  ): Promise<T> {
    const before = new Map(this.values);
    try {
      return await callback(this);
    } catch (error) {
      this.values.clear();
      for (const [key, entry] of before) this.values.set(key, entry);
      throw error;
    }
  }
}

/** One immutable generation holding the entry the template names. */
const CATALOG_ENTRY = {
  schemaVersion: 1 as const,
  catalogId: "example-connector",
  packageId: "mcp",
  displayName: "Example",
  description: "An example connector.",
  version: "0.0.1",
  kind: "package" as const,
  manifestHash: "d".repeat(64),
  servers: [],
  setupFields: [],
  skills: [],
};

function catalogHost() {
  return {
    readCurrentIndex: () =>
      Promise.resolve({
        pin: { generation: "gen-7", indexHash: "c".repeat(64) },
        index: {
          schemaVersion: 1 as const,
          generation: "gen-7",
          entries: [
            {
              catalogId: CATALOG_ENTRY.catalogId,
              packageId: CATALOG_ENTRY.packageId,
              displayName: CATALOG_ENTRY.displayName,
              description: CATALOG_ENTRY.description,
              version: CATALOG_ENTRY.version,
              manifestHash: CATALOG_ENTRY.manifestHash,
              kind: CATALOG_ENTRY.kind,
            },
          ],
        },
      }),
    readEntry: (generation: string, catalogId: string) =>
      Promise.resolve(
        generation === "gen-7" && catalogId === CATALOG_ENTRY.catalogId
          ? CATALOG_ENTRY
          : undefined,
      ),
  };
}

const blobs: TemplateBlobStoreV1 = {
  putImmutable: () => Promise.resolve(),
  read: () => Promise.resolve(undefined),
};

const bots: TemplateBotReaderV1 = {
  readSettings: () => Promise.reject(new Error("not used")),
  readSheep: () => Promise.resolve(sheep),
  readSkills: () => Promise.resolve([]),
  readRoutines: () => Promise.resolve([]),
};

function template(overrides: Partial<BotTemplateV1> = {}): BotTemplateV1 {
  return {
    schemaVersion: 1,
    profile: {
      name: "Budget",
      description: "Watches the ledger.",
      avatar: { kind: "sheep", recipe: sheep },
    },
    skills: [
      { slug: "reconcile", name: "Reconcile", body: "# Reconcile\nSteps." },
    ],
    routines: [
      {
        slug: "on-delivery",
        name: "On delivery",
        prompt: "Handle it.",
        timezone: "UTC",
        triggerKind: "webhook",
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
      },
    ],
    ...overrides,
  };
}

interface Recorder {
  calls: string[];
  installs: Record<string, unknown>[];
  bots: Set<string>;
  writer: TemplateImportWriterV1;
}

function recorder(
  failures: Record<string, string> = {},
  options: { botExistsAfterCreate?: boolean } = {},
): Recorder {
  const calls: string[] = [];
  const installs: Record<string, unknown>[] = [];
  const created = new Set<string>();
  const writer: TemplateImportWriterV1 = {
    listBots: () =>
      Promise.resolve({
        revision: created.size,
        bots: [...created].map((botId) => ({ botId })),
      }),
    createBot: (create) => {
      calls.push(`bot/create:${create.botId}`);
      if (failures["bot/create"]) {
        return Promise.resolve({
          status: "rejected" as const,
          failure: failures["bot/create"],
        });
      }
      if (options.botExistsAfterCreate !== false) created.add(create.botId);
      return Promise.resolve({ status: "applied" as const });
    },
    installPackage: (install) => {
      calls.push(`install:${install.catalogId}`);
      installs.push(install as unknown as Record<string, unknown>);
      if (failures["install"]) throw new Error(failures["install"]);
      return Promise.resolve({ status: "applied" });
    },
    writeSkill: (skill) => {
      calls.push(`skill:${skill.slug}`);
      if (failures["skill"]) {
        return Promise.resolve({
          status: "refused" as const,
          reason: failures["skill"],
        });
      }
      return Promise.resolve({
        status: "written" as const,
        generationId: `gen-${skill.slug}`,
      });
    },
    executeRoutineCommand: ({ command }) => {
      const typed = command as { type: string; routineId?: string };
      calls.push(`${typed.type}:${typed.routineId}`);
      return Promise.resolve({
        status: "applied",
        ...(typed.routineId === undefined
          ? {}
          : { routineId: typed.routineId }),
      });
    },
  };
  return { calls, installs, bots: created, writer };
}

async function harness(
  options: {
    failures?: Record<string, string>;
    availableCatalogIds?: string[];
    installed?: boolean;
  } = {},
) {
  const storage = new MemoryStorage();
  const settings = createUserSettingsBackendContribution({
    storage,
    availablePackages: [{ packageId: "mcp", version: "0.0.1" }],
    catalog: catalogHost(),
  });
  // The first read pins the generation, exactly as production's first read does.
  await settings.readConfiguration({ schemaVersion: 1, userId: USER });
  if (options.installed) {
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: USER,
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "pre-install",
        expectedRevision: 0,
        packageId: "mcp",
        version: "0.0.1",
      },
    });
  }
  const document = canonicalBotTemplateDocumentV1(template());
  const hash = await templateContentHashV1(document);
  const recording = recorder(options.failures ?? {});
  const contribution = createBotTemplateUserBackendContribution({
    storage,
    settings,
    bots,
    blobs,
    importer: recording.writer,
    readPublishedShare: () => Promise.resolve({ hash, document }),
    readCatalogIds: () =>
      Promise.resolve(options.availableCatalogIds ?? ["example-connector"]),
    now: () => Date.parse("2026-09-01T00:00:00.000Z"),
  });
  return { contribution, recording, storage, hash };
}

async function plan(
  contribution: Awaited<ReturnType<typeof harness>>["contribution"],
) {
  return contribution.executeImport(USER, {
    schemaVersion: 1,
    type: "template/plan-import",
    commandId: "import-1",
    shareId: SHARE_ID,
  });
}

async function apply(
  contribution: Awaited<ReturnType<typeof harness>>["contribution"],
) {
  return contribution.executeImport(USER, {
    schemaVersion: 1,
    type: "template/apply-import",
    commandId: "apply-1",
    importId: "import-1",
  });
}

describe("planning", () => {
  it("applies nothing and records a planned card", async () => {
    const { contribution, recording } = await harness();
    const record = await plan(contribution);
    expect(record.status).toBe("planned");
    expect(record.botName).toBe("Budget");
    expect(record.skills).toEqual(["reconcile"]);
    expect(record.routines).toEqual([{ slug: "on-delivery", disabled: true }]);
    expect(record.connections).toHaveLength(1);
    expect(record.steps.every((step) => step.status === "pending")).toBe(true);
    // Nothing applied before the User confirms.
    expect(recording.calls).toEqual([]);
  });

  it("replans as a read, so the card the User confirmed cannot move", async () => {
    const { contribution } = await harness();
    const first = await plan(contribution);
    const second = await plan(contribution);
    expect(second).toEqual(first);
    expect((await contribution.listImports(USER)).imports).toHaveLength(1);
  });
});

describe("applying", () => {
  it("walks every step once, in order, and marks each done", async () => {
    const { contribution, recording } = await harness();
    const planned = await plan(contribution);
    const applied = await apply(contribution);
    expect(applied.status).toBe("applied");
    expect(applied.steps.map((step) => step.status)).toEqual(
      planned.steps.map(() => "done"),
    );
    expect(recording.calls).toEqual([
      `bot/create:${planned.botId}`,
      "install:example-connector",
      "skill:reconcile",
      "routine/create:import-1-on-delivery",
      "routine/pause:import-1-on-delivery",
    ]);
  });

  it("replays without a second Bot or a duplicate install", async () => {
    const { contribution, recording } = await harness();
    await plan(contribution);
    await apply(contribution);
    const before = [...recording.calls];
    const again = await apply(contribution);
    expect(again.status).toBe("applied");
    expect(recording.calls).toEqual(before);
  });

  it("skips an install the pinned generation does not hold", async () => {
    const { contribution, recording } = await harness({
      availableCatalogIds: [],
    });
    const planned = await plan(contribution);
    expect(planned.packages[0]!.status).toBe("missing");
    await apply(contribution);
    expect(recording.calls).not.toContain("install:example-connector");
  });

  it("installs with no setup values, because a template exports none", async () => {
    const { contribution, recording } = await harness();
    await plan(contribution);
    await apply(contribution);
    expect(recording.installs).toHaveLength(1);
    // `PluginInstallationView.values` is one store with two writers, and a
    // template is neither: setup values may hold keys, so they never travel
    // and an import writes none. The User's own values survive untouched.
    expect(Object.keys(recording.installs[0]!)).not.toContain("values");
  });

  it("creates no Connection or credential", async () => {
    const { contribution, recording } = await harness();
    await plan(contribution);
    const applied = await apply(contribution);
    expect(recording.calls.some((call) => call.includes("connection"))).toBe(
      false,
    );
    expect(applied.connections[0]!.name).toBe("Beeper");
  });
});

describe("failure is a visible, repairable record", () => {
  it("stops at the failing step and says which one and why", async () => {
    const { contribution, recording } = await harness({
      failures: { skill: "the instruction root is unavailable" },
    });
    await plan(contribution);
    const failed = await apply(contribution);
    expect(failed.status).toBe("failed");
    expect(failed.failure).toContain("skill:reconcile");
    expect(failed.failure).toContain("instruction root is unavailable");
    const steps = Object.fromEntries(
      failed.steps.map((step) => [step.key, step.status]),
    );
    expect(steps["bot/create"]).toBe("done");
    expect(steps["install:example-connector"]).toBe("done");
    expect(steps["skill:reconcile"]).toBe("failed");
    // The Routine steps were never reached, so nothing half-fired.
    expect(steps["routine:on-delivery"]).toBe("pending");
    expect(recording.calls).not.toContain(
      "routine/create:import-1-on-delivery",
    );
  });

  it("resumes from the failed step and does not redo the ones that took", async () => {
    const failures: Record<string, string> = { skill: "transient" };
    const storage = new MemoryStorage();
    const settings = createUserSettingsBackendContribution({
      storage,
      availablePackages: [{ packageId: "mcp", version: "0.0.1" }],
      catalog: catalogHost(),
    });
    await settings.readConfiguration({ schemaVersion: 1, userId: USER });
    const document = canonicalBotTemplateDocumentV1(template());
    const hash = await templateContentHashV1(document);
    const recording = recorder(failures);
    const contribution = createBotTemplateUserBackendContribution({
      storage,
      settings,
      bots,
      blobs,
      importer: recording.writer,
      readPublishedShare: () => Promise.resolve({ hash, document }),
      readCatalogIds: () => Promise.resolve(["example-connector"]),
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    });
    await plan(contribution);
    expect((await apply(contribution)).status).toBe("failed");

    // The Workspace comes back.
    delete failures.skill;
    const resumed = await apply(contribution);
    expect(resumed.status).toBe("applied");
    // One Bot, one install: the steps that already took were not repeated.
    expect(
      recording.calls.filter((call) => call.startsWith("bot/create")),
    ).toHaveLength(1);
    expect(
      recording.calls.filter((call) => call === "install:example-connector"),
    ).toHaveLength(1);
  });

  it("records the recovery deadline before the record says applying", async () => {
    const { contribution, storage } = await harness();
    await plan(contribution);
    storage.trace.length = 0;
    await apply(contribution);

    // The deadline and the alarm are both in place before the record enters
    // `applying`, so an eviction at any point after that leaves an object
    // scheduled to finish the walk.
    expect(storage.trace[0]).toBe("recovery:owed");
    expect(storage.trace.indexOf("alarm:set")).toBeLessThan(
      storage.trace.indexOf("import:applying"),
    );
  });

  it("clears the recovery debt once the import is terminal", async () => {
    const { contribution, storage } = await harness();
    await plan(contribution);
    await apply(contribution);
    expect(storage.values.get("bot-template:import-recovery-at")).toBe(0);
  });

  it("records a visible failure and clears the debt when a step fails", async () => {
    const failures: Record<string, string> = {};
    const { contribution, storage } = await harness({ failures });
    const record = await plan(contribution);
    // The state an eviction mid-walk leaves: `applying`, with no process to
    // finish it. This pass cannot finish it either, because the writer throws.
    failures.install = "the Catalog is unreachable";
    await storage.put(`bot-template:import:${record.importId}`, {
      ...record,
      status: "applying",
      steps: record.steps.map((step) =>
        step.kind === "bot/create" ? { ...step, status: "done" } : step,
      ),
    });
    await contribution.recoverImports(USER);

    // Failed is terminal and repairable — the card names the step and the
    // reason — so nothing is owed a further recovery.
    const listed = (await contribution.listImports(USER)).imports[0]!;
    expect(listed.status).toBe("failed");
    expect(listed.failure).toContain("the Catalog is unreachable");
    expect(storage.values.get("bot-template:import-recovery-at")).toBe(0);
  });

  it("re-arms the alarm when a recovery pass leaves the import applying", async () => {
    const { contribution, storage } = await harness();
    const record = await plan(contribution);
    await storage.put(`bot-template:import:${record.importId}`, {
      ...record,
      status: "applying",
    });
    // The plan the walk needs is unreadable, so the pass throws before any
    // step runs and the record stays `applying`.
    storage.values.delete(`bot-template:import:plan:${record.importId}`);
    storage.alarm = null;
    await contribution.recoverImports(USER);

    const listed = (await contribution.listImports(USER)).imports[0]!;
    expect(listed.status).toBe("applying");
    // Still owed, and still scheduled: the next alarm tries again rather than
    // the import waiting for unrelated work to wake the object.
    expect(
      storage.values.get("bot-template:import-recovery-at"),
    ).toBeGreaterThan(0);
    expect(storage.alarm).not.toBeNull();
  });

  it("resumes an import left mid-apply from the recovery pass", async () => {
    const { contribution, recording, storage } = await harness();
    const record = await plan(contribution);
    // An eviction between the record moving to `applying` and the first step.
    await storage.put(`bot-template:import:${record.importId}`, {
      ...record,
      status: "applying",
    });
    await contribution.recoverImports(USER);
    const listed = (await contribution.listImports(USER)).imports[0]!;
    expect(listed.status).toBe("applied");
    expect(recording.calls).toContain(`bot/create:${record.botId}`);
  });
});
