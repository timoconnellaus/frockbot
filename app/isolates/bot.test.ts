// The whole grant surface hangs off `activeIsolateTurn`. Every Plugin in the
// User's one worker calls back with its own id in the scope the wrapper put
// on the call, so the gate is that the running generation mounted *that*
// Plugin — never a shared attribution id, and never a Plugin the generation
// does not hold.
import { describe, expect, test } from "bun:test";
import { SessionStore } from "@frockbot/core/contracts";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import type {
  ActiveTurnV1,
  ShellBotStateV1,
  StandaloneIsolateCallV1,
} from "../shell/backend-state.js";
import { approvalKeyV1 } from "../shell/approvals.js";
import {
  cardApprovalBindingKeyV1,
  cardApprovalUseKeyV1,
  cardValuesDigestV1,
} from "../shell/cards.js";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import {
  THEME_ASSEMBLE_DUE_KEY_V1,
  THEME_ASSEMBLE_RUN_PREFIX_V1,
} from "../theme/owed.js";
import {
  isolateEmail,
  isolateJevDecide,
  ISOLATE_JEV_CALLS_PER_RUN_V1,
  pluginJevUsageV1,
  isolateSchedule,
  isolateStorageDelete,
  isolateStoragePut,
  isolateWorkspaceRead,
  EMAIL_OWNER_COUNT_KEY_V1,
  EMAIL_OWNER_DAILY_LIMIT_V1,
  type IsolateCallScopeV1,
} from "./bot.ts";

const GENERATION = "2026-09-05T00:00:00.000Z:aaaaaaaaaaaaaaaa";

function scope(
  overrides: Partial<IsolateCallScopeV1> = {},
): IsolateCallScopeV1 {
  return {
    userId: "user-1",
    botId: "bot-1",
    runId: "run-1",
    sessionId: "user-1:bot-1",
    turnId: "run-1",
    packageId: "greeter",
    generationId: GENERATION,
    request: { root: { kind: "user-instructions" }, path: "notes.md" },
    ...overrides,
  };
}

function state(
  members: {
    packageId: string;
    artifact?: unknown;
    descriptor?: { hooks: readonly string[]; grants: readonly string[] };
  }[],
  standalone?: StandaloneIsolateCallV1,
) {
  const active = {
    runId: "run-1",
    sessionId: "user-1:bot-1",
    turnId: "run-1",
    generationId: GENERATION,
    turnType: "chat",
    mounted: { generation: { generationId: GENERATION, members } },
  } as unknown as ActiveTurnV1;
  return {
    turn: {
      current: standalone ? undefined : active,
      standalone: (runId: string) =>
        standalone?.runId === runId ? standalone : undefined,
    },
    env: {
      WORKSPACE_FILES: {
        read: () => Promise.resolve({ bytes: "hello" }),
      },
    },
  } as unknown as ShellBotStateV1;
}

describe("a capability call from the Plugin worker", () => {
  test("is served while the Turn that mounted the Plugin is running", async () => {
    const outcome = await isolateWorkspaceRead(
      state([{ packageId: "greeter", artifact: { contentHash: "a" } }]),
      scope(),
    );
    expect(outcome).toEqual({
      status: "available",
      value: { bytes: "hello" },
    });
  });

  test("is refused when the running generation did not mount that Plugin", async () => {
    expect(await isolateWorkspaceRead(state([]), scope())).toMatchObject({
      status: "unavailable",
    });
    expect(
      await isolateWorkspaceRead(
        state([{ packageId: "weather", artifact: { contentHash: "a" } }]),
        scope({ packageId: "greeter" }),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  test("is served for a standalone call this object registered, for the Plugin it mounted", async () => {
    const call: StandaloneIsolateCallV1 = {
      runId: "views:bot-1",
      sessionId: "user-1:bot-1",
      turnId: "views:bot-1",
      generationId: GENERATION,
      members: [{ packageId: "greeter", artifact: { contentHash: "a" } }],
    };
    const standalone = scope({ runId: "views:bot-1", turnId: "views:bot-1" });
    expect(await isolateWorkspaceRead(state([], call), standalone)).toEqual({
      status: "available",
      value: { bytes: "hello" },
    });
    expect(
      await isolateWorkspaceRead(
        state([], call),
        scope({
          runId: "views:bot-1",
          turnId: "views:bot-1",
          packageId: "weather",
        }),
      ),
    ).toMatchObject({ status: "unavailable" });
    expect(
      await isolateWorkspaceRead(
        state([], call),
        scope({ runId: "views:bot-2" }),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  test("is refused for another Turn than the one running", async () => {
    expect(
      await isolateWorkspaceRead(
        state([{ packageId: "greeter", artifact: { contentHash: "a" } }]),
        scope({ runId: "run-2" }),
      ),
    ).toMatchObject({ status: "unavailable" });
  });
});

describe("a scheduled tool replay", () => {
  test("treats reordered JSON input as the same idempotent call", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("user-1:bot-1");
    session.append({ type: "turn/start", turn: 1 });
    session.append({ type: "step/start", turn: 1, step: 1 });
    const effectId = `package-tool:${await sha256HexTextV1("greeter\0call-1")}`;
    session.append({
      type: "package/tool-call",
      turn: 1,
      step: 1,
      effectId,
      packageId: "greeter",
      callId: "call-1",
      name: "routine_manage",
      input: { first: 1, nested: { left: true, right: false } },
    });
    const subject = state([
      { packageId: "greeter", artifact: { contentHash: "a" } },
    ]);
    const mounted = subject.turn.current!.mounted as unknown as {
      runtime: unknown;
    };
    mounted.runtime = {
      services: {
        sessions,
        tools: {
          prepare: () =>
            Promise.resolve({
              kind: "denied" as const,
              result: { content: "not run", isError: true },
            }),
        },
      },
    } as never;

    const outcome = await isolateSchedule(subject, {
      ...scope(),
      request: {
        callId: "call-1",
        input: { nested: { right: false, left: true }, first: 1 },
      },
    });

    expect(outcome).toEqual({
      status: "completed",
      content: "not run",
      isError: true,
    });
  });
});

/**
 * The send loopback is the deployment's first irreversible outward effect, so
 * the decision behind it is the kernel's to require rather than the model's
 * to remember.
 */
describe("one email, sent for the Bot that asked", () => {
  const MESSAGE = {
    to: ["nick@example.com"],
    subject: "Re: Following up",
    body: "The whole message.",
  };
  const SURFACE = "email_draft.aaaaaaaa";
  const HOUR = 60 * 60 * 1_000;

  /** What the kernel wrote when it drew the card the decision was given on. */
  async function binding(
    overrides: {
      approvalIds?: string[];
      values?: Record<string, unknown>;
      pluginId?: string;
      surfaceId?: string;
    } = {},
  ) {
    const pluginId = overrides.pluginId ?? "email";
    const surfaceId = overrides.surfaceId ?? SURFACE;
    return {
      [cardApprovalBindingKeyV1(pluginId, surfaceId)]: {
        schemaVersion: 1,
        pluginId,
        surfaceId,
        digest: await cardValuesDigestV1(overrides.values ?? MESSAGE),
        approvalIds: overrides.approvalIds ?? ["ap-1"],
        createdAt: new Date(Date.now() - HOUR).toISOString(),
      },
    };
  }

  function approval(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      approvalId: "ap-1",
      runId: "run-1",
      sessionId: "user-1:bot-1",
      action: "Send an email to nick@example.com",
      risk: "medium",
      createdAt: new Date(Date.now() - HOUR).toISOString(),
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
      decision: "approved",
      decidedAt: new Date().toISOString(),
      decidedBy: "user",
      ...overrides,
    };
  }

  /** What the User object answers about this Bot's address. */
  const READY = {
    status: "ready",
    address: "fox.tim@bots.frock.test",
    name: "Fox",
    owner: ["tim@example.com", "tim@work.example"],
    signInEmail: "tim@example.com",
  };

  /** The Bot's state with a sender bound and whatever approvals it recorded. */
  function sending(
    records: Record<string, unknown> = {},
    identity: Record<string, unknown> = READY,
  ) {
    const values = new Map<string, unknown>(Object.entries(records));
    const sent: unknown[] = [];
    const storage = {
      get: (key: string) => Promise.resolve(values.get(key)),
      put: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => Promise.resolve(values.delete(key)),
      transaction: <T>(callback: (transaction: unknown) => Promise<T>) =>
        callback(storage),
    };
    const base = state([
      { packageId: "email", artifact: { contentHash: "a" } },
    ]) as unknown as Record<string, unknown>;
    return {
      sent,
      values,
      state: {
        ...base,
        ctx: { storage },
        env: {
          USER_CONFIGURATIONS: {
            idFromName: (name: string) => name,
            get: () => ({
              readBotEmailSender: () => Promise.resolve(identity),
            }),
          },
          EMAIL_SENDER: {
            domain: "bots.frock.test",
            send: (request: unknown) => {
              sent.push(request);
              return Promise.resolve({
                status: "sent" as const,
                messageId: "<sent@x.co>",
              });
            },
          },
        },
      } as unknown as ShellBotStateV1,
    };
  }

  function call(request: Record<string, unknown>): IsolateCallScopeV1 {
    return scope({ packageId: "email", request });
  }

  /** The request the email Plugin makes for the card the decision was on. */
  function requestValues(): Record<string, unknown> {
    return { ...MESSAGE, approvalId: "ap-1", surfaceId: SURFACE };
  }

  test("sends under an approved, unexpired, unspent decision bound to this card", async () => {
    const subject = sending({
      [approvalKeyV1("ap-1")]: approval(),
      ...(await binding()),
    });
    expect(
      await isolateEmail(subject.state, call(requestValues())),
    ).toMatchObject({ status: "sent" });
    // The approvalId and the surface are the kernel's gate, never part of
    // the message; the Bot's address is the kernel's to write, and a reply
    // reaches the person rather than the Bot.
    expect(subject.sent).toEqual([
      {
        ...MESSAGE,
        from: { address: "fox.tim@bots.frock.test", name: "Fox" },
        replyTo: "tim@example.com",
      },
    ]);
  });

  test("a Bot with no address yet spends no decision and says why", async () => {
    const subject = sending(
      { [approvalKeyV1("ap-1")]: approval(), ...(await binding()) },
      {
        status: "unavailable",
        reason: "email is switched off for you",
      },
    );
    expect(await isolateEmail(subject.state, call(requestValues()))).toEqual({
      status: "unavailable",
      reason: "email is switched off for you",
    });
    expect(subject.sent).toHaveLength(0);
    expect(subject.values.has(cardApprovalUseKeyV1("ap-1"))).toBe(false);
  });

  // The gate exists because the model is not trusted to remember the
  // decision, so it cannot be a gate the model passes by naming *any*
  // decision: an Approval authorizes the message it was given for.
  test("refuses an approved decision that was not given on this card", async () => {
    const subject = sending({
      // A decision the person really did give, on something else entirely.
      [approvalKeyV1("ap-1")]: approval({
        action: "Turn on the Weather plugin",
      }),
    });
    const outcome = await isolateEmail(subject.state, call(requestValues()));
    expect(outcome).toMatchObject({ status: "unavailable" });
    expect((outcome as { reason: string }).reason).toMatch(
      /was not the decision on card/,
    );
    expect(subject.sent).toHaveLength(0);
  });

  test("refuses a decision bound to another surface, or to another Plugin", async () => {
    for (const bound of [
      await binding({ surfaceId: "email_draft.bbbbbbbb" }),
      await binding({ pluginId: "other" }),
    ]) {
      const subject = sending({
        [approvalKeyV1("ap-1")]: approval(),
        ...bound,
      });
      const outcome = await isolateEmail(subject.state, call(requestValues()));
      expect(outcome).toMatchObject({ status: "unavailable" });
      expect((outcome as { reason: string }).reason).toMatch(
        /was not the decision on card/,
      );
      expect(subject.sent).toHaveLength(0);
    }
  });

  test("refuses a message whose recipients or body are not the ones approved", async () => {
    for (const changed of [
      { ...MESSAGE, to: ["someone-else@example.com"] },
      { ...MESSAGE, body: "Something the person never read." },
      { ...MESSAGE, cc: ["quiet@example.com"] },
    ]) {
      const subject = sending({
        [approvalKeyV1("ap-1")]: approval(),
        ...(await binding()),
      });
      const outcome = await isolateEmail(
        subject.state,
        call({ ...changed, approvalId: "ap-1", surfaceId: SURFACE }),
      );
      expect(outcome).toMatchObject({ status: "unavailable" });
      expect((outcome as { reason: string }).reason).toMatch(
        /given for different values/,
      );
      expect(subject.sent).toHaveLength(0);
    }
  });

  // The card is drawn with `cc: []` and the message is sent with no `cc` at
  // all; they are one value, not two, or every send would be refused.
  test("an absent field and an empty one are the same values", async () => {
    const subject = sending({
      [approvalKeyV1("ap-1")]: approval(),
      ...(await binding({
        values: { ...MESSAGE, cc: [], inReplyTo: "" },
      })),
    });
    expect(
      await isolateEmail(subject.state, call(requestValues())),
    ).toMatchObject({
      status: "sent",
    });
  });

  test("refuses a decision nobody gave, denied, or expired", async () => {
    for (const [records, pattern] of [
      [{}, /no Approval/],
      [
        { [approvalKeyV1("ap-1")]: approval({ decision: "pending" }) },
        /pending/,
      ],
      [{ [approvalKeyV1("ap-1")]: approval({ decision: "denied" }) }, /denied/],
      [
        {
          [approvalKeyV1("ap-1")]: approval({
            expiresAt: new Date(Date.now() - HOUR).toISOString(),
          }),
        },
        /expired/,
      ],
    ] as const) {
      const subject = sending({
        ...(records as Record<string, unknown>),
        ...(await binding()),
      });
      const outcome = await isolateEmail(subject.state, call(requestValues()));
      expect(outcome).toMatchObject({ status: "unavailable" });
      expect((outcome as { reason: string }).reason).toMatch(pattern);
      expect(subject.sent).toHaveLength(0);
    }
  });

  test("one decision sends at most one message", async () => {
    const subject = sending({
      [approvalKeyV1("ap-1")]: approval(),
      ...(await binding()),
    });
    const request = call(requestValues());
    expect(await isolateEmail(subject.state, request)).toMatchObject({
      status: "sent",
    });
    const replayed = await isolateEmail(subject.state, request);
    expect(replayed).toMatchObject({ status: "unavailable" });
    expect((replayed as { reason: string }).reason).toMatch(/already sent/);
    expect(subject.sent).toHaveLength(1);
  });

  test("a send that never left leaves the decision good to try again", async () => {
    const subject = sending({
      [approvalKeyV1("ap-1")]: approval(),
      ...(await binding()),
    });
    (
      subject.state as unknown as {
        env: { EMAIL_SENDER: { send: () => Promise<unknown> } };
      }
    ).env.EMAIL_SENDER.send = () =>
      Promise.resolve({ status: "unavailable", reason: "no route" });
    const request = call(requestValues());
    expect(await isolateEmail(subject.state, request)).toMatchObject({
      status: "unavailable",
      reason: "no route",
    });
    subject.state.env.EMAIL_SENDER = {
      domain: "bots.frock.test",
      send: (message: unknown) => {
        subject.sent.push(message);
        return Promise.resolve({
          status: "sent" as const,
          messageId: "<sent@x.co>",
        });
      },
    } as never;
    expect(await isolateEmail(subject.state, request)).toMatchObject({
      status: "sent",
    });
  });

  // A send nobody can vouch for may have reached its recipients, so the
  // decision stays spent: trying again could deliver the mail twice.
  test("a send whose outcome is unknown spends the decision", async () => {
    const subject = sending({
      [approvalKeyV1("ap-1")]: approval(),
      ...(await binding()),
    });
    let attempts = 0;
    subject.state.env.EMAIL_SENDER = {
      send: () => {
        attempts += 1;
        return Promise.resolve({
          status: "unknown" as const,
          reason: "the message may have been sent: internal",
        });
      },
    } as never;
    const request = call(requestValues());
    expect(await isolateEmail(subject.state, request)).toMatchObject({
      status: "unknown",
    });
    const replayed = await isolateEmail(subject.state, request);
    expect(replayed).toMatchObject({ status: "unavailable" });
    expect((replayed as { reason: string }).reason).toMatch(/already sent/);
    expect(attempts).toBe(1);
  });

  // The two causes are different facts about the deployment, and a person
  // told the wrong one is told this Bot cannot send mail when it can.
  test("admission and a missing sender are told apart", async () => {
    const subject = sending({
      [approvalKeyV1("ap-1")]: approval(),
      ...(await binding()),
    });
    const request = call(requestValues());
    expect(
      await isolateEmail(subject.state, { ...request, packageId: "other" }),
    ).toMatchObject({
      status: "unavailable",
      reason: "the Package is not running in this Bot's active Composition",
    });
    subject.state.env.EMAIL_SENDER = undefined as never;
    expect(await isolateEmail(subject.state, request)).toMatchObject({
      reason: "this deployment has no sender bound, so it sends no email",
    });
  });

  describe("a note to the Bot's own person", () => {
    const note = (fields: Record<string, unknown> = {}) =>
      call({
        owner: true,
        key: "email_owner.1",
        subject: "Agenda",
        body: "Done.",
        ...fields,
      });

    test("goes from the Bot to the address they sign in with, with no decision", async () => {
      const subject = sending();
      expect(await isolateEmail(subject.state, note())).toEqual({
        status: "sent",
        messageId: "<sent@x.co>",
        to: "tim@example.com",
      });
      expect(subject.sent).toEqual([
        {
          from: { address: "fox.tim@bots.frock.test", name: "Fox" },
          to: ["tim@example.com"],
          subject: "Agenda",
          body: "Done.",
        },
      ]);
    });

    test("reaches the person's own addresses and nobody else's", async () => {
      const subject = sending();
      expect(
        await isolateEmail(subject.state, note({ to: "Tim@Work.Example" })),
      ).toMatchObject({ status: "sent", to: "tim@work.example" });
      const stranger = await isolateEmail(
        subject.state,
        note({ key: "email_owner.2", to: "eve@evil.example" }),
      );
      expect(stranger).toMatchObject({ status: "unavailable" });
      expect((stranger as { reason: string }).reason).toMatch(
        /not one of your person's own addresses/,
      );
      expect(subject.sent).toHaveLength(1);
    });

    test("is sent at most once per key, whatever the outcome", async () => {
      const subject = sending();
      await isolateEmail(subject.state, note());
      expect(await isolateEmail(subject.state, note())).toEqual({
        status: "sent",
        messageId: "<sent@x.co>",
        to: "tim@example.com",
      });
      expect(subject.sent).toHaveLength(1);

      const lost = sending();
      lost.state.env.EMAIL_SENDER = {
        domain: "bots.frock.test",
        send: () => {
          lost.sent.push("attempt");
          return Promise.resolve({ status: "unknown", reason: "lost" });
        },
      } as never;
      expect(await isolateEmail(lost.state, note())).toMatchObject({
        status: "unknown",
      });
      expect(await isolateEmail(lost.state, note())).toMatchObject({
        status: "unknown",
      });
      expect(lost.sent).toHaveLength(1);
    });

    test("stops at the day's limit, and a note that never left does not count", async () => {
      const subject = sending();
      subject.state.env.EMAIL_SENDER = {
        domain: "bots.frock.test",
        send: () =>
          Promise.resolve({ status: "unavailable", reason: "no route" }),
      } as never;
      expect(await isolateEmail(subject.state, note())).toMatchObject({
        status: "unavailable",
        reason: "no route",
      });
      expect(subject.values.get(EMAIL_OWNER_COUNT_KEY_V1)).toMatchObject({
        count: 0,
      });
      subject.state.env.EMAIL_SENDER = {
        domain: "bots.frock.test",
        send: () =>
          Promise.resolve({ status: "sent", messageId: "<sent@x.co>" }),
      } as never;
      for (let index = 0; index < EMAIL_OWNER_DAILY_LIMIT_V1; index += 1) {
        expect(
          await isolateEmail(subject.state, note({ key: `note-${index}` })),
        ).toMatchObject({ status: "sent" });
      }
      const over = await isolateEmail(
        subject.state,
        note({ key: "one-too-many" }),
      );
      expect(over).toMatchObject({ status: "unavailable" });
      expect((over as { reason: string }).reason).toMatch(/today/);
      // A new day starts the count again.
      subject.values.set(EMAIL_OWNER_COUNT_KEY_V1, {
        schemaVersion: 1,
        day: "2000-01-01",
        count: EMAIL_OWNER_DAILY_LIMIT_V1,
      });
      expect(
        await isolateEmail(subject.state, note({ key: "tomorrow" })),
      ).toMatchObject({ status: "sent" });
    });

    test("answers the email the Turn came from, in its thread", async () => {
      const subject = sending({
        "run:run-1": {
          runId: "run-1",
          admission: {
            schemaVersion: 1,
            turnType: "chat",
            origin: { kind: "email", messageId: "m1@mail.example.com" },
          },
        },
      });
      await isolateEmail(subject.state, { ...note(), runId: "run-1" });
      expect(subject.sent[0]).toMatchObject({
        inReplyTo: "<m1@mail.example.com>",
      });
    });

    test("a person with no address the Bot knows is told so", async () => {
      const subject = sending(
        {},
        { ...READY, owner: [], signInEmail: undefined },
      );
      const outcome = await isolateEmail(subject.state, note());
      expect(outcome).toMatchObject({ status: "unavailable" });
      expect((outcome as { reason: string }).reason).toMatch(/draft card/);
    });
  });
});

describe("a Plugin that wraps the look writing its own storage", () => {
  const wraps = {
    packageId: "greeter",
    artifact: { contentHash: "a" },
    descriptor: { hooks: ["theme/assemble"], grants: [] },
  };
  function storageState(
    members: {
      packageId: string;
      artifact?: unknown;
      descriptor?: { hooks: readonly string[]; grants: readonly string[] };
    }[],
    standalone?: StandaloneIsolateCallV1,
  ) {
    const storage = new MemoryStorage();
    const refreshed: unknown[] = [];
    const subject = state(members, standalone) as unknown as {
      ctx: { storage: MemoryStorage };
      authority: { refreshRecoveryAlarm(transaction: unknown): Promise<void> };
    };
    subject.ctx = { storage };
    subject.authority = {
      refreshRecoveryAlarm: (transaction) => {
        refreshed.push(transaction);
        return Promise.resolve();
      },
    };
    return {
      bot: subject as unknown as ShellBotStateV1,
      storage,
      refreshed,
    };
  }
  const put = { key: "accent", value: "#ffd400" };

  test("owes an assemble now, and a Turn re-arms the alarm when it settles", async () => {
    const { bot, storage, refreshed } = storageState([wraps]);
    await isolateStoragePut(bot, scope({ request: put }));
    expect(storage.values.get(THEME_ASSEMBLE_DUE_KEY_V1)).toBeNumber();
    expect(refreshed).toHaveLength(0);
  });

  test("outside a Turn, re-arms the alarm itself", async () => {
    const call: StandaloneIsolateCallV1 = {
      runId: "views:bot-1",
      sessionId: "user-1:bot-1",
      turnId: "views:bot-1",
      generationId: GENERATION,
      members: [wraps],
    };
    const { bot, storage, refreshed } = storageState([], call);
    await isolateStoragePut(
      bot,
      scope({ runId: "views:bot-1", turnId: "views:bot-1", request: put }),
    );
    expect(storage.values.get(THEME_ASSEMBLE_DUE_KEY_V1)).toBeNumber();
    expect(refreshed).toHaveLength(1);
  });

  test("a delete of something it held owes one too", async () => {
    const { bot, storage } = storageState([wraps]);
    await isolateStoragePut(bot, scope({ request: put }));
    storage.values.delete(THEME_ASSEMBLE_DUE_KEY_V1);
    await isolateStorageDelete(bot, scope({ request: { key: "accent" } }));
    expect(storage.values.get(THEME_ASSEMBLE_DUE_KEY_V1)).toBeNumber();
  });

  test("owes nothing for a Plugin that does not wrap the look", async () => {
    const { bot, storage } = storageState([
      { ...wraps, descriptor: { hooks: ["tools/pre-execute"], grants: [] } },
    ]);
    await isolateStoragePut(bot, scope({ request: put }));
    expect(storage.values.has(THEME_ASSEMBLE_DUE_KEY_V1)).toBe(false);
  });

  test("owes nothing for the assemble's own write, or it would owe itself forever", async () => {
    const runId = `${THEME_ASSEMBLE_RUN_PREFIX_V1}one`;
    const call: StandaloneIsolateCallV1 = {
      runId,
      sessionId: "user-1:bot-1",
      turnId: runId,
      generationId: GENERATION,
      members: [wraps],
    };
    const { bot, storage } = storageState([], call);
    await isolateStoragePut(bot, scope({ runId, turnId: runId, request: put }));
    expect(storage.values.has(THEME_ASSEMBLE_DUE_KEY_V1)).toBe(false);
  });
});

describe("a Plugin's Jev decision", () => {
  const request = {
    state: { message: "Refund my order" },
    questions: {
      intent: {
        type: "choice",
        instructions: "What does the message want?",
        criteria: { refund: "A refund", other: "Anything else" },
      },
    },
  };
  const holder = (grants: string[]) =>
    state([
      {
        packageId: "greeter",
        artifact: { contentHash: "a" },
        descriptor: { hooks: [], grants },
      },
    ]);
  const recorded: unknown[] = [];
  const withJev = (target: ShellBotStateV1) => {
    (target as unknown as { env: Record<string, unknown> }).env = {
      JEV_API_KEY: "k",
      JEV_BASE_URL: "http://jev.test",
    };
    // The Turn's log, where the call is itemised under the Plugin.
    const session = {
      activeRunJournal: [{ type: "step/start", turn: 3, step: 2 }],
      append: (event: unknown) => recorded.push(event),
      flush: async () => {},
    };
    (
      target.turn.current as unknown as { mounted: Record<string, unknown> }
    ).mounted.runtime = { services: { sessions: { get: () => session } } };
    return target;
  };

  async function withFakeJev<T>(
    seen: unknown[],
    run: () => Promise<T>,
  ): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          intent: {
            type: "choice",
            choice: "refund",
            probabilities: { refund: 0.9, other: 0.1 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 42, output_tokens: 0 },
      });
    }) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = real;
    }
  }

  test("is answered for a Plugin that declared the grant, on the pinned model", async () => {
    const seen: unknown[] = [];
    const outcome = await withFakeJev(seen, () =>
      isolateJevDecide(withJev(holder(["jev"])), scope({ request })),
    );
    expect(outcome).toEqual({
      status: "available",
      value: {
        model: "jev-1.13.0",
        answers: {
          intent: {
            type: "choice",
            choice: "refund",
            probabilities: { refund: 0.9, other: 0.1 },
            confidence: 0.9,
          },
        },
        usage: { inputTokens: 42, outputTokens: 0 },
      },
    });
    expect(seen).toEqual([{ ...request, model: "jev-1.13.0" }]);
    expect(recorded.at(-1)).toMatchObject({
      type: "package/model-usage",
      turn: 3,
      step: 2,
      packageId: "greeter",
      provider: "jev",
      model: "jev-1.13.0",
      inputTokens: 42,
      outputTokens: 0,
      estimated: false,
    });
    expect(recorded.at(-1)).not.toHaveProperty("costMicros");
  });

  test("is refused to a Plugin that did not declare it, and without a key", async () => {
    const seen: unknown[] = [];
    await withFakeJev(seen, async () => {
      expect(
        await isolateJevDecide(withJev(holder(["ai"])), scope({ request })),
      ).toEqual({ status: "unavailable", reason: "Jev is not granted" });
      expect(
        await isolateJevDecide(holder(["jev"]), scope({ request })),
      ).toEqual({ status: "unavailable", reason: "Jev is unavailable" });
    });
    expect(seen).toEqual([]);
  });

  test("outside a Turn, is kept on the Bot as the Plugin's", async () => {
    const call: StandaloneIsolateCallV1 = {
      runId: "trigger:bot-1",
      sessionId: "user-1:bot-1",
      turnId: "trigger:bot-1",
      generationId: GENERATION,
      members: [
        {
          packageId: "greeter",
          artifact: { contentHash: "a" },
          descriptor: { hooks: [], grants: ["jev"] },
        },
      ],
    };
    const target = state([], call) as unknown as {
      env: Record<string, unknown>;
      ctx: { storage: MemoryStorage };
    };
    target.env = { JEV_API_KEY: "k", JEV_BASE_URL: "http://jev.test" };
    target.ctx = { storage: new MemoryStorage() };
    const bot = target as unknown as ShellBotStateV1;
    const outcome = await withFakeJev([], () =>
      isolateJevDecide(
        bot,
        scope({ runId: "trigger:bot-1", turnId: "trigger:bot-1", request }),
      ),
    );
    expect(outcome).toMatchObject({ status: "available" });
    expect(await pluginJevUsageV1(bot)).toEqual([
      {
        at: expect.any(String),
        runId: "trigger:bot-1",
        packageId: "greeter",
        requestId: expect.any(String),
        model: "jev-1.13.0",
        inputTokens: 42,
        outputTokens: 0,
        latencyMs: expect.any(Number),
      },
    ]);
  });

  test("a run spends at most its calls", async () => {
    const seen: unknown[] = [];
    const target = withJev(holder(["jev"]));
    const last = await withFakeJev(seen, async () => {
      for (let call = 0; call < ISOLATE_JEV_CALLS_PER_RUN_V1; call++) {
        await isolateJevDecide(target, scope({ request }));
      }
      return isolateJevDecide(target, scope({ request }));
    });
    expect(seen).toHaveLength(ISOLATE_JEV_CALLS_PER_RUN_V1);
    expect(last).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("64 Jev calls"),
    });
  });
});
