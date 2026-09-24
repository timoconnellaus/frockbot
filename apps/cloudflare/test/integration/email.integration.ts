// Email your Bot, as Email Routing delivers it: each message handed to the
// Worker's own `email()` export, with the receiving server's ARC verdict on
// top, exactly as the deployed Worker receives it. The address and the
// senders are made through the gateway, as the settings page makes them.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ACCOUNT_DELETED_KEY_V1 } from "@frockbot/app/account/deletion";
import { inboundEmailRunIdV1 } from "@frockbot/app/email/inbound";
import type { InboundEmailViewV1 } from "@frockbot/app/email/shared";
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

/** An account whose sign-in address the identity provider verified. */
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
  const view = (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/email/address`, {
      action: "create",
    }),
  )) as InboundEmailViewV1;
  expect(view.address).toMatch(/^[a-z2-7]{26}@in\.frock\.test$/);
  return { userId, botId, owner, address: view.address! };
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
    const { userId, botId, owner, address } = await account("em-refuse");
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
    // A well-formed token nobody holds.
    const nobody = `${"a".repeat(26)}@in.frock.test`;
    expect(
      (await deliver(message({ from: owner, to: nobody }), { to: nobody }))
        .rejected,
    ).toBe("No such address.");
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

  it("confirms an added address by the code it sends back, and forgets a rotated address", async () => {
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

    const rotated = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/email/address`, {
        action: "rotate",
      }),
    )) as InboundEmailViewV1;
    expect(rotated.address).not.toBe(address);
    expect(
      (await deliver(message({ from: owner, to: address }), { to: address }))
        .rejected,
    ).toBe("No such address.");
  });

  it("a deleted account's addresses go with it", async () => {
    const { userId, owner, address } = await account("em-deleted");
    const policy = env.DEPLOYMENT_POLICY.getByName(
      DEPLOYMENT_POLICY_SINGLETON_NAME,
    );
    const directoryKeys = () =>
      runInDurableObject(policy, async (_instance, state) =>
        [...state.storage.kv.list({ prefix: "email:" })]
          .map(([key]) => key)
          .filter((key) => key.includes(userId)),
      );
    expect(await directoryKeys()).toHaveLength(1);

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
