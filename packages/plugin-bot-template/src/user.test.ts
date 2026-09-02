// The User Contribution: staging, visibility, revocation, and the public read.
//
// Everything here runs against the real `UserSettingsBackendContribution` over
// an in-memory storage, so the identity assertion, the packages projection and
// the Connection projection are the product's own rather than a stub's.
import { describe, expect, it } from "bun:test";
import type { BotSettingsViewV1 } from "@frockbot/configuration-core";
import {
  createUserSettingsBackendContribution,
  type UserSettingsStorage,
  type UserSettingsTransaction,
} from "@frockbot/plugin-settings/user";
import {
  parseBotTemplateDocumentV1,
  templateObjectKeyV1,
} from "@frockbot/template-core";
import { createBotTemplateUserBackendContribution } from "./user.ts";
import type { TemplateBlobStoreV1, TemplateBotReaderV1 } from "./user.ts";

const USER = "user-1";
const BOT = "budget";

class MemoryStorage implements UserSettingsStorage {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(
    keyOrEntries: string | Record<string, unknown>,
    value?: T,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") this.values.set(keyOrEntries, value);
    else {
      for (const [key, entry] of Object.entries(keyOrEntries)) {
        this.values.set(key, entry);
      }
    }
    return Promise.resolve();
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

class MemoryBlobs implements TemplateBlobStoreV1 {
  readonly objects = new Map<string, string>();
  writes = 0;

  async putImmutable(key: string, document: string): Promise<void> {
    const existing = this.objects.get(key);
    if (existing !== undefined) {
      if (existing !== document) {
        throw new Error(`immutable artifact collision at ${key}`);
      }
      return;
    }
    this.writes += 1;
    this.objects.set(key, document);
  }

  read(key: string): Promise<string | undefined> {
    return Promise.resolve(this.objects.get(key));
  }
}

const sheep = {
  schemaVersion: 1 as const,
  background: "meadow",
  upper: "wool",
  middle: "scarf",
  lower: "boots",
};

function botSettings(): BotSettingsViewV1 {
  return {
    schemaVersion: 1,
    botId: BOT,
    revision: 3,
    profile: { name: "Budget", title: "Money minder" },
    notifications: { enabled: true },
    packageValues: {},
  };
}

const bots: TemplateBotReaderV1 = {
  readSettings: () => Promise.resolve(botSettings()),
  readSheep: () => Promise.resolve(sheep),
  readSkills: () =>
    Promise.resolve([
      {
        source: "bot" as const,
        slug: "reconcile",
        name: "Reconcile",
        body: "# Reconcile\nOpen the ledger.",
        writer: { kind: "bot" as const },
      },
    ]),
  readRoutines: () =>
    Promise.resolve([
      {
        routineId: "r-1",
        name: "On delivery",
        prompt: "Handle the payload.",
        trigger: { kind: "webhook" as const },
        timezone: "UTC",
      },
    ]),
};

async function harness(
  options: { secrets?: string[]; connectionUrl?: string } = {},
) {
  const storage = new MemoryStorage();
  const blobs = new MemoryBlobs();
  const settings = createUserSettingsBackendContribution({
    storage,
    availablePackages: [{ packageId: "mcp", version: "0.0.1" }],
  });
  await settings.read(USER);
  await settings.createConnection(USER, {
    connectionId: "connection-1",
    packageId: "mcp",
    connectionTypeId: "mcp-remote-key",
    displayName: "Beeper",
    state: "ready",
    authorization: {
      schemaVersion: 1,
      kind: "api-key",
      credential: {
        schemaVersion: 1,
        configured: true,
        source: "api-key",
        writable: true,
      },
    },
    settings: {
      url: options.connectionUrl ?? "https://beeper.example.test/mcp",
    },
    safeMetadata: { toolsHash: "abc" },
  });
  const secrets = options.secrets ?? ["a".repeat(32), "b".repeat(32)];
  let issued = 0;
  const contribution = createBotTemplateUserBackendContribution({
    storage,
    settings,
    bots,
    blobs,
    now: () => Date.parse("2026-08-31T00:00:00.000Z"),
    randomSecret: () => secrets[issued++ % secrets.length]!,
  });
  return { storage, blobs, settings, contribution };
}

describe("template/stage", () => {
  it("stages privately, stores the blob and returns a summary", async () => {
    const { blobs, contribution } = await harness();
    const receipt = await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "stage-1",
      botId: BOT,
    });
    expect(receipt.share.visibility).toBe("private");
    expect(receipt.share.shareId).toBe(`${USER}.${"a".repeat(32)}`);
    expect(receipt.summary?.skills).toBe(1);
    expect(receipt.summary?.routines).toBe(1);
    expect(receipt.summary?.needsConnection).toBe(1);

    const document = blobs.objects.get(templateObjectKeyV1(receipt.share.hash));
    expect(document).toBeDefined();
    const template = parseBotTemplateDocumentV1(document!);
    expect(template.skills[0]?.body).toContain("Open the ledger");
    expect(template.routines[0]?.triggerKind).toBe("webhook");
    expect(document).not.toContain("connection-1");
    expect(document).not.toContain("beeper.example.test");
  });

  it("replays a stage as a read, staging nothing a second time", async () => {
    const { blobs, contribution } = await harness();
    const first = await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "stage-1",
      botId: BOT,
    });
    const second = await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "stage-1",
      botId: BOT,
    });
    expect(second).toEqual(first);
    expect((await contribution.listShares(USER)).shares).toHaveLength(1);
    expect(blobs.writes).toBe(1);
  });

  it("re-staging identical content writes no second object", async () => {
    const { blobs, contribution } = await harness();
    const first = await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "stage-1",
      botId: BOT,
    });
    const second = await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "stage-2",
      botId: BOT,
    });
    expect(second.share.hash).toBe(first.share.hash);
    expect(second.share.shareId).not.toBe(first.share.shareId);
    expect(blobs.objects.size).toBe(1);
    expect(blobs.writes).toBe(1);
  });

  it("refuses one command id reused for a different command", async () => {
    const { contribution } = await harness();
    await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "stage-1",
      botId: BOT,
    });
    await expect(
      contribution.execute(USER, {
        schemaVersion: 1,
        type: "template/stage",
        commandId: "stage-1",
        botId: "another-bot",
      }),
    ).rejects.toThrow(/reused for a different command/);
  });
});

describe("visibility and revocation", () => {
  it("refuses an unauthenticated read of a private share", async () => {
    const { contribution } = await harness();
    const receipt = await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "stage-1",
      botId: BOT,
    });
    expect(
      await contribution.resolvePublicShare(receipt.share.shareId),
    ).toBeUndefined();
  });

  it("serves a link share and stops on revocation", async () => {
    const { contribution } = await harness();
    const staged = await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "stage-1",
      botId: BOT,
    });
    const shareId = staged.share.shareId;
    await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/set-visibility",
      commandId: "visibility-1",
      shareId,
      visibility: "link",
    });
    const resolved = await contribution.resolvePublicShare(shareId);
    expect(resolved?.share.visibility).toBe("link");
    expect(resolved?.document).toContain("Budget");

    await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/revoke",
      commandId: "revoke-1",
      shareId,
    });
    expect(await contribution.resolvePublicShare(shareId)).toBeUndefined();
  });

  it("moves through private, link and public and back", async () => {
    const { contribution } = await harness();
    const staged = await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "stage-1",
      botId: BOT,
    });
    const shareId = staged.share.shareId;
    for (const [index, visibility] of (
      ["link", "public", "private"] as const
    ).entries()) {
      const receipt = await contribution.execute(USER, {
        schemaVersion: 1,
        type: "template/set-visibility",
        commandId: `visibility-${index}`,
        shareId,
        visibility,
      });
      expect(receipt.share.visibility).toBe(visibility);
    }
    expect(await contribution.resolvePublicShare(shareId)).toBeUndefined();
  });

  it("keeps the moment a revoked share was revoked at", async () => {
    const { contribution } = await harness();
    const staged = await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "stage-1",
      botId: BOT,
    });
    const first = await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/revoke",
      commandId: "revoke-1",
      shareId: staged.share.shareId,
    });
    const second = await contribution.execute(USER, {
      schemaVersion: 1,
      type: "template/revoke",
      commandId: "revoke-2",
      shareId: staged.share.shareId,
    });
    expect(second.share.revokedAt).toBe(first.share.revokedAt!);
  });

  it("refuses to change a share whose id names another User", async () => {
    const { contribution } = await harness();
    await expect(
      contribution.execute(USER, {
        schemaVersion: 1,
        type: "template/revoke",
        commandId: "revoke-1",
        shareId: `someone-else.${"c".repeat(32)}`,
      }),
    ).rejects.toThrow(/was not found/);
  });
});
