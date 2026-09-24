import { describe, expect, test } from "bun:test";
import {
  decodePluginDescriptorV1,
  decodeSendToUserPayloadV1,
} from "@frockbot/core/contracts";
import type { CompositionMemberV1 } from "@frockbot/core/durable";
import {
  decodePluginIntentRecordV1,
  pluginApprovalActionV1,
  pluginApprovalIdV1,
  pluginApprovalRiskV1,
  pluginIntentKeyV1,
  recordPluginIntentOutcomeV1,
  settlePluginIntentV1,
  type PluginIntentRecordV1,
} from "./approval.js";
import { DEPLOYMENT_PLUGIN_CATALOG_V1 } from "./catalog.js";

const DESCRIPTOR = decodePluginDescriptorV1({
  id: "notes",
  displayName: "Notes",
  version: "1",
  contractVersion: 4,
  tools: [{ name: "note_add", description: "Keep a note.", inputSchema: {} }],
  hooks: ["agent/tool-exposure"],
  grants: ["storage", "http"],
  network: { hosts: ["api.example.com"] },
  contextKeys: ["user", "bot", "session"],
});

const MEMBER: CompositionMemberV1 = {
  packageId: "notes",
  version: "1",
  provenance: {
    kind: "bot",
    packageId: "notes",
    version: "1",
    botId: "bot-1",
    sessionId: "user-1:bot-1",
    turnId: "run-1",
    runId: "run-1",
    authoredAt: "2026-09-12T00:00:00.000Z",
  },
  artifact: {
    contentHash: "a".repeat(64),
    size: 12,
    mediaType: "application/javascript",
    bundlerVersion: "applet-build/plugin@1",
  },
  descriptor: DESCRIPTOR,
};

const INTENT: PluginIntentRecordV1 = {
  schemaVersion: 1,
  approvalId: "tool.1.2.0",
  botId: "bot-1",
  sessionId: "user-1:bot-1",
  runId: "run-1",
  turnId: "run-1",
  createdAt: "2026-09-12T00:00:00.000Z",
  action: { kind: "publish", member: MEMBER },
};

function storage(seed: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    map,
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    put: (key: string, value: unknown) => {
      map.set(key, structuredClone(value));
      return Promise.resolve();
    },
  };
}

describe("a Plugin intent", () => {
  test("its approval id is one identity per occurrence, in the card's alphabet", async () => {
    const id = await pluginApprovalIdV1("run-9", "tool:1:2:0");
    expect(id).toMatch(/^plugin-[0-9a-f]{32}$/);
    expect(await pluginApprovalIdV1("run-9", "tool:1:2:0")).toBe(id);
    // Effect ids restart in every Session, so another run's same effect is
    // another intent.
    expect(await pluginApprovalIdV1("run-10", "tool:1:2:0")).not.toBe(id);
  });

  test("decodes exactly, and refuses a member a User wrote", () => {
    expect(decodePluginIntentRecordV1(INTENT)).toEqual(INTENT);
    expect(() =>
      decodePluginIntentRecordV1({ ...INTENT, extra: true }),
    ).toThrow(/unexpected key/);
    expect(() =>
      decodePluginIntentRecordV1({
        ...INTENT,
        action: {
          kind: "publish",
          member: {
            ...MEMBER,
            provenance: {
              kind: "user",
              packageId: "notes",
              version: "1",
              userId: "user-1",
              authoredAt: "2026-09-12T00:00:00.000Z",
            },
          },
        },
      }),
    ).toThrow(/Bot-authored/);
    expect(
      decodePluginIntentRecordV1({
        ...INTENT,
        action: { kind: "enable", pluginId: "notes" },
      }).action,
    ).toEqual({ kind: "enable", pluginId: "notes" });
  });

  test("the first decision wins, and a card that is not a Plugin's is nobody's business", async () => {
    const store = storage({ [pluginIntentKeyV1(INTENT.approvalId)]: INTENT });
    expect(
      await settlePluginIntentV1(
        store,
        "other",
        "approved",
        "2026-09-12T00:01:00.000Z",
      ),
    ).toBe(undefined);
    const settled = await settlePluginIntentV1(
      store,
      INTENT.approvalId,
      "denied",
      "2026-09-12T00:01:00.000Z",
    );
    expect(settled).toMatchObject({
      decision: "denied",
      decidedAt: "2026-09-12T00:01:00.000Z",
    });
    const replayed = await settlePluginIntentV1(
      store,
      INTENT.approvalId,
      "approved",
      "2026-09-12T00:02:00.000Z",
    );
    expect(replayed?.decision).toBe("denied");
  });

  test("an outcome is recorded once, only after an approval", async () => {
    const store = storage({ [pluginIntentKeyV1(INTENT.approvalId)]: INTENT });
    const untouched = await recordPluginIntentOutcomeV1(
      store,
      INTENT.approvalId,
      { status: "applied", at: "2026-09-12T00:02:00.000Z" },
    );
    expect(untouched?.outcome).toBeUndefined();
    await settlePluginIntentV1(
      store,
      INTENT.approvalId,
      "approved",
      "2026-09-12T00:02:30.000Z",
    );
    const applied = await recordPluginIntentOutcomeV1(
      store,
      INTENT.approvalId,
      { status: "applied", generationId: "g2", at: "2026-09-12T00:03:00.000Z" },
    );
    expect(applied?.outcome).toEqual({
      status: "applied",
      generationId: "g2",
      at: "2026-09-12T00:03:00.000Z",
    });
    const again = await recordPluginIntentOutcomeV1(store, INTENT.approvalId, {
      status: "applied",
      generationId: "g3",
      at: "2026-09-12T00:04:00.000Z",
    });
    expect(again?.outcome).toEqual({
      status: "applied",
      generationId: "g2",
      at: "2026-09-12T00:03:00.000Z",
    });
  });

  test("a card for the widest descriptor a Bot may publish still decodes as a send", () => {
    const descriptor = decodePluginDescriptorV1({
      id: "notes",
      displayName: "Notes",
      version: "1",
      contractVersion: 4,
      tools: Array.from({ length: 64 }, (_unused, index) => ({
        name: `note_${index}_${"t".repeat(50)}`.slice(0, 64),
        description: "Keep a note.",
        inputSchema: {},
      })),
      hooks: ["agent/tool-exposure"],
      grants: ["storage", "http"],
      network: {
        hosts: Array.from(
          { length: 32 },
          (_unused, index) =>
            `h${index}.${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.example.com`,
        ),
      },
      contextKeys: ["user", "bot", "session"],
    });
    const action = pluginApprovalActionV1({ descriptor }, "Run");
    expect(action.length).toBe(2_000);
    expect(
      decodeSendToUserPayloadV1({
        type: "approval",
        approvalId: "tool.1.1.0",
        action,
        rationale: "The Bot built this Plugin and asks to run it.",
        risk: pluginApprovalRiskV1({ descriptor }),
      }),
    ).toMatchObject({ type: "approval", action });
  });

  test("the card says what the Plugin reaches, and open network is high risk", () => {
    const action = pluginApprovalActionV1(MEMBER, "Run");
    expect(action).toContain('Run the Plugin "Notes" (notes, version 1)');
    expect(action).toContain("note_add");
    expect(action).toContain("agent/tool-exposure");
    expect(action).toContain("storage, http");
    expect(action).toContain("api.example.com");
    expect(pluginApprovalRiskV1(MEMBER)).toBe("high");
    const themed = pluginApprovalActionV1(
      {
        descriptor: {
          ...DESCRIPTOR,
          hooks: ["theme/assemble"],
          grants: [],
          network: undefined,
        },
      },
      "Run",
    );
    expect(themed).toContain("theme/assemble");
    expect(themed).toContain("This Plugin can change how this Bot looks.");
    const quiet = {
      descriptor: { ...DESCRIPTOR, grants: [], network: undefined, hooks: [] },
    };
    expect(pluginApprovalRiskV1(quiet)).toBe("low");
    expect(
      pluginApprovalRiskV1({
        descriptor: {
          ...DESCRIPTOR,
          grants: ["http"],
          network: { open: true },
        },
      }),
    ).toBe("high");
    expect(
      pluginApprovalActionV1(
        {
          descriptor: {
            ...DESCRIPTOR,
            grants: ["http"],
            network: { open: true },
          },
        },
        "Turn on",
      ),
    ).toContain("every Plugin on this account");
  });

  test("the card names the card tools and what http opens", () => {
    const descriptor = decodePluginDescriptorV1({
      id: "mailer",
      displayName: "Mailer",
      version: "1",
      contractVersion: 5,
      tools: [],
      hooks: [],
      grants: ["http"],
      network: { hosts: [] },
      cards: [
        {
          id: "draft",
          displayName: "Draft",
          description: "Show a draft.",
          dataSchema: { type: "object", properties: {} },
          actions: [{ name: "details", description: "Show the headers." }],
        },
      ],
      contextKeys: ["user", "bot", "session"],
    });
    const action = pluginApprovalActionV1({ descriptor }, "Turn on");
    expect(action).toContain("It offers mailer_draft.");
    expect(action).not.toContain("It offers no tools.");
    expect(action).not.toContain("It reaches no host of its own.");
    expect(action).toContain("send email on the Bot's behalf");
  });

  test("declared hosts and the email sender are both named", () => {
    const action = pluginApprovalActionV1(MEMBER, "Run");
    expect(action).toContain("It reaches api.example.com.");
    expect(action).toContain("send email on the Bot's behalf");
  });

  test("a Plugin without http reaches no host of its own", () => {
    const action = pluginApprovalActionV1(
      { descriptor: { ...DESCRIPTOR, grants: ["storage"] } },
      "Run",
    );
    expect(action).toContain("It reaches api.example.com.");
    expect(action).not.toContain("send email");
  });
});

describe("what a card says about a page that listens", () => {
  const listening = (grants: string[], extra: Record<string, unknown> = {}) =>
    decodePluginDescriptorV1({
      id: "tuner",
      displayName: "Tuner",
      version: "1",
      contractVersion: 7,
      tools: [],
      hooks: [],
      grants,
      device: { abilities: ["microphone"] },
      views: [
        { slot: "conversation.panel", surfaceId: "tuner", page: "tuner.html" },
      ],
      contextKeys: ["user", "bot", "session"],
      ...extra,
    });

  test("says the page can use the microphone, with a Stop, and where it goes", () => {
    const descriptor = listening(["device"]);
    const action = pluginApprovalActionV1({ descriptor }, "Run");
    expect(action).toContain("draws its own web page");
    expect(action).toContain(
      "Its page can use your microphone while you have it open",
    );
    expect(action).toContain("reaches only this Plugin's own tools");
    expect(pluginApprovalRiskV1({ descriptor })).toBe("medium");
  });

  test("is high when the Plugin that hears can also reach the network", () => {
    const descriptor = listening(["http", "device"], {
      network: { hosts: ["api.example.com"] },
    });
    expect(pluginApprovalRiskV1({ descriptor })).toBe("high");
  });
});

describe("what a card says about a declared model provider", () => {
  /** The deployment's own DeepSeek artifact, as the catalog ships it. */
  function claimedMember(contentHash: string, id = "deepseek") {
    return {
      ...MEMBER,
      packageId: id,
      artifact: { ...MEMBER.artifact, contentHash },
      descriptor: decodePluginDescriptorV1({
        id,
        displayName: id,
        version: "1",
        contractVersion: 4,
        tools: [],
        hooks: [],
        grants: [],
        modelProviders: [{ id: "deepseek", protocolVersion: 1 }],
        contextKeys: ["user", "bot", "session"],
      }),
    };
  }

  test("the deployment's own Plugin, at its own artifact, is the one that carries the credential", () => {
    const authoritative = DEPLOYMENT_PLUGIN_CATALOG_V1.find(
      (plugin) => plugin.pluginId === "deepseek",
    )!;
    const action = pluginApprovalActionV1(
      claimedMember(authoritative.artifact.contentHash),
      "Run",
    );
    expect(action).toContain("It provides DeepSeek models.");
    expect(action).toContain("the key never reaches the Plugin");
  });

  test("a Plugin claiming the provider at another artifact carries no credential, and the card says so", () => {
    for (const claimed of [
      // A Bot-written Plugin naming itself after the provider.
      claimedMember("b".repeat(64)),
      // A member whose descriptor is right but whose bytes are not.
      claimedMember("b".repeat(64), "shadow"),
    ]) {
      const action = pluginApprovalActionV1(claimed, "Run");
      expect(action).toContain(
        "It declares the deepseek model provider this deployment does not serve through this Plugin",
      );
      expect(action).not.toContain("the key never reaches the Plugin");
    }
  });

  test("a provider the deployment serves through no Plugin at all is refused the same way", () => {
    const action = pluginApprovalActionV1(
      {
        ...claimedMember("b".repeat(64)),
        descriptor: decodePluginDescriptorV1({
          id: "shadow",
          displayName: "Shadow",
          version: "1",
          contractVersion: 4,
          tools: [],
          hooks: [],
          grants: [],
          modelProviders: [{ id: "openai", protocolVersion: 1 }],
          contextKeys: ["user", "bot", "session"],
        }),
      },
      "Run",
    );
    expect(action).toContain("does not serve through this Plugin");
  });
});
