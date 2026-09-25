// Email your Bot, as Email Routing delivers it: each message handed to the
// Worker's own `email()` export, with the receiving server's ARC verdict on
// top, exactly as the deployed Worker receives it. The username, each Bot's
// switch and the senders are set through the gateway, as the settings pages
// set them.
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
import worker from "../../src/index.ts";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "../../src/deployment-policy.ts";
import {
  asUser,
  expectOkJson,
  flockRevision,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
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

function setReceiving(userId: string, botId: string, receiving: boolean) {
  return postAsUser(userId, `/api/bots/${botId}/email/switch`, { receiving });
}

/**
 * An account whose sign-in address the identity provider verified, with a
 * username, and its Bot — "Integration Bot" — receiving.
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
  expect(before).toMatchObject({ available: true, receiving: false });
  expect(before.address).toBeUndefined();

  const username = freshUsername();
  expect(
    (await expectOkJson(
      await claimUsername(userId, username),
    )) as EmailUsernameViewV1,
  ).toEqual({
    schemaVersion: 1,
    available: true,
    domain: "in.frock.test",
    username,
  });
  const view = (await expectOkJson(
    await setReceiving(userId, botId, true),
  )) as InboundEmailViewV1;
  expect(view).toMatchObject({
    receiving: true,
    username,
    address: `integration-bot.${username}@in.frock.test`,
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
      `integration-bot.${freshUsername()}@in.frock.test`,
      `nobody.${username}@in.frock.test`,
      `${username}@in.frock.test`,
    ]) {
      expect(
        (await deliver(message({ from: owner, to: nobody }), { to: nobody }))
          .rejected,
      ).toBe("No such address.");
    }
    // A Bot of theirs that was never switched on: General.
    const general = `general.${username}@in.frock.test`;
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
      await setReceiving(userId, botId, false),
    )) as InboundEmailViewV1;
    expect(off).toMatchObject({ receiving: false, address });
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
    const moved = `integration-bot.${renamed}@in.frock.test`;
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
    const fox = `fox.${username}@in.frock.test`;
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
    await expectOkJson(await setReceiving(userId, twin, true));
    const fox2 = `fox-2.${username}@in.frock.test`;
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
