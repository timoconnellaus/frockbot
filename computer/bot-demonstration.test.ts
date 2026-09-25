/**
 * A demonstration's life in the Bot Durable Object: started under the
 * person's lease, collected when they stop it, let go of or when the alarm
 * comes due, kept as the Bot's uploads, handed off when a message carries it,
 * and deleted by the Bot, by the person or by expiry.
 *
 * The Computer is the in-memory host, scripted with the steps a real
 * recorder might have written — including ones carrying a typed value and a
 * printable key — and the assertions are on what was *stored*: the files the
 * upload store was handed and the Bot's own record.
 */
import { describe, expect, test } from "bun:test";
import type { MessageAttachmentV1 } from "@frockbot/core/contracts";
import { createFakeComputerHostV1 } from "@frockbot/computer/fake";
import {
  COMPUTER_DEMONSTRATION_EMPTY_MESSAGE,
  COMPUTER_DEMONSTRATION_RETENTION_MS,
  COMPUTER_DEMONSTRATION_RETRY_MS,
  COMPUTER_DEMONSTRATIONS_KEY,
  createComputerBotBackendContribution,
  type ComputerBotStorage,
  type ComputerBotTransaction,
  type ComputerDemonstrationFileV1,
  type ComputerDemonstrationStoreV1,
} from "./bot.js";
import type { ComputerCommandV1 } from "./protocol.js";
import type { ComputerLoginVaultV1 } from "./upkeep.js";

const USER = "user-1";
const BOT = "scout";
const SECRETS = ["tim@example.com", "hunter2", "my secret query"];

class MemoryStorage implements ComputerBotStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(
      structuredClone(this.values.get(key)) as T | undefined,
    );
  }
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(key: string | Record<string, unknown>, value?: T): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else for (const [k, v] of Object.entries(key)) this.values.set(k, v);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }
  transaction<T>(
    callback: (storage: ComputerBotTransaction) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }
}

/** The upload store as a map, recording what it was handed. */
class MemoryUploads implements ComputerDemonstrationStoreV1 {
  readonly kept = new Map<string, ComputerDemonstrationFileV1>();
  readonly removed: string[] = [];
  failRemove = false;

  async keep(input: {
    files: ComputerDemonstrationFileV1[];
  }): Promise<MessageAttachmentV1[]> {
    const attachments: MessageAttachmentV1[] = [];
    for (const file of input.files) {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", file.bytes as BufferSource),
      );
      const uploadId = [...digest]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      this.kept.set(uploadId, file);
      attachments.push({
        kind: file.mediaType === "image/jpeg" ? "image" : "document",
        uploadId,
        name: file.name,
        mediaType: file.mediaType,
        bytes: file.bytes.byteLength,
      });
    }
    return attachments;
  }

  remove(input: { uploadIds: string[] }): Promise<void> {
    if (this.failRemove) return Promise.reject(new Error("store is down"));
    for (const id of input.uploadIds) {
      this.kept.delete(id);
      this.removed.push(id);
    }
    return Promise.resolve();
  }

  /** The log a Bot would be handed, as text. */
  log(): string {
    const file = [...this.kept.values()].find(
      (candidate) => candidate.mediaType === "application/json",
    );
    return new TextDecoder().decode(file?.bytes);
  }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);

/** What a recorder might have written, the bad with the good. */
const RECORDED_STEPS = [
  {
    action: "navigate",
    t: 0,
    tab: 1,
    url: "https://courts.example.com/search?q=my secret query",
  },
  {
    action: "type",
    t: 2,
    tab: 1,
    role: "textbox",
    name: "Email",
    selector: "#email",
  },
  {
    action: "type",
    t: 3,
    tab: 1,
    role: "textbox",
    name: "Email",
    selector: "#email",
    value: "tim@example.com",
  },
  { action: "key", t: 4, tab: 1, key: "h" },
  { action: "key", t: 5, tab: 1, key: "Enter" },
  {
    action: "click",
    t: 6,
    tab: 1,
    role: "button",
    name: "Book",
    selector: "#book",
  },
];

/** A vault that holds no sign-ins and knows only when the Computer went. */
function deletionVault(): ComputerLoginVaultV1 & { deletedAt?: string } {
  const vault: ComputerLoginVaultV1 & { deletedAt?: string } = {
    owed: () => Promise.resolve(undefined),
    kept: () => Promise.resolve(undefined),
    keep: () => Promise.resolve("kept"),
    owe: (at) =>
      Promise.resolve(
        vault.deletedAt !== undefined && vault.deletedAt >= at
          ? "deleted"
          : "owed",
      ),
    settle: () => Promise.resolve(),
    deletedSince: (at) =>
      Promise.resolve(vault.deletedAt !== undefined && vault.deletedAt >= at),
  };
  return vault;
}

function rig(
  options: {
    steps?: unknown[];
    screenshots?: boolean;
    vault?: ComputerLoginVaultV1;
  } = {},
): {
  contribution: ReturnType<typeof createComputerBotBackendContribution>;
  storage: MemoryStorage;
  uploads: MemoryUploads;
  host: ReturnType<typeof createFakeComputerHostV1>;
  clock: { now: number };
  command(type: ComputerCommandV1["type"]): Promise<unknown>;
} {
  const storage = new MemoryStorage();
  const uploads = new MemoryUploads();
  const host = createFakeComputerHostV1({
    demonstration: {
      steps: options.steps ?? RECORDED_STEPS,
      screenshots:
        options.screenshots === false ? [] : [{ afterStep: 5, bytes: JPEG }],
    },
  });
  // The in-memory host dates every lease it grants 15 minutes past this.
  const clock = { now: 1_700_000_000_000 };
  let sequence = 0;
  const contribution = createComputerBotBackendContribution({
    storage,
    providerLabel: "Computer",
    configured: true,
    demonstrations: uploads,
    ...(options.vault ? { loginVault: () => options.vault } : {}),
    now: () => new Date(clock.now),
    newId: () => `id-${(sequence += 1)}`,
    openComputer: (userId, botId) =>
      host.open({ userId }, { botId }, { providerId: host.id, generation: 1 }),
  });
  let commands = 0;
  return {
    contribution,
    storage,
    uploads,
    host,
    clock,
    command: (type) =>
      contribution.execute(USER, BOT, {
        version: 1,
        commandId: `command-${(commands += 1)}`,
        botId: BOT,
        type,
      }),
  };
}

describe("a demonstration in the Bot Durable Object", () => {
  test("is recorded under the person's lease and kept as files with nothing typed in them", async () => {
    const { contribution, uploads, command } = rig();
    await command("takeControl");
    expect(await command("startDemonstration")).toMatchObject({
      status: "applied",
    });
    const recording = (await contribution.read(USER, BOT)).demonstration;
    expect(recording).toMatchObject({
      status: "recording",
      startedAt: "2023-11-14T22:13:20.000Z",
      endsAt: "2023-11-14T22:23:20.000Z",
    });

    expect(await command("stopDemonstration")).toMatchObject({
      status: "applied",
    });
    const ready = (await contribution.read(USER, BOT)).demonstration;
    if (ready?.status !== "ready") throw new Error("not kept");
    expect(ready.steps).toBe(4);
    expect(ready.attachments.map((attachment) => attachment.name)).toEqual([
      `demonstration-${ready.id}.json`,
      `demonstration-${ready.id}-screenshot-1.jpg`,
    ]);

    const log = uploads.log();
    for (const secret of SECRETS) expect(log).not.toContain(secret);
    const parsed = JSON.parse(log) as {
      demonstration: string;
      steps: Record<string, unknown>[];
      stepsLeftOut: number;
      screenshots: unknown[];
    };
    expect(parsed.demonstration).toBe(ready.id);
    expect(parsed.stepsLeftOut).toBe(2);
    expect(parsed.steps).toEqual([
      {
        step: 1,
        t: 0,
        tab: 1,
        action: "navigate",
        url: "https://courts.example.com/search?q=…",
      },
      {
        step: 2,
        t: 2,
        tab: 1,
        action: "type",
        role: "textbox",
        name: "Email",
        selector: "#email",
      },
      { step: 3, t: 5, tab: 1, action: "key", key: "Enter" },
      {
        step: 4,
        t: 6,
        tab: 1,
        action: "click",
        role: "button",
        name: "Book",
        selector: "#book",
      },
    ]);
    expect(parsed.screenshots).toEqual([
      { file: `demonstration-${ready.id}-screenshot-1.jpg`, afterStep: 5 },
    ]);
  });

  test("is refused to anyone not holding control, and moves no phase", async () => {
    const { contribution, command, uploads } = rig();
    const receipt = await command("startDemonstration");
    expect(receipt).toMatchObject({ status: "rejected" });
    expect((receipt as { failure: string }).failure).toContain("Take control");
    const projection = await contribution.read(USER, BOT);
    expect(projection.phase).toBe("idle");
    expect(projection.demonstration).toBeUndefined();
    expect(uploads.kept.size).toBe(0);
  });

  test("with nothing in it says so and keeps nothing", async () => {
    const { contribution, command, uploads } = rig({ steps: [] });
    await command("takeControl");
    await command("startDemonstration");
    const receipt = await command("stopDemonstration");
    expect(receipt).toMatchObject({
      status: "rejected",
      failure: COMPUTER_DEMONSTRATION_EMPTY_MESSAGE,
    });
    expect((await contribution.read(USER, BOT)).demonstration).toBeUndefined();
    expect(uploads.kept.size).toBe(0);
  });

  test("stops and is kept when the person releases control", async () => {
    const { contribution, command, host } = rig();
    await command("takeControl");
    await command("startDemonstration");
    await command("releaseControl");
    expect(host.calls).toContain(`demonstration:stop:${BOT}`);
    expect((await contribution.read(USER, BOT)).demonstration?.status).toBe(
      "ready",
    );
  });

  test("once sent, is no longer offered, and only then may the Bot delete it", async () => {
    const { contribution, command, uploads, storage } = rig();
    await command("takeControl");
    await command("startDemonstration");
    await command("stopDemonstration");
    const ready = (await contribution.read(USER, BOT)).demonstration;
    if (ready?.status !== "ready") throw new Error("not kept");
    const ids = ready.attachments.map((attachment) => attachment.uploadId);

    // The Bot never saw one that was not sent.
    expect(await contribution.deleteDemonstration(ready.id)).toBe("missing");
    await contribution.noteDemonstrationSent(["f".repeat(64)]);
    expect((await contribution.read(USER, BOT)).demonstration).toBeDefined();

    await contribution.noteDemonstrationSent([ids[1]!]);
    expect((await contribution.read(USER, BOT)).demonstration).toBeUndefined();
    expect(await contribution.deleteDemonstration(ready.id)).toBe("deleted");
    expect(uploads.removed).toEqual(ids);
    expect(storage.values.has(COMPUTER_DEMONSTRATIONS_KEY)).toBe(false);
    expect(await contribution.deleteDemonstration(ready.id)).toBe("missing");
  });

  test("discarded by the person before it is sent, its files go", async () => {
    const { contribution, command, uploads } = rig();
    await command("takeControl");
    await command("startDemonstration");
    await command("stopDemonstration");
    await command("discardDemonstration");
    expect((await contribution.read(USER, BOT)).demonstration).toBeUndefined();
    expect(uploads.kept.size).toBe(0);
    expect(uploads.removed).toHaveLength(2);
  });

  test("recording again replaces one that was never sent", async () => {
    const { contribution, command, uploads } = rig();
    await command("takeControl");
    await command("startDemonstration");
    await command("stopDemonstration");
    const first = (await contribution.read(USER, BOT)).demonstration!;
    await command("startDemonstration");
    const second = (await contribution.read(USER, BOT)).demonstration!;
    expect(second.status).toBe("recording");
    expect(second.id).not.toBe(first.id);
    expect(uploads.kept.size).toBe(0);
  });

  test("the alarm collects one whose lease lapsed, and expires what nobody deleted", async () => {
    const { contribution, command, clock, storage } = rig();
    await command("takeControl");
    await command("startDemonstration");
    const deadlines = () => contribution.scheduledDeadlines(storage);
    // Due when the person's lease lapses, plus the grace to write it down.
    const lapse = Math.min(...(await deadlines()));
    expect(lapse).toBeGreaterThan(clock.now);
    clock.now = lapse;
    await contribution.settleScheduledWork();
    const ready = (await contribution.read(USER, BOT)).demonstration!;
    expect(ready.status).toBe("ready");

    expect(Math.min(...(await deadlines()))).toBe(
      clock.now + COMPUTER_DEMONSTRATION_RETENTION_MS,
    );
    clock.now += COMPUTER_DEMONSTRATION_RETENTION_MS;
    await contribution.settleScheduledWork();
    expect((await contribution.read(USER, BOT)).demonstration).toBeUndefined();
    expect(await deadlines()).toEqual([]);
  });

  test("an Update collects it before the machine it was recorded on goes", async () => {
    const { contribution, command, host } = rig({ vault: deletionVault() });
    await command("takeControl");
    await command("startDemonstration");

    await command("updateComputer");
    await contribution.settleScheduledWork();

    const stop = host.calls.indexOf(`demonstration:stop:${BOT}`);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(host.calls.indexOf(`replace:${USER}`));
    expect((await contribution.read(USER, BOT)).demonstration?.status).toBe(
      "ready",
    );
  });

  test("a Reset collects it before the machine goes back to its checkpoint", async () => {
    const { contribution, command, host } = rig({ vault: deletionVault() });
    await command("saveCheckpoint");
    await command("takeControl");
    await command("startDemonstration");

    await command("resetComputer");
    await contribution.settleScheduledWork();

    const stop = host.calls.indexOf(`demonstration:stop:${BOT}`);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(host.calls.indexOf(`reset:${BOT}`));
    expect((await contribution.read(USER, BOT)).demonstration?.status).toBe(
      "ready",
    );
  });

  test("after Delete my Computer, the alarm lets it go without opening a Computer", async () => {
    const vault = deletionVault();
    const { contribution, command, clock, storage, host } = rig({ vault });
    await command("takeControl");
    await command("startDemonstration");
    vault.deletedAt = new Date(clock.now).toISOString();
    await host.teardown({ userId: USER });
    const calls = host.calls.length;

    clock.now = Math.min(...(await contribution.scheduledDeadlines(storage)));
    await contribution.settleScheduledWork();

    expect(host.calls.slice(calls)).toEqual([]);
    expect((await contribution.read(USER, BOT)).demonstration).toBeUndefined();
    expect(await contribution.scheduledDeadlines(storage)).toEqual([]);
  });

  test("an expiry the store refuses is tried again later, never at once", async () => {
    const { contribution, command, clock, storage, uploads } = rig();
    await command("takeControl");
    await command("startDemonstration");
    await command("stopDemonstration");
    uploads.failRemove = true;
    clock.now += COMPUTER_DEMONSTRATION_RETENTION_MS;
    await contribution.settleScheduledWork();
    expect(await contribution.scheduledDeadlines(storage)).toEqual([
      clock.now + COMPUTER_DEMONSTRATION_RETRY_MS,
    ]);
    uploads.failRemove = false;
    clock.now += COMPUTER_DEMONSTRATION_RETRY_MS;
    await contribution.settleScheduledWork();
    expect(await contribution.scheduledDeadlines(storage)).toEqual([]);
  });
});
