// The Bot Durable Object's side of Applets: the focus it holds, and what it
// does when the Applet that focus names is gone.
import { describe, expect, test } from "bun:test";
import { APPLET_FOCUSED_KEY, type BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { PACKAGE_IFRAME_FOCUS_TOOL_V2 } from "@frockbot/core/contracts";
import { listPackageUi } from "@frockbot/app/skills/bot";
import {
  appletsRuntimeHost,
  readFocusedApplet,
  resolveAppletComposition,
  setFocusedApplet,
} from "./bot.js";

const IDENTITY: BotIdentity = { userId: "user-42", botId: "bot-1" };
const APPLET = `${IDENTITY.userId}.${"a".repeat(32)}`;

function summary(appletId: string) {
  return {
    appletId,
    displayName: "Todo",
    status: "published",
    currentGenerationId: "g1",
    tools: [],
    createdAt: "2026-09-05T01:00:00.000Z",
  };
}

function harness(options: {
  applets?: string[];
  unreachable?: boolean;
  duringList?: () => Promise<void>;
}) {
  const values = new Map<string, unknown>();
  let listed = 0;
  const rpc = {
    listApplets: async () => {
      listed += 1;
      if (options.unreachable) throw new Error("the directory is unavailable");
      // The Bot's input gate is open across this call, so anything the
      // harness does here is what another request did while it was in flight.
      await options.duringList?.();
      return {
        revision: 1,
        applets: (options.applets ?? []).map(summary),
      };
    },
  };
  const state = {
    ctx: {
      storage: {
        get: (key: string) => Promise.resolve(values.get(key)),
        put: (entries: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(entries))
            values.set(key, value);
          return Promise.resolve();
        },
      },
    },
    env: {
      USER_CONFIGURATIONS: {
        idFromName: (name: string) => name,
        get: () => rpc,
      },
    },
    authority: { validateIdentity: () => Promise.resolve() },
  } as unknown as ShellBotStateV1;
  return { state, values, reads: () => listed };
}

describe("the focused Applet", () => {
  test("an unset focus is null and reads no directory", async () => {
    const { state, reads } = harness({});
    expect(await readFocusedApplet(state, IDENTITY)).toMatchObject({
      appletId: null,
    });
    expect(reads()).toBe(0);
  });

  test("a focus the directory still lists is kept", async () => {
    const { state } = harness({ applets: [APPLET] });
    await setFocusedApplet(state, IDENTITY, APPLET);
    expect(await readFocusedApplet(state, IDENTITY)).toMatchObject({
      appletId: APPLET,
    });
  });

  test("a focus whose Applet was deleted is cleared durably", async () => {
    // Deletion through the User's own Applets list reaches the User's
    // directory and no Bot's storage, so this Bot's focus is the only place
    // the deleted id survives.
    const deleted = harness({ applets: [] });
    await setFocusedApplet(deleted.state, IDENTITY, APPLET);
    expect(await readFocusedApplet(deleted.state, IDENTITY)).toMatchObject({
      appletId: null,
    });
    expect(deleted.values.get(APPLET_FOCUSED_KEY)).toMatchObject({
      appletId: null,
    });

    // Cleared in storage, not only in the answer: a later read that cannot
    // reach the directory at all still sees no focus.
    const offline = harness({ unreachable: true });
    offline.values.set(
      APPLET_FOCUSED_KEY,
      deleted.values.get(APPLET_FOCUSED_KEY),
    );
    expect(await readFocusedApplet(offline.state, IDENTITY)).toMatchObject({
      appletId: null,
    });
    expect(offline.reads()).toBe(0);
  });

  test("a focus set while the directory read was in flight is not overwritten", async () => {
    // The panel polls the focus route, so a read is usually in flight when the
    // User picks an Applet. The stale id the read is clearing says nothing
    // about the one the User just chose.
    const NEXT = `${IDENTITY.userId}.${"b".repeat(32)}`;
    const picked = harness({
      applets: [NEXT],
      duringList: async () => {
        await setFocusedApplet(picked.state, IDENTITY, NEXT);
      },
    });
    await setFocusedApplet(picked.state, IDENTITY, APPLET);
    expect(await readFocusedApplet(picked.state, IDENTITY)).toMatchObject({
      appletId: NEXT,
    });
    expect(picked.values.get(APPLET_FOCUSED_KEY)).toMatchObject({
      appletId: NEXT,
    });
  });

  test("a directory that cannot be read leaves the focus alone", async () => {
    const { state, values } = harness({ unreachable: true });
    values.set(APPLET_FOCUSED_KEY, {
      schemaVersion: 1,
      appletId: APPLET,
      changedAt: "2026-09-05T01:00:00.000Z",
    });
    expect(await readFocusedApplet(state, IDENTITY)).toMatchObject({
      appletId: APPLET,
    });
    expect(values.get(APPLET_FOCUSED_KEY)).toMatchObject({
      appletId: APPLET,
    });
  });
});

// --- The account's Applets switch ------------------------------------------

const TURN = { sessionId: "user-42:bot-1", runId: "run-1", turnId: "turn-1" };

/**
 * A Bot host with everything Applets need bound, whose User Durable Object
 * answers the features read as the harness says.
 */
function gatedHarness(options: {
  applets: boolean | "unreachable";
  directory?: Array<{ appletId: string; generationId: string }>;
  current?: { generationId: string; applets?: unknown[] };
}) {
  const values = new Map<string, unknown>();
  const proposed: unknown[] = [];
  let directoryReads = 0;
  const rpc = {
    readFeatures: () => {
      if (options.applets === "unreachable") {
        throw new Error("the User object is unavailable");
      }
      return Promise.resolve({
        schemaVersion: 1,
        applets: options.applets,
        updatedAt: "2026-09-11T00:00:00.000Z",
        updatedBy: "owner",
      });
    },
    readAppletCompositionInput: () => {
      directoryReads += 1;
      return Promise.resolve({
        revision: 3,
        applets: (options.directory ?? []).map((entry) => ({
          ...entry,
          tools: [],
          provenance: {
            kind: "bot",
            botId: "bot-1",
            sessionId: TURN.sessionId,
            turnId: TURN.turnId,
          },
        })),
      });
    },
    // The Composition is the User's, so a proposal a Turn makes lands here.
    readComposition: () => Promise.resolve({ current, lastKnownGood: current }),
    proposeComposition: (request: { generation: unknown }) => {
      proposed.push(request.generation);
      return Promise.resolve();
    },
  };
  const current = {
    generationId: "g0",
    members: [],
    ...(options.current ?? {}),
  };
  const state = {
    ctx: {
      storage: {
        get: (key: string) => Promise.resolve(values.get(key)),
        put: (entries: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(entries))
            values.set(key, value);
          return Promise.resolve();
        },
      },
    },
    env: {
      USER_CONFIGURATIONS: {
        idFromName: (name: string) => name,
        get: () => rpc,
      },
      APPLET_STATES: {},
      APPLICATION_ARTIFACTS: {},
      WORKSPACE_FILES: {},
    },
    authority: { validateIdentity: () => Promise.resolve() },
  } as unknown as ShellBotStateV1;
  return { state, proposed, directoryReads: () => directoryReads };
}

describe("the account's Applets switch", () => {
  test("the tools are mounted only when the switch is on", async () => {
    const on = gatedHarness({ applets: true });
    expect(await appletsRuntimeHost(on.state, IDENTITY, TURN)).toMatchObject({
      turn: TURN,
    });
    const off = gatedHarness({ applets: false });
    expect(await appletsRuntimeHost(off.state, IDENTITY, TURN)).toBeUndefined();
  });

  test("a switch that cannot be read mounts nothing for the Turn", async () => {
    const { state } = gatedHarness({ applets: "unreachable" });
    expect(await appletsRuntimeHost(state, IDENTITY, TURN)).toBeUndefined();
  });

  test("with the switch off, a Composition holding Applets resolves to none", async () => {
    const command = {
      userId: IDENTITY.userId,
      botId: IDENTITY.botId,
      runId: TURN.runId,
      sessionId: TURN.sessionId,
    } as never;
    const off = gatedHarness({
      applets: false,
      directory: [{ appletId: APPLET, generationId: "ag1" }],
      current: {
        generationId: "g1",
        applets: [{ appletId: APPLET, generationId: "ag1", tools: [] }],
      },
    });
    await resolveAppletComposition(off.state, IDENTITY, command);
    expect(off.proposed).toHaveLength(1);
    expect(off.proposed[0]).not.toHaveProperty("applets");

    // Turned back on, the same directory comes back as members.
    const on = gatedHarness({
      applets: true,
      directory: [{ appletId: APPLET, generationId: "ag1" }],
      current: { generationId: "g2" },
    });
    await resolveAppletComposition(on.state, IDENTITY, command);
    expect(on.proposed).toHaveLength(1);
    expect(on.proposed[0]).toMatchObject({
      applets: [{ appletId: APPLET, generationId: "ag1" }],
    });
  });

  test("a switch that cannot be read still answers the package catalog", async () => {
    const focusable = (catalog: {
      contributions: Array<{ declaredTools: readonly string[] }>;
    }) =>
      catalog.contributions.some((contribution) =>
        contribution.declaredTools.includes(PACKAGE_IFRAME_FOCUS_TOOL_V2),
      );
    const on = gatedHarness({ applets: true });
    expect(focusable(await listPackageUi(on.state, IDENTITY))).toBe(true);
    const { state } = gatedHarness({ applets: "unreachable" });
    expect(focusable(await listPackageUi(state, IDENTITY))).toBe(false);
  });

  test("a switch that cannot be read leaves the Composition alone", async () => {
    const command = {
      userId: IDENTITY.userId,
      botId: IDENTITY.botId,
      runId: TURN.runId,
      sessionId: TURN.sessionId,
    } as never;
    const { state, proposed, directoryReads } = gatedHarness({
      applets: "unreachable",
      directory: [{ appletId: APPLET, generationId: "ag1" }],
    });
    await resolveAppletComposition(state, IDENTITY, command);
    expect(proposed).toHaveLength(0);
    expect(directoryReads()).toBe(0);
  });
});
