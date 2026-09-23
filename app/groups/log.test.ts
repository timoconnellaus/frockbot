import { describe, expect, test } from "bun:test";
import {
  GROUP_ADMISSION_ATTEMPTS_V1,
  GroupChatLogV1,
  type GroupEffectV1,
  type GroupKvV1,
  type GroupListOptionsV1,
} from "./log.js";
import {
  GROUP_BOT_CHAIN_MAX_V1,
  GroupChatConflictError,
  type GroupChatContextV1,
} from "./shared.js";

/** Sorted in-memory storage with the list options a Durable Object has. */
function memoryKv(): GroupKvV1 & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    keys: () => [...map.keys()].sort(),
    get: <T>(key: string) =>
      Promise.resolve(structuredClone(map.get(key)) as T),
    put: (key, value) => {
      map.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(map.delete(key)),
    list: <T>(options: GroupListOptionsV1) => {
      let keys = [...map.keys()].sort();
      if (options.prefix)
        keys = keys.filter((key) => key.startsWith(options.prefix!));
      if (options.start) keys = keys.filter((key) => key >= options.start!);
      if (options.end) keys = keys.filter((key) => key < options.end!);
      if (options.reverse) keys.reverse();
      if (options.limit !== undefined) keys = keys.slice(0, options.limit);
      return Promise.resolve(
        new Map(keys.map((key) => [key, structuredClone(map.get(key)) as T])),
      );
    },
  };
}

const members = [
  { botId: "fox", name: "Fox" },
  { botId: "dog", name: "Dog" },
  { botId: "owl", name: "Night Owl" },
];

function context(
  overrides: Partial<GroupChatContextV1["group"]> = {},
): GroupChatContextV1 {
  return {
    schemaVersion: 1,
    group: {
      schemaVersion: 1,
      groupId: "g-0123456789abcdef0123",
      members: ["fox", "dog", "owl"],
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z",
      ...overrides,
    },
    members,
  };
}

async function freshLog() {
  const kv = memoryKv();
  const log = new GroupChatLogV1(
    kv,
    () => new Date("2026-09-23T10:00:00.000Z"),
  );
  await log.initialize({
    schemaVersion: 1,
    userId: "user-1",
    groupId: "g-0123456789abcdef0123",
  });
  return { kv, log };
}

function admits(effects: readonly GroupEffectV1[]) {
  return effects.filter(
    (effect): effect is Extract<GroupEffectV1, { kind: "admit" }> =>
      effect.kind === "admit",
  );
}

async function userSays(log: GroupChatLogV1, id: string, text: string) {
  return log.post({
    messageId: `u-${id}`,
    author: { kind: "user" },
    text,
    context: context(),
  });
}

describe("a Group Chat's thread", () => {
  test("a message the person sends is written once, with its mentions", async () => {
    const { log } = await freshLog();
    const first = await userSays(
      log,
      "c1",
      "@Fox and @night owl, plan the trip",
    );
    const again = await userSays(
      log,
      "c1",
      "@Fox and @night owl, plan the trip",
    );
    expect(first.value.seq).toBe(1);
    expect(again.value.seq).toBe(1);
    expect(again.effects).toEqual([]);
    expect(first.value.body).toEqual({
      kind: "text",
      text: "@Fox and @night owl, plan the trip",
      mentions: [
        { botId: "fox", start: 0, end: 4 },
        { botId: "owl", start: 9, end: 19 },
      ],
    });
  });

  test("each member the person mentions is asked for a Turn, and nobody else", async () => {
    const { log } = await freshLog();
    const posted = await userSays(
      log,
      "c1",
      "@Fox and @Night Owl, plan the trip",
    );
    const asked = admits(posted.effects);
    expect(asked.map((effect) => effect.botId).sort()).toEqual(["fox", "owl"]);
    const fox = asked.find((effect) => effect.botId === "fox")!.admission;
    expect(fox.sessionId).toBe("group:g-0123456789abcdef0123");
    expect(fox.runId).toMatch(/^grp-[0-9a-f]{32}$/);
    expect(fox.origin).toMatchObject({
      kind: "group",
      groupId: "g-0123456789abcdef0123",
      groupName: "Fox, Dog & Night Owl",
      throughSeq: 1,
      reason: "mention",
    });
    expect(fox.text).toContain("User: @Fox and @Night Owl, plan the trip");
    expect(fox.text).toContain(
      "Members: Fox (you), Dog, Night Owl, and your User",
    );
  });

  test("an unanswered admission is asked for again with exactly the same bytes", async () => {
    const { log } = await freshLog();
    const first = admits((await userSays(log, "c1", "@Fox hi")).effects)[0]!;
    const retried = admits(await log.owedAdmissions())[0]!;
    expect(retried.admission).toEqual(first.admission);
    await log.admitted("fox", first.admission.runId);
    expect(await log.owedAdmissions()).toEqual([]);
    expect(await log.openTurns()).toEqual([
      { botId: "fox", runId: first.admission.runId },
    ]);
  });

  test("a Turn reported before its admission was written down still settles", async () => {
    const { log } = await freshLog();
    const turn = admits((await userSays(log, "c1", "@Fox hi")).effects)[0]!;
    const settled = await log.applyTurnState({
      botId: "fox",
      runId: turn.admission.runId,
      state: {
        status: "completed",
        started: true,
        sends: [{ occurrence: 2, text: "Hi!", at: "2026-09-23T10:00:01.000Z" }],
        yielded: false,
      },
      context: context(),
    });
    expect(await log.openTurns()).toEqual([]);
    expect(await log.owedAdmissions()).toEqual([]);
    expect(settled.effects).toContainEqual({ kind: "broadcast" });
    // The admission answer arriving afterwards changes nothing.
    await log.admitted("fox", turn.admission.runId);
    expect(await log.openTurns()).toEqual([]);
  });

  test("a member already working waits its turn, and is told a message arrived", async () => {
    const { log } = await freshLog();
    const first = admits((await userSays(log, "c1", "@Fox hi")).effects)[0]!;
    await log.admitted("fox", first.admission.runId);
    const second = await userSays(log, "c2", "@Fox and one more thing");
    expect(admits(second.effects)).toEqual([]);
    expect(second.effects).toContainEqual({
      kind: "signal",
      botId: "fox",
      seq: 2,
    });
    const settled = await log.applyTurnState({
      botId: "fox",
      runId: first.admission.runId,
      state: {
        status: "completed",
        started: true,
        sends: [
          { occurrence: 7, text: "Hello!", at: "2026-09-23T10:00:01.000Z" },
        ],
        yielded: false,
      },
      context: context(),
    });
    const next = admits(settled.effects)[0]!;
    expect(next.botId).toBe("fox");
    expect(next.admission.origin.throughSeq).toBe(2);
    // It reads what came after its last Turn, and not its own reply again.
    expect(next.admission.text).toContain("User: @Fox and one more thing");
    expect(next.admission.text).not.toContain("Hello!");
    expect(next.admission.runId).not.toBe(first.admission.runId);
  });

  test("what a member's Turn says is posted once, under its name, and read back idempotently", async () => {
    const { log } = await freshLog();
    const turn = admits((await userSays(log, "c1", "@Fox hi")).effects)[0]!;
    await log.admitted("fox", turn.admission.runId);
    const state = {
      status: "running" as const,
      started: true,
      sends: [{ occurrence: 3, text: "On it", at: "2026-09-23T10:00:01.000Z" }],
      yielded: false,
    };
    await log.applyTurnState({
      botId: "fox",
      runId: turn.admission.runId,
      state,
      context: context(),
    });
    await log.applyTurnState({
      botId: "fox",
      runId: turn.admission.runId,
      state,
      context: context(),
    });
    const page = await log.page({ limit: 10 });
    expect(page.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(page.messages[1]).toMatchObject({
      author: { kind: "bot", botId: "fox" },
      body: { kind: "text", text: "On it" },
    });
    const view = await log.view(context());
    expect(view.working).toEqual(["fox"]);
    expect(view.unread).toBe(1);
  });

  /** A member's Turn that says `text`, settled, and the judgment it owes. */
  async function memberSays(
    log: GroupChatLogV1,
    botId: string,
    runId: string,
    text: string,
  ) {
    await log.admitted(botId, runId);
    const settled = await log.applyTurnState({
      botId,
      runId,
      state: {
        status: "completed",
        started: true,
        sends: [{ occurrence: 1, text, at: "2026-09-23T10:00:01.000Z" }],
        yielded: false,
      },
      context: context(),
    });
    const judge = settled.effects.find(
      (effect): effect is Extract<GroupEffectV1, { kind: "judge" }> =>
        effect.kind === "judge",
    )!;
    return { settled, seq: judge.seq };
  }

  test("a member's mentions wait for the judgment, and run only when they carry it on", async () => {
    const { log } = await freshLog();
    const turn = admits((await userSays(log, "c1", "@Fox start")).effects)[0]!;
    const { settled, seq } = await memberSays(
      log,
      "fox",
      turn.admission.runId,
      "@Dog your go",
    );
    expect(admits(settled.effects)).toEqual([]);
    const evidence = (await log.judgementEvidence(seq, context()))!;
    expect(evidence).toMatchObject({
      botAuthored: true,
      message: { speaker: "Fox", text: "@Dog your go", mentions: ["dog"] },
      candidates: ["owl"],
    });
    expect(evidence.recent.map((line) => line.speaker)).toEqual(["User"]);
    const looped = await log.applyJudgement({
      seq,
      decision: { reply: [], mentions: "loops" },
      context: context(),
    });
    expect(admits(looped.effects)).toEqual([]);
    expect(await log.judgement(seq)).toMatchObject({
      decision: { mentions: "loops" },
    });
    // Applied once: a second answer for the same message changes nothing.
    const again = await log.applyJudgement({
      seq,
      decision: { reply: [], mentions: "continues" },
      context: context(),
    });
    expect(again.effects).toEqual([]);
    expect(await log.pendingJudgements()).not.toContain(seq);
  });

  test("with Jev, Bots may keep asking Bots; without it, a run of them ends", async () => {
    for (const unavailable of [false, true]) {
      const { log } = await freshLog();
      let turn = admits((await userSays(log, "c1", "@Fox start")).effects)[0]!;
      let botId = "fox";
      const asked: string[] = [];
      for (let round = 0; round < GROUP_BOT_CHAIN_MAX_V1 + 3; round++) {
        const other = botId === "fox" ? "Dog" : "Fox";
        const { seq } = await memberSays(
          log,
          botId,
          turn.admission.runId,
          `@${other} your go`,
        );
        const judged = await log.applyJudgement({
          seq,
          decision: {
            reply: [],
            mentions: "continues",
            ...(unavailable ? { unavailable: true as const } : {}),
          },
          context: context(),
        });
        const next = admits(judged.effects)[0];
        if (!next) break;
        asked.push(next.botId);
        turn = next;
        botId = next.botId;
      }
      expect(asked).toHaveLength(
        unavailable ? GROUP_BOT_CHAIN_MAX_V1 : GROUP_BOT_CHAIN_MAX_V1 + 3,
      );
    }
  });

  test("Jev asks a member nobody mentioned", async () => {
    const { log } = await freshLog();
    const posted = await userSays(log, "c1", "Has the Acme invoice been paid?");
    expect(admits(posted.effects)).toEqual([]);
    const seq = posted.value.seq;
    const evidence = (await log.judgementEvidence(seq, context()))!;
    expect(evidence.candidates).toEqual(["fox", "dog", "owl"]);
    expect(evidence.botAuthored).toBe(false);
    const judged = await log.applyJudgement({
      seq,
      decision: { reply: ["owl"] },
      context: context(),
    });
    const asked = admits(judged.effects);
    expect(asked.map((effect) => effect.botId)).toEqual(["owl"]);
    expect(asked[0]!.admission.origin.reason).toBe("jev");
    expect(asked[0]!.admission.text).toContain("looks like yours to answer");
  });

  test("a member already working or already mentioned is not a candidate", async () => {
    const { log } = await freshLog();
    const turn = admits((await userSays(log, "c1", "@Fox go")).effects)[0]!;
    await log.admitted("fox", turn.admission.runId);
    const posted = await userSays(log, "c2", "@Dog you too");
    const evidence = (await log.judgementEvidence(
      posted.value.seq,
      context(),
    ))!;
    expect(evidence.candidates).toEqual(["owl"]);
  });

  test("a Turn that yielded unanswered is asked again with what arrived", async () => {
    const { log } = await freshLog();
    const turn = admits(
      (await userSays(log, "c1", "@Fox research this")).effects,
    )[0]!;
    await log.admitted("fox", turn.admission.runId);
    await userSays(log, "c2", "actually, only flights");
    const settled = await log.applyTurnState({
      botId: "fox",
      runId: turn.admission.runId,
      state: { status: "completed", started: true, sends: [], yielded: true },
      context: context(),
    });
    const next = admits(settled.effects)[0]!;
    expect(next.admission.origin.reason).toBe("continue");
    expect(next.admission.text).toContain("User: actually, only flights");
    expect(next.admission.text).toContain("You had not finished");
  });

  test("a stopped Turn that said nothing leaves a line; a failed one offers Retry", async () => {
    const { log } = await freshLog();
    const fox = admits((await userSays(log, "c1", "@Fox and @Dog go")).effects);
    for (const effect of fox)
      await log.admitted(effect.botId, effect.admission.runId);
    const stop = await log.stop({ commandId: "stop-1", botId: "fox" });
    expect(stop.value.stopped).toEqual(["fox"]);
    expect(stop.effects).toContainEqual(
      expect.objectContaining({ kind: "stop", botId: "fox" }),
    );
    const foxRun = fox.find((effect) => effect.botId === "fox")!.admission
      .runId;
    const dogRun = fox.find((effect) => effect.botId === "dog")!.admission
      .runId;
    await log.applyTurnState({
      botId: "fox",
      runId: foxRun,
      state: { status: "cancelled", started: true, sends: [], yielded: false },
      context: context(),
    });
    await log.applyTurnState({
      botId: "dog",
      runId: dogRun,
      state: { status: "failed", started: true, sends: [], yielded: false },
      context: context(),
    });
    const events = (await log.page({ limit: 10 })).messages
      .map((message) => message.body)
      .filter((body) => body.kind === "event");
    expect(events).toEqual([
      {
        kind: "event",
        event: { type: "turn-stopped", botId: "fox", runId: foxRun },
      },
      {
        kind: "event",
        event: { type: "turn-failed", botId: "dog", runId: dogRun },
      },
    ]);
    const retried = await log.retry({
      commandId: "retry-1",
      botId: "dog",
      runId: dogRun,
      context: context(),
    });
    const again = admits(retried.effects)[0]!;
    expect(again.botId).toBe("dog");
    expect(again.admission.origin.reason).toBe("retry");
    expect(again.admission.runId).not.toBe(dogRun);
    await expect(
      log.retry({
        commandId: "retry-2",
        botId: "fox",
        runId: foxRun,
        context: context(),
      }),
    ).rejects.toBeInstanceOf(GroupChatConflictError);
  });

  test("a member mentioned while its admission is still unanswered is asked after it", async () => {
    const { log } = await freshLog();
    const first = admits((await userSays(log, "c1", "@Fox one")).effects)[0]!;
    // Not admitted yet: a second mention must not change the bytes.
    const second = await userSays(log, "c2", "@Fox two");
    expect(admits(second.effects)[0]!.admission).toEqual(first.admission);
    await log.admitted("fox", first.admission.runId);
    const settled = await log.applyTurnState({
      botId: "fox",
      runId: first.admission.runId,
      state: { status: "completed", started: true, sends: [], yielded: false },
      context: context(),
    });
    expect(admits(settled.effects)[0]!.admission.origin.throughSeq).toBe(2);
  });

  test("a member that keeps refusing is given up on, with Retry", async () => {
    const { log } = await freshLog();
    const turn = admits((await userSays(log, "c1", "@Fox hi")).effects)[0]!;
    const results: boolean[] = [];
    for (let attempt = 0; attempt < GROUP_ADMISSION_ATTEMPTS_V1; attempt++) {
      results.push(await log.admissionFailed("fox", turn.admission.runId));
    }
    expect(results.at(-1)).toBe(true);
    expect(results.slice(0, -1).every((gaveUp) => !gaveUp)).toBe(true);
    expect(await log.owedAdmissions()).toEqual([]);
    const last = (await log.page({ limit: 1 })).messages[0]!;
    expect(last.body).toEqual({
      kind: "event",
      event: { type: "turn-failed", botId: "fox", runId: turn.admission.runId },
    });
  });

  test("a member removed mid-Turn is stopped and says nothing more", async () => {
    const { log } = await freshLog();
    const turn = admits((await userSays(log, "c1", "@Fox hi")).effects)[0]!;
    await log.admitted("fox", turn.admission.runId);
    const without = context({ members: ["dog", "owl"] });
    const removed = await log.recordEvent({
      commandId: "remove-fox",
      actor: { kind: "user" },
      event: { type: "member-removed", botId: "fox" },
      context: without,
    });
    expect(removed.effects).toContainEqual(
      expect.objectContaining({
        kind: "stop",
        botId: "fox",
        runId: turn.admission.runId,
      }),
    );
    await log.applyTurnState({
      botId: "fox",
      runId: turn.admission.runId,
      state: {
        status: "completed",
        started: true,
        sends: [
          { occurrence: 1, text: "late", at: "2026-09-23T10:00:01.000Z" },
        ],
        yielded: false,
      },
      context: without,
    });
    const texts = (await log.page({ limit: 10 })).messages.filter(
      (message) => message.body.kind === "text",
    );
    expect(texts).toHaveLength(1);
    expect(await log.openTurns()).toEqual([]);
  });

  test("a member calling @User owes the person an alert, written with the message", async () => {
    const { log } = await freshLog();
    const turn = admits((await userSays(log, "c1", "@Fox check")).effects)[0]!;
    const { settled, seq } = await memberSays(
      log,
      "fox",
      turn.admission.runId,
      "@User the invoice is overdue",
    );
    expect(settled.effects).toContainEqual({ kind: "push", seq });
    expect(await log.pendingPushes()).toEqual([seq]);
    expect((await log.message(seq))?.body).toMatchObject({
      mentionsUser: true,
    });
    await log.pushDelivered(seq);
    expect(await log.pendingPushes()).toEqual([]);
    // The person writing @User calls nobody.
    const own = await userSays(log, "c2", "@User note to self");
    expect(own.effects.some((effect) => effect.kind === "push")).toBe(false);
  });

  test("a member asking a Bot outside the group leaves one line in the thread", async () => {
    const { log } = await freshLog();
    const turn = admits((await userSays(log, "c1", "@Fox check")).effects)[0]!;
    await log.admitted("fox", turn.admission.runId);
    const state = {
      status: "running" as const,
      started: true,
      sends: [],
      yielded: false,
      exchanges: [{ callId: "tool:1:1:0", botId: "researcher" }],
    };
    for (let round = 0; round < 2; round++) {
      await log.applyTurnState({
        botId: "fox",
        runId: turn.admission.runId,
        state,
        context: context(),
      });
    }
    const lines = (await log.page({ limit: 10 })).messages.filter(
      (message) =>
        message.body.kind === "event" &&
        message.body.event.type === "bot-message",
    );
    expect(lines.map((message) => message.body)).toEqual([
      {
        kind: "event",
        event: {
          type: "bot-message",
          botId: "fox",
          toBotId: "researcher",
          runId: turn.admission.runId,
          callId: "tool:1:1:0",
        },
      },
    ]);
  });

  test("an archived group takes no posts", async () => {
    const { log } = await freshLog();
    await expect(
      log.post({
        messageId: "u-c1",
        author: { kind: "user" },
        text: "hello",
        context: context({ archivedAt: "2026-09-23T09:00:00.000Z" }),
      }),
    ).rejects.toBeInstanceOf(GroupChatConflictError);
  });

  test("pages read backwards from the head, or forwards after a position", async () => {
    const { log } = await freshLog();
    for (let index = 1; index <= 5; index++) {
      await userSays(log, `c${index}`, `message ${index}`);
    }
    const latest = await log.page({ limit: 2 });
    expect(latest.messages.map((message) => message.seq)).toEqual([4, 5]);
    expect(latest.hasMore).toBe(true);
    const earlier = await log.page({ before: 4, limit: 10 });
    expect(earlier.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(earlier.hasMore).toBe(false);
    const after = await log.page({ after: 3, limit: 10 });
    expect(after.messages.map((message) => message.seq)).toEqual([4, 5]);
  });

  test("reading is a cursor that only moves forward and stops at the head", async () => {
    const { log } = await freshLog();
    await userSays(log, "c1", "one");
    await userSays(log, "c2", "two");
    expect(await log.markRead(10)).toBe(2);
    expect(await log.markRead(1)).toBe(2);
  });
});
