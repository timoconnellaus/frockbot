import { describe, expect, test } from "bun:test";
import { decodePluginDescriptorV1 } from "@frockbot/core/contracts";
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
  test("its approval id is the Turn's effect id, mapped into the card's alphabet", () => {
    expect(pluginApprovalIdV1("tool:1:2:0")).toBe("tool.1.2.0");
    expect(pluginApprovalIdV1(":x")).toBe("p.x");
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
      status: "failed",
      reason: "late",
      at: "2026-09-12T00:04:00.000Z",
    });
    expect(again?.outcome?.status).toBe("applied");
  });

  test("the card says what the Plugin reaches, and open network is high risk", () => {
    const action = pluginApprovalActionV1(MEMBER, "Run");
    expect(action).toContain('Run the Plugin "Notes" (notes, version 1)');
    expect(action).toContain("note_add");
    expect(action).toContain("agent/tool-exposure");
    expect(action).toContain("storage, http");
    expect(action).toContain("api.example.com");
    expect(pluginApprovalRiskV1(MEMBER)).toBe("high");
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
});
