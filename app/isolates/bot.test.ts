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
  cardValuesDigestV1,
} from "../shell/cards.js";
import {
  isolateEmail,
  isolateSchedule,
  isolateWorkspaceRead,
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
  members: { packageId: string; artifact?: unknown }[],
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

  /** The Bot's state with a sender bound and whatever approvals it recorded. */
  function sending(records: Record<string, unknown> = {}) {
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
          EMAIL_SENDER: {
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
    // the message.
    expect(subject.sent).toEqual([MESSAGE]);
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
});
