// The Bot Durable Object's side of Applets: the focus it holds, and what it
// does when the Applet that focus names is gone.
import { describe, expect, test } from "bun:test";
import { APPLET_FOCUSED_KEY, type BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { readFocusedApplet, setFocusedApplet } from "./bot.js";

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
