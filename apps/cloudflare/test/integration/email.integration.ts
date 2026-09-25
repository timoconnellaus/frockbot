// Email to and from a Bot. Inbound, as Email Routing delivers it: each
// message handed to the Worker's own `email()` export, with the receiving
// server's ARC verdict on top, exactly as the deployed Worker receives it.
// Outbound, as the Bot sends it: the seeded email Plugin's tools called in a
// Turn, and the `SEND_EMAIL` binding a fake that keeps what it was handed.
// The username, each Bot's switch and the senders are set through the
// gateway, as the settings pages set them.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ACCOUNT_DELETED_KEY_V1 } from "@frockbot/app/account/deletion";
import { inboundEmailRunIdV1 } from "@frockbot/app/email/inbound";
import type {
  EmailUsernameViewV1,
  InboundEmailViewV1,
} from "@frockbot/app/email/shared";
import {
  pngBytesV1,
  rawEmailV1,
  type RawEmailV1,
} from "@frockbot/app/email/testing";
import {
  EMAIL_OWNER_COUNT_KEY_V1,
  EMAIL_OWNER_DAILY_LIMIT_V1,
} from "@frockbot/app/email/bot";
import worker from "../../src/index.ts";
import { dynamicToolInputV1 } from "../dynamic-tools.ts";
import type { FakeSentEmailV1 } from "../email-fake.ts";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "../../src/deployment-policy.ts";
import {
  asUser,
  expectOkJson,
  flockRevision,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  readStoredRunEventsV1,
  readStoredRunWithEventsV1,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

type WorkerEnv = Parameters<typeof worker.fetch>[1];

interface Delivered {
  rejected?: string;
}

/** Hand one message to `email()`, as Email Routing would. */
async function deliver(
  raw: Uint8Array,
  options: { to: string; from?: string; rawSize?: number },
): Promise<Delivered> {
  const outcome: Delivered = {};
  const message = {
    from: options.from ?? "bounce@example.com",
    to: options.to,
    headers: new Headers(),
    raw: new Blob([raw as BlobPart]).stream(),
    rawSize: options.rawSize ?? raw.byteLength,
    canBeForwarded: false,
    setReject(reason: string) {
      outcome.rejected = reason;
    },
    forward: () => Promise.reject(new Error("not forwarded")),
    reply: () => Promise.reject(new Error("not replied")),
  } as unknown as ForwardableEmailMessage;
  await worker.email(message, env as unknown as WorkerEnv);
  return outcome;
}

async function readView(userId: string, botId: string) {
  return (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/email`),
  )) as InboundEmailViewV1;
}

/** A username no other test in this file holds. */
function freshUsername(): string {
  return `t-${crypto.randomUUID().slice(0, 8)}`;
}

function claimUsername(userId: string, username: string | null) {
  return postAsUser(userId, "/api/email/username", { username });
}

function setEnabled(userId: string, botId: string, enabled: boolean) {
  return postAsUser(userId, `/api/bots/${botId}/email/switch`, { enabled });
}

/**
 * An account whose sign-in address the identity provider verified, with a
 * username, and its Bot — "Integration Bot" — enabled.
 */
async function account(label: string) {
  const userId = freshUserId(label);
  const botId = `${label}-bot`;
  const owner = `owner-${crypto.randomUUID()}@example.com`;
  await provisionThroughGateway({ userId, botId });
  await env.AUTH_DB.prepare(
    `insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") values (?, ?, ?, 1, ?, ?)`,
  )
    .bind(userId, "Owner", owner, "2026-09-24", "2026-09-24")
    .run();
  // Off, and without a username there is no address at all.
  const before = await readView(userId, botId);
  expect(before).toMatchObject({ available: true, enabled: false });
  expect(before.address).toBeUndefined();

  const username = freshUsername();
  expect(
    (await expectOkJson(
      await claimUsername(userId, username),
    )) as EmailUsernameViewV1,
  ).toEqual({
    schemaVersion: 1,
    available: true,
    domain: "bots.frock.test",
    username,
  });
  const view = (await expectOkJson(
    await setEnabled(userId, botId, true),
  )) as InboundEmailViewV1;
  expect(view).toMatchObject({
    enabled: true,
    username,
    address: `integration-bot.${username}@bots.frock.test`,
  });
  return { userId, botId, owner, username, address: view.address! };
}

/** The Bot's address, once its directory has caught up with a rename. */
async function addressBecomes(
  userId: string,
  botId: string,
  address: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await readView(userId, botId)).address === address) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect((await readView(userId, botId)).address).toBe(address);
}

function message(
  overrides: Partial<RawEmailV1> & { to: string; from: string },
) {
  return rawEmailV1({
    subject: "Agenda",
    messageId: `${crypto.randomUUID()}@mail.example.com`,
    text: "Draft Tuesday's agenda, please.",
    ...overrides,
  });
}

async function waitForRun(userId: string, botId: string, runId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await asUser(
      userId,
      `/api/bots/${encodeURIComponent(botId)}/turns/${encodeURIComponent(runId)}`,
    );
    if (response.status === 200) {
      const body = (await response.json()) as {
        state?: string;
        run?: { input: string; via?: unknown };
      };
      if (body.state === "terminal" && body.run) return body.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`email run ${runId} did not settle`);
}

describe("emailing a Bot", () => {
  it("admits the owner's message with its files, once however often it arrives", async () => {
    const { userId, botId, owner, address } = await account("em-admit");
    const messageId = `${crypto.randomUUID()}@mail.example.com`;
    const raw = message({
      from: `Owner <${owner}>`,
      to: address,
      messageId,
      files: [
        { name: "chart.png", mediaType: "image/png", bytes: pngBytesV1(512) },
        {
          name: "notes.txt",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("Tuesday: budget, hiring."),
        },
      ],
    });
    expect(await deliver(raw, { to: address })).toEqual({});

    const runId = await inboundEmailRunIdV1(address, messageId);
    const run = await waitForRun(userId, botId, runId);
    expect(run).toMatchObject({
      input: "Subject: Agenda\n\nDraft Tuesday's agenda, please.",
      via: { kind: "email" },
    });
    // The files, as the Bot holds them: the durable run, because this request
    // names no client protocol and so is sent the run without them.
    const stored = await readStoredRunWithEventsV1<{
      attachments?: { name: string; kind: string }[];
      admission?: { origin?: unknown; lane?: string };
    }>(userId, botId, runId);
    expect(stored?.attachments?.map((file) => [file.name, file.kind])).toEqual([
      ["chart.png", "image"],
      ["notes.txt", "document"],
    ]);
    expect(stored?.admission?.origin).toEqual({ kind: "email", messageId });

    // Email Routing delivering the same message again is the same Turn.
    expect(await deliver(raw, { to: address })).toEqual({});
    const page = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: { runId: string }[] };
    expect(page.runs.filter((listed) => listed.runId === runId)).toHaveLength(
      1,
    );
  });

  it("refuses a forged sender, a stranger, an unknown address and an oversized message", async () => {
    const { userId, botId, owner, username, address } =
      await account("em-refuse");
    const before = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: unknown[] };

    // The owner's address, but the receiving server's DMARC verdict failed.
    expect(
      (
        await deliver(message({ from: owner, to: address, verdict: "fail" }), {
          to: address,
        })
      ).rejected,
    ).toMatch(/DMARC/);
    // Authenticated, and nobody this account knows.
    expect(
      (
        await deliver(message({ from: "stranger@example.net", to: address }), {
          to: address,
        })
      ).rejected,
    ).toMatch(/confirmed addresses/);
    // A username nobody holds, a Bot this account has not, and no dot at all.
    for (const nobody of [
      `integration-bot.${freshUsername()}@bots.frock.test`,
      `nobody.${username}@bots.frock.test`,
      `${username}@bots.frock.test`,
    ]) {
      expect(
        (await deliver(message({ from: owner, to: nobody }), { to: nobody }))
          .rejected,
      ).toBe("No such address.");
    }
    // A Bot of theirs that was never switched on: General.
    const general = `general.${username}@bots.frock.test`;
    expect(
      (await deliver(message({ from: owner, to: general }), { to: general }))
        .rejected,
    ).toBe("This address does not accept mail right now.");
    expect(
      (
        await deliver(message({ from: owner, to: address }), {
          to: address,
          rawSize: 30 * 1024 * 1024,
        })
      ).rejected,
    ).toMatch(/larger than/);

    const after = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: unknown[] };
    expect(after.runs).toHaveLength(before.runs.length);
  });

  it("confirms an added address by the code it sends back, and stops when switched off", async () => {
    const { userId, botId, owner, address } = await account("em-confirm");
    const work = `work-${crypto.randomUUID()}@work.example`;
    const added = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/email/senders`, {
        action: "add",
        address: work,
      }),
    )) as InboundEmailViewV1;
    const pending = added.senders.find((sender) => sender.address === work);
    expect(pending).toMatchObject({ status: "pending" });
    const code = (pending as { code: string }).code;
    expect(code).toMatch(/^FROCK-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(added.senders[0]).toEqual({ address: owner, status: "sign-in" });

    // Before the code, the address is nobody's.
    expect(
      (await deliver(message({ from: work, to: address }), { to: address }))
        .rejected,
    ).toMatch(/confirmed addresses/);
    expect(
      await deliver(
        message({ from: work, to: address, subject: code, text: "" }),
        { to: address },
      ),
    ).toEqual({});
    expect(
      (await readView(userId, botId)).senders.find(
        (sender) => sender.address === work,
      ),
    ).toMatchObject({ status: "verified" });

    const messageId = `${crypto.randomUUID()}@work.example`;
    expect(
      await deliver(message({ from: work, to: address, messageId }), {
        to: address,
      }),
    ).toEqual({});
    await waitForRun(
      userId,
      botId,
      await inboundEmailRunIdV1(address, messageId),
    );

    const off = (await expectOkJson(
      await setEnabled(userId, botId, false),
    )) as InboundEmailViewV1;
    expect(off).toMatchObject({ enabled: false, address });
    expect(
      (await deliver(message({ from: owner, to: address }), { to: address }))
        .rejected,
    ).toBe("This address does not accept mail right now.");
  });

  it("keeps a username to one account, and every address follows a change", async () => {
    const first = await account("em-username");
    const other = freshUserId("em-username-other");
    await provisionThroughGateway({ userId: other, botId: "em-other-bot" });
    const taken = await claimUsername(other, first.username);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({
      error: "That username is taken. Choose another.",
    });
    for (const refused of ["postmaster", "ab", "tim.o", "-tim"]) {
      expect((await claimUsername(other, refused)).status).toBe(400);
    }

    const renamed = freshUsername();
    await expectOkJson(await claimUsername(first.userId, renamed));
    const moved = `integration-bot.${renamed}@bots.frock.test`;
    expect((await readView(first.userId, first.botId)).address).toBe(moved);
    expect(
      (
        await deliver(message({ from: first.owner, to: first.address }), {
          to: first.address,
        })
      ).rejected,
    ).toBe("No such address.");
    const messageId = `${crypto.randomUUID()}@mail.example.com`;
    expect(
      await deliver(message({ from: first.owner, to: moved, messageId }), {
        to: moved,
      }),
    ).toEqual({});
    await waitForRun(
      first.userId,
      first.botId,
      await inboundEmailRunIdV1(moved, messageId),
    );
    // The name given up is anyone's.
    expect((await claimUsername(other, first.username)).status).toBe(200);
  });

  it("follows a rename, and the later of two Bots with one name is -2", async () => {
    const { userId, botId, owner, username, address } =
      await account("em-rename");
    const rename = async (target: string, name: string) => {
      const settings = (await expectOkJson(
        await asUser(userId, `/api/bots/${target}/settings`),
      )) as { revision: number };
      expect(
        (
          await postAsUser(userId, `/api/bots/${target}/settings`, {
            schemaVersion: 1,
            type: "bot/set-profile",
            commandId: `rename-${crypto.randomUUID()}`,
            expectedRevision: settings.revision,
            botId: target,
            profile: { name },
          })
        ).status,
      ).toBe(200);
    };
    await rename(botId, "Fox");
    const fox = `fox.${username}@bots.frock.test`;
    await addressBecomes(userId, botId, fox);
    expect(
      (await deliver(message({ from: owner, to: address }), { to: address }))
        .rejected,
    ).toBe("No such address.");

    const twin = "em-rename-twin";
    const created = await postAsUser(userId, "/api/bots", {
      schemaVersion: 1,
      type: "bot/create",
      commandId: `create-${twin}`,
      expectedRevision: await flockRevision(userId),
      botId: twin,
      name: "fox",
    });
    expect(created.status).toBe(201);
    await expectOkJson(await setEnabled(userId, twin, true));
    const fox2 = `fox-2.${username}@bots.frock.test`;
    await addressBecomes(userId, twin, fox2);
    expect((await readView(userId, botId)).address).toBe(fox);

    const messageId = `${crypto.randomUUID()}@mail.example.com`;
    expect(
      await deliver(message({ from: owner, to: fox2, messageId }), {
        to: fox2,
      }),
    ).toEqual({});
    await waitForRun(userId, twin, await inboundEmailRunIdV1(fox2, messageId));
  });

  it("a deleted account's username goes with it", async () => {
    const { userId, owner, username, address } = await account("em-deleted");
    const policy = env.DEPLOYMENT_POLICY.getByName(
      DEPLOYMENT_POLICY_SINGLETON_NAME,
    );
    const directoryKeys = () =>
      runInDurableObject(policy, async (_instance, state) =>
        [...state.storage.kv.list({ prefix: "email:" })]
          .map(([key]) => key)
          .filter(
            (key) => key.endsWith(`:${userId}`) || key.endsWith(`:${username}`),
          ),
      );
    expect(await directoryKeys()).toHaveLength(2);

    const accepted = await asUser(userId, "/api/account/delete", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: `delete-${crypto.randomUUID()}`,
        // The development identity carries no email, so the phrase is its id.
        confirmation: userId,
      }),
    });
    expect(accepted.status).toBe(202);
    const user = env.USER_CONFIGURATIONS.getByName(userId);
    for (let pass = 0; pass < 60; pass += 1) {
      await runDurableObjectAlarm(user);
      const done = await runInDurableObject(
        user,
        async (_instance, state) =>
          (await state.storage.get(ACCOUNT_DELETED_KEY_V1)) !== undefined,
      );
      if (done) break;
    }
    expect(await directoryKeys()).toEqual([]);
    expect(
      (await deliver(message({ from: owner, to: address }), { to: address }))
        .rejected,
    ).toBe("No such address.");
  });
});

/** Everything the fake `SEND_EMAIL` binding was handed, in order. */
async function sentEmail(): Promise<FakeSentEmailV1[]> {
  return (await (
    env.EMAIL_PROBE as unknown as { sent(): Promise<FakeSentEmailV1[]> }
  ).sent()) as FakeSentEmailV1[];
}

/** The mail one Bot sent: its own address is on every message it sends. */
async function sentFrom(address: string): Promise<FakeSentEmailV1[]> {
  return (await sentEmail()).filter((email) => email.from.email === address);
}

/** The seeded email Plugin, switched on for this Bot. */
async function enableEmailPlugin(userId: string, botId: string) {
  const command = (expectedRevision: number) => ({
    schemaVersion: 1,
    kind: "set-plugin-enabled",
    commandId: `email-plugin-${crypto.randomUUID()}`,
    pluginId: "email",
    enabled: true,
    expectedRevision,
  });
  let answer = (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/plugins`, command(0)),
  )) as { status: string; currentRevision?: number };
  if (answer.status === "conflict") {
    answer = (await expectOkJson(
      await postAsUser(
        userId,
        `/api/bots/${botId}/plugins`,
        command(answer.currentRevision!),
      ),
    )) as { status: string };
  }
  expect(answer.status).toBe("applied");
}

/** The scripted call that makes the stub model use one email Plugin tool. */
function emailToolPrompt(toolName: string, input: unknown): string {
  return toolCallTriggerPrompt([
    "call_dynamic_tool",
    dynamicToolInputV1({
      namespace: "email",
      toolName,
      input,
      description: "Email, as the person asked.",
    }),
  ]);
}

/** One Turn in which the Bot calls one email Plugin tool, and what it answered. */
async function emailTool(
  userId: string,
  botId: string,
  toolName: string,
  input: unknown,
): Promise<string[]> {
  const turn = (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: `email-tool-${crypto.randomUUID()}`,
      text: emailToolPrompt(toolName, input),
    }),
  )) as { runId: string };
  return toolResults(userId, botId, turn.runId);
}

async function toolResults(
  userId: string,
  botId: string,
  runId: string,
): Promise<string[]> {
  return (await readStoredRunEventsV1(userId, botId, runId))
    .filter((event) => event.type === "tool/result")
    .map((event) => String(event.content ?? ""));
}

describe("a Bot's own email", () => {
  it("emails its owner from its own address, once, and the conversation and audit say so", async () => {
    const { userId, botId, owner, address } = await account("em-owner");
    await enableEmailPlugin(userId, botId);
    const subject = `Status ${crypto.randomUUID()}`;
    const results = await emailTool(userId, botId, "email_owner", {
      data: { subject, body: "All done." },
    });
    expect(results.join("\n")).toMatch(/card is in the conversation/);

    const sent = (await sentFrom(address)).filter(
      (email) => email.subject === subject,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { email: address, name: "Integration Bot" },
      to: [owner],
      text: "All done.",
    });
    // A note to the person is theirs already: no reply-to, no thread.
    expect(sent[0]!.replyTo).toBeUndefined();
    expect(sent[0]!.headers).toBeUndefined();

    // In the conversation, as a receipt the email Plugin drew.
    const cards = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/cards`),
    )) as {
      cards: Array<{ components: Array<Record<string, unknown>> }>;
    };
    expect(
      cards.cards.flatMap((card) =>
        card.components.filter((part) => part.component === "Receipt"),
      ),
    ).toContainEqual(
      expect.objectContaining({
        status: "Emailed you",
        summary: `Emailed you at ${owner} — ${subject}`,
      }),
    );

    // And in the audit trail, with the subject and nothing it said.
    const deadline = Date.now() + 30_000;
    let previews: string[] = [];
    while (Date.now() < deadline) {
      const audit = (await expectOkJson(
        await asUser(userId, `/api/audit?botId=${botId}&kind=email`),
      )) as { entries?: Array<{ kind: string; preview: string }> };
      previews = (audit.entries ?? []).map((entry) => entry.preview);
      if (previews.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(previews).toContain(`Emailed you: ${subject}`);
  });

  it("writes to nobody else without a draft, and stops at the day's limit", async () => {
    const { userId, botId, address } = await account("em-limit");
    await enableEmailPlugin(userId, botId);

    const stranger = await emailTool(userId, botId, "email_owner", {
      data: { subject: "Hi", body: "Hi.", to: "eve@evil.example" },
    });
    expect(stranger.join("\n")).toMatch(
      /not one of your person's own addresses/,
    );

    await runInDurableObject(
      env.BOT_STATES.getByName(`${userId}:${botId}`),
      (_instance, state) =>
        state.storage.put(EMAIL_OWNER_COUNT_KEY_V1, {
          schemaVersion: 1,
          day: new Date().toISOString().slice(0, 10),
          count: EMAIL_OWNER_DAILY_LIMIT_V1,
        }),
    );
    const limited = await emailTool(userId, botId, "email_owner", {
      data: { subject: "One too many", body: "Hi." },
    });
    expect(limited.join("\n")).toMatch(/today/);
    expect(await sentFrom(address)).toEqual([]);
  });

  it("a Bot switched off, or with no username, is told it cannot send yet", async () => {
    const { userId, botId, address } = await account("em-cannot");
    await enableEmailPlugin(userId, botId);
    await expectOkJson(await setEnabled(userId, botId, false));
    expect(
      (
        await emailTool(userId, botId, "email_owner", {
          data: { subject: "Hi", body: "Hi." },
        })
      ).join("\n"),
    ).toMatch(/email is switched off for you/);
    await expectOkJson(await setEnabled(userId, botId, true));
    await expectOkJson(await claimUsername(userId, null));
    expect(
      (
        await emailTool(userId, botId, "email_owner", {
          data: { subject: "Hi", body: "Hi." },
        })
      ).join("\n"),
    ).toMatch(/Email username/);
    expect(await sentFrom(address)).toEqual([]);
  });

  it("answers the owner's email in its thread", async () => {
    const { userId, botId, owner, address } = await account("em-thread");
    await enableEmailPlugin(userId, botId);
    const messageId = `${crypto.randomUUID()}@mail.example.com`;
    const subject = `Thread ${crypto.randomUUID()}`;
    expect(
      await deliver(
        message({
          from: owner,
          to: address,
          messageId,
          subject,
          text: emailToolPrompt("email_owner", {
            data: { subject: `Re: ${subject}`, body: "On it." },
          }),
        }),
        { to: address },
      ),
    ).toEqual({});
    await waitForRun(
      userId,
      botId,
      await inboundEmailRunIdV1(address, messageId),
    );
    const reply = (await sentFrom(address)).find(
      (email) => email.subject === `Re: ${subject}`,
    );
    expect(reply).toMatchObject({
      to: [owner],
      headers: {
        "In-Reply-To": `<${messageId}>`,
        References: `<${messageId}>`,
      },
    });
  });

  it("sends a draft to anyone once it is approved, with replies going to the person", async () => {
    const { userId, botId, owner, address } = await account("em-draft");
    await enableEmailPlugin(userId, botId);
    const subject = `Draft ${crypto.randomUUID()}`;
    await emailTool(userId, botId, "email_draft", {
      data: { to: ["nick@example.net"], subject, body: "Hi Nick." },
    });
    // Drawn and waiting: nothing has left.
    expect(
      (await sentFrom(address)).filter((email) => email.subject === subject),
    ).toEqual([]);

    const listed = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/cards`),
    )) as {
      cards: Array<{
        surfaceId: string;
        revision: number;
        dataModel: Record<string, unknown>;
        components: Array<Record<string, unknown>>;
      }>;
    };
    const card = listed.cards.find(
      (candidate) => candidate.dataModel.subject === subject,
    )!;
    const approvalId = String(
      card.components.find((part) => part.component === "ApprovalActions")
        ?.approvalId,
    );
    expect(approvalId).toMatch(/^card-approval-/);
    const pressed = await postAsUser(userId, `/api/bots/${botId}/cards`, {
      schemaVersion: 1,
      surfaceId: card.surfaceId,
      revision: card.revision,
      event: {
        name: `approval/${approvalId}`,
        context: { decision: "approved" },
      },
      dataModel: card.dataModel,
    });
    expect(pressed.status).toBe(200);

    const results = await emailTool(userId, botId, "email_send", {
      surfaceId: card.surfaceId,
      approvalId,
    });
    expect(results.join("\n")).toMatch(/^Sent to nick@example\.net/m);
    const sent = (await sentFrom(address)).filter(
      (email) => email.subject === subject,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { email: address, name: "Integration Bot" },
      to: ["nick@example.net"],
      replyTo: owner,
      text: "Hi Nick.",
    });

    // Their reply to the Bot's address is somebody else's mail, and refused
    // exactly as any stranger's is.
    expect(
      (
        await deliver(message({ from: "nick@example.net", to: address }), {
          to: address,
        })
      ).rejected,
    ).toMatch(/confirmed addresses/);
  });
});
