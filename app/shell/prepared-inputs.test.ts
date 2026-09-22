import { describe, expect, test } from "bun:test";
import { initializeBotSettingsV1 } from "@frockbot/core/configuration";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import { defaultUserFeaturesV1 } from "@frockbot/app/admin/shared";
import {
  emptyPluginEnablementV1,
  type PluginEnablementV1,
} from "@frockbot/app/plugins/enablement";
import {
  PREPARATION_ATTEMPTS_V1,
  PreparationUnavailableError,
  clonePreparedTurnInputsV1,
  decodePreparedTurnInputsV1,
  gatherPreparedTurnInputsV1,
  pluginSkillsFromMembersV1,
  withStablePreparationV1,
  type AccountPreparationStampV1,
  type AccountPreparationV1,
  type BotLocalPreparationV1,
  type PreparationPortsV1,
} from "./prepared-inputs.js";

const IDENTITY = { userId: "user-1", botId: "primary" };
const boot = await bootstrapGeneration({
  createdAt: "2026-09-22T00:00:00.000Z",
});

function userSettings(revision = 1) {
  return {
    schemaVersion: 1 as const,
    revision,
    profile: { name: "Ada" },
    packages: [],
    connections: [
      {
        connectionId: "ollama-1",
        packageId: "provider-ollama-cloud",
        connectionTypeId: "ollama-cloud-account",
        displayName: "Work",
        state: "ready" as const,
        generation: "generation-a",
        safeMetadata: { region: "au" },
      },
    ],
  };
}

function account(
  generation: CompositionGenerationV1,
  revision = 1,
): AccountPreparationV1 {
  return {
    schemaVersion: 1,
    settings: userSettings(revision),
    features: defaultUserFeaturesV1(),
    composition: { current: generation, lastKnownGood: generation },
  };
}

function localBot(): BotLocalPreparationV1 {
  const settings = initializeBotSettingsV1("primary");
  settings.revision = 2;
  return {
    settings,
    enablement: { ...emptyPluginEnablementV1(new Date(0)), revision: 4 },
    contextRevision: 3,
    contextSequence: 9,
  };
}

function stamp(generationId: string, revision = 1): AccountPreparationStampV1 {
  return {
    schemaVersion: 1,
    revision,
    features: { applets: false, pluginAuthoring: false, plugins: [] },
    compositionGenerationId: generationId,
  };
}

function ports(options?: {
  reads?: { count: number };
  accountRevision?: () => number;
  stampRevision?: () => number;
}): PreparationPortsV1 {
  const reads = options?.reads ?? { count: 0 };
  return {
    readAccount: async () => {
      reads.count += 1;
      return account(boot, options?.accountRevision?.() ?? 1);
    },
    readAccountStamp: async () =>
      stamp(
        boot.generationId,
        options?.stampRevision?.() ?? options?.accountRevision?.() ?? 1,
      ),
    readBot: async () => localBot(),
    readBotStamp: async () => ({
      settingsRevision: 2,
      pluginEnablementRevision: 4,
      compositionGenerationId: boot.generationId,
    }),
    adoptComposition: async () => undefined,
    ensureComposition: async () => boot,
  };
}

function skillMember(text: string, hash: string): CompositionMemberV1 {
  return {
    packageId: "email-card",
    version: "1",
    provenance: {
      kind: "user",
      packageId: "email-card",
      version: "1",
      userId: "user-1",
      authoredAt: "2026-09-22T00:00:00.000Z",
    },
    artifact: {
      contentHash: hash,
      size: text.length,
      mediaType: "application/javascript",
      bundlerVersion: "test",
    },
    descriptor: {
      id: "email-card",
      displayName: "Email",
      version: "1",
      contractVersion: 1,
      tools: [],
      hooks: [],
      grants: [],
      contextKeys: [],
      skills: [{ slug: "drafting", text }],
    },
  } as unknown as CompositionMemberV1;
}

describe("prepared turn inputs", () => {
  test("one gather reads the account once and clones into a distinct value", async () => {
    const reads = { count: 0 };
    const prepared = await gatherPreparedTurnInputsV1(
      IDENTITY,
      ports({ reads }),
    );
    expect(reads.count).toBe(1);
    expect(prepared.account.revision).toBe(1);
    expect(prepared.bot.pluginEnablementRevision).toBe(4);
    expect(prepared.context).toEqual({ revision: 3, sequence: 9 });
    expect(prepared.composition.requestedGenerationId).toBe(boot.generationId);
    expect(prepared.connections[0]).toMatchObject({
      connectionId: "ollama-1",
      generation: "generation-a",
      state: "ready",
    });
    expect(prepared.memory.cores.map((core) => core.scope)).toEqual([
      "user",
      "bot",
    ]);
    const clone = clonePreparedTurnInputsV1(prepared);
    clone.account.settings.profile.name = "changed";
    expect(prepared.account.settings.profile.name).toBe("Ada");
  });

  test("retries a moving account revision, then reports unavailable", async () => {
    let revision = 1;
    const reads = { count: 0 };
    await expect(
      withStablePreparationV1(() =>
        gatherPreparedTurnInputsV1(
          IDENTITY,
          ports({
            reads,
            accountRevision: () => revision,
            stampRevision: () => {
              const seen = revision;
              revision += 1;
              return seen + 1;
            },
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(PreparationUnavailableError);
    expect(reads.count).toBe(PREPARATION_ATTEMPTS_V1);
  });

  test("a single conflict then a stable read admits the later revision", async () => {
    let call = 0;
    const prepared = await withStablePreparationV1(() =>
      gatherPreparedTurnInputsV1(
        IDENTITY,
        ports({
          accountRevision: () => {
            call += 1;
            return call === 1 ? 1 : 5;
          },
          stampRevision: () => (call === 1 ? 2 : 5),
        }),
      ),
    );
    expect(prepared.account.revision).toBe(5);
    expect(call).toBe(2);
  });

  test("plugin skills follow the mounted generation, including fallback", () => {
    const enablement: PluginEnablementV1 = {
      ...emptyPluginEnablementV1(new Date(0)),
      enabled: { "email-card": true },
    };
    const admitted = pluginSkillsFromMembersV1(
      [skillMember("admitted instructions", "a".repeat(64))],
      enablement,
    );
    const fallback = pluginSkillsFromMembersV1(
      [skillMember("fallback instructions", "b".repeat(64))],
      enablement,
    );
    const newer = pluginSkillsFromMembersV1(
      [skillMember("newer instructions", "c".repeat(64))],
      enablement,
    );
    expect(admitted[0]?.skills[0]?.text).toBe("admitted instructions");
    expect(fallback[0]?.skills[0]?.text).toBe("fallback instructions");
    expect(newer[0]?.skills[0]?.text).toBe("newer instructions");
    expect(fallback[0]?.skills[0]?.text).not.toBe(newer[0]?.skills[0]?.text);
  });

  test("rejects a prepared value that carries a credential lease", () => {
    const value = {
      schemaVersion: 1,
      identity: IDENTITY,
      account: {
        revision: 1,
        settings: userSettings(),
        features: defaultUserFeaturesV1(),
      },
      bot: {
        revision: 0,
        pluginEnablementRevision: 0,
        enablement: emptyPluginEnablementV1(new Date(0)),
        settings: initializeBotSettingsV1("primary"),
      },
      composition: {
        requestedGenerationId: boot.generationId,
        mountedGenerationId: boot.generationId,
      },
      connections: [],
      skills: { indexes: [] },
      context: { revision: 0, sequence: 0 },
      memory: { cores: [] },
      lease: { secret: "nope" },
    };
    expect(() => decodePreparedTurnInputsV1(value)).toThrow(/invalid fields/);
  });
});
