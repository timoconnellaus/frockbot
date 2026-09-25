// Whether a Bot may type a saved secret into a page: the two classes, the
// Approval that releases a payment fill once, and the value's one crossing.
import { describe, expect, test } from "bun:test";
import type {
  ToolExecutionContext,
  TurnTypeV1,
} from "@frockbot/core/contracts";
import { createCredentialUserBackendContribution } from "@frockbot/app/credentials/user";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import {
  approvalKeyV1,
  type ApprovalRecordV1,
} from "@frockbot/app/shell/approvals";
import type { UserSecretsRpcV1 } from "./bot.js";
import { createBotSecretFillSeamV1, secretFillApprovalIdV1 } from "./fill.js";
import { decodeSecretFillIntentV1, secretFillIntentKeyV1 } from "./shared.js";
import { createSecretVaultV1 } from "./user.js";
import { MemorySecretStorage, TEST_SECRETS_KEYRING } from "./testing.js";

const USER = "user-1";
const BOT = "bot-1";
const SESSION_ID = `${USER}:${BOT}`;
const RUN = "run-1";
const EFFECT_ID = "tool:3:1:0";
const NOW = Date.parse("2026-09-24T00:00:00.000Z");
const PASSWORD = "hunter2-correct-horse-9f3a1c7e";
const CARD = "4242 4242 4242 4242";

async function harness(turnType: TurnTypeV1 = "chat") {
  const userStorage = new MemorySecretStorage();
  const vault = createSecretVaultV1({
    storage: userStorage,
    credentials: createCredentialUserBackendContribution({
      storage: userStorage,
      keyring: TEST_SECRETS_KEYRING,
      now: () => NOW,
    }),
    now: () => NOW,
  });
  const rpc: UserSecretsRpcV1 = {
    store: (input) => vault.store({ accountId: USER, botId: BOT, ...input }),
    describe: (secretId) => vault.describe(secretId),
    lease: (secretId, effectId) =>
      vault.lease({ accountId: USER, secretId, effectId }),
    settle: (secretId, effectId) =>
      vault.settle({ accountId: USER, secretId, effectId }),
  };
  const password = await rpc.store({
    requestId: `secret-request-${"1".repeat(32)}`,
    label: "Shop login",
    origin: "https://shop.example",
    payment: false,
    value: PASSWORD,
  });
  const card = await rpc.store({
    requestId: `secret-request-${"2".repeat(32)}`,
    label: "Visa",
    origin: "https://shop.example",
    payment: false,
    value: CARD,
  });
  const botStorage = new MemorySecretStorage();
  const runtime = createAgentRuntimeHarness();
  const session = runtime.sessions.create(SESSION_ID);
  session.appendBatch([
    { type: "turn/start", turn: 3 },
    { type: "step/start", turn: 3, step: 1 },
  ]);
  let now = NOW;
  const seam = createBotSecretFillSeamV1({
    identity: { userId: USER, botId: BOT },
    runId: RUN,
    storage: botStorage,
    vault: rpc,
    readSecret: () => TEST_SECRETS_KEYRING,
    now: () => now,
  });
  const context: ToolExecutionContext = {
    botId: BOT,
    agentId: BOT,
    sessionId: SESSION_ID,
    compositionGenerationId: "2026-09-24T00:00:00.000Z:0123456789abcdef",
    turnType,
    effectId: EFFECT_ID,
    signal: new AbortController().signal,
  };
  let originReads = 0;
  const authorize = (
    secretId: string,
    field: string,
    options: { approvalId?: string; page?: string } = {},
  ) =>
    seam.authorize({
      secretId,
      field,
      ...(options.approvalId === undefined
        ? {}
        : { approvalId: options.approvalId }),
      context,
      runtime: { sessions: runtime.sessions },
      pageOrigin: async () => {
        originReads += 1;
        return options.page ?? "https://shop.example";
      },
    });
  return {
    seam,
    authorize,
    session,
    userStorage,
    botStorage,
    password,
    card,
    originReads: () => originReads,
    advance: (ms: number) => {
      now += ms;
    },
    decide: async (
      approvalId: string,
      decision: "approved" | "denied",
      decidedAt = new Date(now).toISOString(),
    ) =>
      botStorage.put(approvalKeyV1(approvalId), {
        schemaVersion: 1,
        approvalId,
        runId: RUN,
        sessionId: SESSION_ID,
        action: "Fill",
        risk: "high",
        createdAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 600_000).toISOString(),
        decision,
        decidedAt,
        decidedBy: "user",
      } satisfies ApprovalRecordV1),
    dispose: () => runtime.dispose(),
  };
}

describe("filling a saved secret", () => {
  test("a password on its own site is filled without asking", async () => {
    const run = await harness();
    const granted = await run.authorize(run.password.secretId, "Password");

    expect(granted).toEqual({
      status: "granted",
      origin: "https://shop.example",
      label: "Shop login",
    });
    // Its own origin is the rule, so the page was not even read: the host
    // refuses the fill if the page is anywhere else.
    expect(run.originReads()).toBe(0);
    await run.dispose();
  });

  test("a card number asks first, bound to the page, the field and the secret", async () => {
    const run = await harness();
    const asked = await run.authorize(run.card.secretId, "Card number");

    const approvalId = await secretFillApprovalIdV1(BOT, RUN, EFFECT_ID);
    expect(asked.status).toBe("asked");
    expect(asked.status === "asked" && asked.content).toContain(approvalId);
    const intent = decodeSecretFillIntentV1(
      await run.botStorage.get(secretFillIntentKeyV1(approvalId)),
    );
    expect(intent).toMatchObject({
      secretId: run.card.secretId,
      field: "Card number",
      origin: "https://shop.example",
      runId: RUN,
    });
    const sends = run.session.activeRunJournal.filter(
      (event) => event.type === "send/to-user",
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      occurrenceId: EFFECT_ID,
      payload: { type: "approval", approvalId, risk: "high" },
    });
    // Nothing the Bot can read, and nothing this object keeps, is the value.
    expect(JSON.stringify(run.session.activeRunJournal)).not.toContain(CARD);
    expect(JSON.stringify(asked)).not.toContain(CARD);
    expect(run.botStorage.dump()).not.toContain(CARD);
    await run.dispose();
  });

  test("a password typed into a payment field is asked about as a payment", async () => {
    const run = await harness();
    const asked = await run.authorize(run.password.secretId, "Card number");
    expect(asked.status).toBe("asked");
    await run.dispose();
  });

  test("an approved fill is released once, on the origin it was approved for", async () => {
    const run = await harness();
    await run.authorize(run.card.secretId, "Card number");
    const approvalId = await secretFillApprovalIdV1(BOT, RUN, EFFECT_ID);

    const early = await run.authorize(run.card.secretId, "Card number", {
      approvalId,
    });
    expect(early.status).toBe("refused");

    await run.decide(approvalId, "approved");
    // Another field, or another secret, is not what was approved.
    expect(
      (await run.authorize(run.card.secretId, "Security code", { approvalId }))
        .status,
    ).toBe("refused");
    expect(
      (
        await run.authorize(run.password.secretId, "Card number", {
          approvalId,
        })
      ).status,
    ).toBe("refused");

    const granted = await run.authorize(run.card.secretId, "Card number", {
      approvalId,
    });
    expect(granted).toEqual({
      status: "granted",
      origin: "https://shop.example",
      label: "Visa",
    });
    const again = await run.authorize(run.card.secretId, "Card number", {
      approvalId,
    });
    expect(again).toMatchObject({ status: "refused" });
    expect(again.status === "refused" && again.content).toContain(
      "already used",
    );
    await run.dispose();
  });

  test("a denied or stale approval releases nothing", async () => {
    const run = await harness();
    await run.authorize(run.card.secretId, "Card number");
    const approvalId = await secretFillApprovalIdV1(BOT, RUN, EFFECT_ID);
    await run.decide(approvalId, "denied");
    const denied = await run.authorize(run.card.secretId, "Card number", {
      approvalId,
    });
    expect(denied.status === "refused" && denied.content).toContain("denied");

    await run.decide(approvalId, "approved");
    run.advance(11 * 60_000);
    const stale = await run.authorize(run.card.secretId, "Card number", {
      approvalId,
    });
    expect(stale.status === "refused" && stale.content).toContain(
      "no longer fresh",
    );
    await run.dispose();
  });

  test("a Turn with nobody to ask cannot fill a payment detail", async () => {
    const run = await harness("automation");
    const refused = await run.authorize(run.card.secretId, "Card number");
    expect(refused.status).toBe("refused");
    expect(
      run.session.activeRunJournal.filter(
        (event) => event.type === "send/to-user",
      ),
    ).toHaveLength(0);
    await run.dispose();
  });

  test("an unknown reference is refused without reading the page", async () => {
    const run = await harness();
    expect(
      (await run.authorize(`secret-${"0".repeat(32)}`, "Password")).status,
    ).toBe("refused");
    expect((await run.authorize("not-a-secret", "Password")).status).toBe(
      "refused",
    );
    expect(run.originReads()).toBe(0);
    await run.dispose();
  });

  test("the value is opened for one action and its lease settled", async () => {
    const run = await harness();
    const effectId = "computer-0123";
    expect(
      await run.seam.open({ secretId: run.password.secretId, effectId }),
    ).toBe(PASSWORD);
    expect(run.userStorage.dump()).toContain(`secret-fill:${effectId}`);
    await run.seam.release({ secretId: run.password.secretId, effectId });
    expect(run.userStorage.dump()).not.toContain(`secret-fill:${effectId}`);
    expect(run.userStorage.dump()).not.toContain(PASSWORD);
    await run.dispose();
  });
});
