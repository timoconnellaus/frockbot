// Bot-owned and Bot-shared Applets (ADR 0027), through the real User Durable
// Object.
//
// Two groups of claims a Bun double of the directory cannot make, because each
// one is about the RPC surface the Bot and the routes actually call and the
// Flock the directory asks about a Bot's lifecycle:
//
//  1. Access is scoped to the acting Bot. The owner lists its Applet and a
//     sibling Bot does not until it is shared; a shared Bot may read and use
//     but not change, delete, share or read as owner; only an active Bot of
//     the Flock can be given access; a transfer swaps the roles and replays
//     cleanly; an unshare takes the access away.
//  2. The Bot lifecycle saga carries the Applet consequence. Archiving the
//     owner hides its Applets from every Bot and every Composition while
//     keeping them; restoring brings them back; deleting the owner tombstones
//     them and cleans their state; deleting a shared Bot takes it off shares.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { appletStateNameV1 } from "@frockbot/core/durable";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";

interface Summary {
  appletId: string;
  displayName: string;
  status: string;
  tools: string[];
  ownerBotId: string;
  access: "owner" | "shared";
  sharedWithBotIds: string[];
}

interface UserRpc {
  listApplets(input: unknown): Promise<{ revision: number; applets: Summary[] }>;
  readApplet(input: unknown): Promise<Summary>;
  readAppletCompositionInput(input: unknown): Promise<{
    revision: number;
    applets: Array<{
      appletId: string;
      ownerBotId: string;
      sharedWithBotIds: string[];
    }>;
  }>;
  createApplet(input: unknown): Promise<Summary>;
  recordAppletGeneration(input: unknown): Promise<Summary>;
  deleteApplet(input: unknown): Promise<Summary>;
  shareApplet(input: unknown): Promise<Summary>;
  unshareApplet(input: unknown): Promise<Summary>;
  transferApplet(input: unknown): Promise<Summary>;
  readBotAppletImpact(input: unknown): Promise<{
    botId: string;
    fingerprint: string;
    applets: Array<{ appletId: string; sharedWithBotIds: string[] }>;
  }>;
  executeBotLifecycle(input: unknown): Promise<{
    status: string;
    lifecycle: { botId: string; status: string };
  }>;
}

function user(userId: string): UserRpc {
  // SAFETY: the generated stub type is too deep to instantiate here; this
  // names only the methods the test calls.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as UserRpc;
}

/**
 * A rejected RPC, read from a catch: a rejection left to `expect().rejects`
 * is reported unhandled inside the object as well. The directory's errors are
 * recognised by `name`, which survives the Durable Object hop.
 */
async function refusal(
  call: () => Promise<unknown>,
): Promise<{ name: string; message: string } | "answered"> {
  try {
    await call();
  } catch (error) {
    return {
      name: error instanceof Error ? error.name : "",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return "answered";
}

/** One User with two active Bots, and the RPCs that name them. */
async function twoBots() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `applet-access-${suffix}`;
  const owner = `owner-${suffix}`;
  const other = `other-${suffix}`;
  await provisionBot({ userId, botId: owner });
  await provisionSiblingBot({ userId, botId: other }, 1);
  const rpc = user(userId);
  const envelope = { schemaVersion: 1 as const, userId };
  return {
    userId,
    owner,
    other,
    rpc,
    list: (botId: string) => rpc.listApplets({ ...envelope, botId }),
    listed: async (botId: string) =>
      (await rpc.listApplets({ ...envelope, botId })).applets.map(
        (applet) => applet.appletId,
      ),
    read: (botId: string, appletId: string, owned = false) =>
      rpc.readApplet({
        ...envelope,
        botId,
        appletId,
        ...(owned ? { owner: true } : {}),
      }),
    create: (botId: string, displayName: string) =>
      rpc.createApplet({
        ...envelope,
        botId,
        displayName,
        provenance: { kind: "user" },
      }),
    publish: (botId: string, appletId: string, tool: string) =>
      rpc.recordAppletGeneration({
        ...envelope,
        botId,
        appletId,
        generationId: `${tool}-g1`,
        tools: [
          {
            name: tool,
            description: `The ${tool} tool`,
            inputSchema: { type: "object" },
          },
        ],
      }),
    share: (botId: string, appletId: string, targetBotId: string) =>
      rpc.shareApplet({ ...envelope, botId, appletId, targetBotId }),
    unshare: (botId: string, appletId: string, targetBotId: string) =>
      rpc.unshareApplet({ ...envelope, botId, appletId, targetBotId }),
    transfer: (botId: string, appletId: string, targetBotId: string) =>
      rpc.transferApplet({ ...envelope, botId, appletId, targetBotId }),
    remove: (botId: string, appletId: string) =>
      rpc.deleteApplet({ ...envelope, botId, appletId }),
    composition: async () =>
      (await rpc.readAppletCompositionInput(envelope)).applets,
    lifecycle: (type: string, botId: string) =>
      rpc.executeBotLifecycle({
        ...envelope,
        command: {
          schemaVersion: 1,
          type,
          commandId: `${type.split("/")[1]}-${crypto.randomUUID()}`,
          botId,
        },
      }),
    entry: (appletId: string) =>
      runInDurableObject(
        env.USER_CONFIGURATIONS.getByName(userId),
        async (_instance, state) =>
          state.storage.get<{
            status: string;
            available: boolean;
            ownerBotId: string;
            sharedWithBotIds: string[];
            tools: unknown[];
          }>(`applets:entry:${appletId}`),
      ),
    cleanups: () =>
      runInDurableObject(
        env.USER_CONFIGURATIONS.getByName(userId),
        async (_instance, state) => [
          ...(await state.storage.list({ prefix: "applets:cleanup:" })).keys(),
        ],
      ),
  };
}

function appletState(userId: string, appletId: string) {
  return env.APPLET_STATES.get(
    env.APPLET_STATES.idFromName(appletStateNameV1(userId, appletId)),
  );
}

describe("an Applet's access is scoped to the Bot acting", () => {
  test("the owner lists it, a sibling does not until it is shared, and a shared Bot may only use it", async () => {
    const bots = await twoBots();
    const { owner, other } = bots;
    const created = await bots.create(owner, "Expenses");
    expect(created).toMatchObject({
      ownerBotId: owner,
      access: "owner",
      sharedWithBotIds: [],
    });
    const applet = created.appletId;

    expect(await bots.listed(owner)).toEqual([applet]);
    // Another Bot of the same User: not listed, and not readable either — an
    // Applet a Bot cannot reach answers exactly as one that does not exist.
    expect(await bots.listed(other)).toEqual([]);
    expect(await refusal(() => bots.read(other, applet))).toMatchObject({
      name: "AppletUnavailableError",
    });

    const before = (await bots.list(owner)).revision;
    expect(await bots.share(owner, applet, other)).toMatchObject({
      access: "owner",
      sharedWithBotIds: [other],
    });
    expect((await bots.list(owner)).revision).toBeGreaterThan(before);
    // A repeated share is the same answer, and writes nothing.
    const revision = (await bots.list(owner)).revision;
    expect(await bots.share(owner, applet, other)).toMatchObject({
      sharedWithBotIds: [other],
    });
    expect((await bots.list(owner)).revision).toBe(revision);

    // The shared Bot lists and reads it, as shared, and is not told who else
    // holds it.
    expect(await bots.listed(other)).toEqual([applet]);
    expect(await bots.read(other, applet)).toMatchObject({
      appletId: applet,
      ownerBotId: owner,
      access: "shared",
      sharedWithBotIds: [],
    });

    // Everything only the owner may do is refused by name.
    for (const [label, attempt] of [
      ["owner read", () => bots.read(other, applet, true)],
      ["publish", () => bots.publish(other, applet, "file_expense")],
      ["delete", () => bots.remove(other, applet)],
      ["share", () => bots.share(other, applet, owner)],
      ["unshare", () => bots.unshare(other, applet, other)],
    ] as const) {
      expect(await refusal(attempt), label).toMatchObject({
        name: "AppletNotOwnerError",
      });
    }
    // And none of those refusals changed anything.
    expect(await bots.entry(applet)).toMatchObject({
      status: "draft",
      ownerBotId: owner,
      sharedWithBotIds: [other],
      available: true,
    });

    // The owner may still do all of it.
    expect(await bots.read(owner, applet, true)).toMatchObject({
      access: "owner",
    });
    expect(await bots.publish(owner, applet, "file_expense")).toMatchObject({
      status: "published",
      tools: ["file_expense"],
    });
    // Its Composition member carries the access a Turn pins.
    expect(await bots.composition()).toEqual([
      expect.objectContaining({
        appletId: applet,
        ownerBotId: owner,
        sharedWithBotIds: [other],
      }),
    ]);

    // An unshare takes the use away, and repeating it is free.
    expect(await bots.unshare(owner, applet, other)).toMatchObject({
      sharedWithBotIds: [],
    });
    expect(await bots.unshare(owner, applet, other)).toMatchObject({
      sharedWithBotIds: [],
    });
    expect(await bots.listed(other)).toEqual([]);
    expect(await refusal(() => bots.read(other, applet))).toMatchObject({
      name: "AppletUnavailableError",
    });
  });

  test("access can be given only to an active Bot of the same Flock", async () => {
    const bots = await twoBots();
    const { owner, other } = bots;
    const applet = (await bots.create(owner, "Garden")).appletId;

    // A Bot the Flock has never heard of.
    expect(
      await refusal(() => bots.share(owner, applet, "ghost-bot")),
    ).toMatchObject({ name: "AppletAccessRefusedError" });
    expect(
      await refusal(() => bots.transfer(owner, applet, "ghost-bot")),
    ).toMatchObject({ name: "AppletAccessRefusedError" });
    // The owner itself.
    expect(await refusal(() => bots.share(owner, applet, owner))).toMatchObject(
      { name: "AppletAccessRefusedError" },
    );

    // An archived Bot of this Flock.
    expect(await bots.lifecycle("bot/archive", other)).toMatchObject({
      status: "applied",
      lifecycle: { status: "archived" },
    });
    const archived = await refusal(() => bots.share(owner, applet, other));
    expect(archived).toMatchObject({ name: "AppletAccessRefusedError" });
    expect(archived !== "answered" && archived.message).toMatch(/archived/);
    expect(
      await refusal(() => bots.transfer(owner, applet, other)),
    ).toMatchObject({ name: "AppletAccessRefusedError" });
    expect(await bots.entry(applet)).toMatchObject({
      ownerBotId: owner,
      sharedWithBotIds: [],
    });

    // Restored, it can be given access again.
    await bots.lifecycle("bot/restore", other);
    expect(await bots.share(owner, applet, other)).toMatchObject({
      sharedWithBotIds: [other],
    });
  });

  test("a transfer makes the target the owner and keeps the former owner shared, and a replay settles", async () => {
    const bots = await twoBots();
    const { owner, other } = bots;
    const applet = (await bots.create(owner, "Budget")).appletId;
    await bots.publish(owner, applet, "track_budget");

    const transferred = await bots.transfer(owner, applet, other);
    // Answered as the caller now sees it: shared, and told nothing of shares.
    expect(transferred).toMatchObject({
      appletId: applet,
      ownerBotId: other,
      access: "shared",
      sharedWithBotIds: [],
      status: "published",
      tools: ["track_budget"],
    });
    expect(await bots.read(other, applet)).toMatchObject({
      ownerBotId: other,
      access: "owner",
      sharedWithBotIds: [owner],
    });
    // Metadata only: the publication is untouched, so both Bots still list it.
    expect(await bots.listed(owner)).toEqual([applet]);
    expect(await bots.listed(other)).toEqual([applet]);

    // The same transfer replayed — a Turn retried after the write landed — is
    // the same answer rather than a refusal, and moves no revision.
    const revision = (await bots.list(other)).revision;
    expect(await bots.transfer(owner, applet, other)).toEqual(transferred);
    expect((await bots.list(other)).revision).toBe(revision);

    // The roles really swapped.
    expect(
      await refusal(() => bots.publish(owner, applet, "track_budget")),
    ).toMatchObject({ name: "AppletNotOwnerError" });
    expect(await refusal(() => bots.remove(owner, applet))).toMatchObject({
      name: "AppletNotOwnerError",
    });
    expect(await bots.publish(other, applet, "track_budget")).toMatchObject({
      ownerBotId: other,
      access: "owner",
    });

    // And the new owner can take the former owner's use away.
    await bots.unshare(other, applet, owner);
    expect(await bots.listed(owner)).toEqual([]);
    expect(await refusal(() => bots.read(owner, applet))).toMatchObject({
      name: "AppletUnavailableError",
    });
  });
});

describe("the Bot lifecycle saga carries the Applet consequence", () => {
  test("archiving the owner hides its Applets from every Bot and Composition, and restoring brings them back", async () => {
    const bots = await twoBots();
    const { owner, other } = bots;
    const applet = (await bots.create(owner, "Chores")).appletId;
    await bots.publish(owner, applet, "add_chore");
    await bots.share(owner, applet, other);
    // An Applet the other Bot owns and shares with the owner is not the
    // owner's to take away.
    const theirs = (await bots.create(other, "Recipes")).appletId;
    await bots.publish(other, theirs, "add_recipe");
    await bots.share(other, theirs, owner);
    const impact = await bots.rpc.readBotAppletImpact({
      schemaVersion: 1,
      userId: bots.userId,
      botId: owner,
    });
    expect(impact.applets).toEqual([
      expect.objectContaining({ appletId: applet, sharedWithBotIds: [other] }),
    ]);
    expect(impact.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    const before = (await bots.list(other)).revision;
    expect(await bots.lifecycle("bot/archive", owner)).toMatchObject({
      status: "applied",
      lifecycle: { status: "archived" },
    });
    expect((await bots.list(other)).revision).toBeGreaterThan(before);

    // Gone from every Bot's list and from the User's next Composition…
    expect(await bots.listed(other)).toEqual([theirs]);
    expect(await bots.listed(owner)).not.toContain(applet);
    expect(await refusal(() => bots.read(other, applet))).toMatchObject({
      name: "AppletUnavailableError",
    });
    expect((await bots.composition()).map((member) => member.appletId)).toEqual(
      [theirs],
    );
    // …but kept whole: the entry is still published, with its tools and its
    // shares, only unavailable.
    expect(await bots.entry(applet)).toMatchObject({
      status: "published",
      available: false,
      ownerBotId: owner,
      sharedWithBotIds: [other],
    });
    expect((await bots.entry(applet))?.tools).toHaveLength(1);

    const archivedRevision = (await bots.list(other)).revision;
    expect(await bots.lifecycle("bot/restore", owner)).toMatchObject({
      status: "applied",
      lifecycle: { status: "active" },
    });
    expect((await bots.list(other)).revision).toBeGreaterThan(archivedRevision);
    expect(await bots.listed(other)).toEqual(
      expect.arrayContaining([applet, theirs]),
    );
    expect(await bots.listed(owner)).toEqual(
      expect.arrayContaining([applet, theirs]),
    );
    expect(await bots.entry(applet)).toMatchObject({ available: true });
    expect(
      (await bots.composition()).map((member) => member.appletId).sort(),
    ).toEqual([applet, theirs].sort());
  });

  test("deleting the owner tombstones its Applets and cleans their state; deleting a shared Bot takes it off shares", async () => {
    const bots = await twoBots();
    const { userId, owner, other } = bots;
    const applet = (await bots.create(owner, "Journal")).appletId;
    await bots.publish(owner, applet, "write_entry");
    // Shared or not, the owner's deletion takes it.
    await bots.share(owner, applet, other);
    const theirs = (await bots.create(other, "Reading")).appletId;
    await bots.publish(other, theirs, "add_book");
    await bots.share(other, theirs, owner);

    // Something in the Applet's own storage, so "cleaned" is observable.
    const state = appletState(userId, applet);
    await runInDurableObject(state, async (_instance, durable) => {
      await durable.storage.put("probe", "the Applet's data");
    });

    const before = (await bots.list(other)).revision;
    expect(await bots.lifecycle("bot/delete", owner)).toMatchObject({
      status: "applied",
      lifecycle: { botId: owner, status: "deleted" },
    });
    expect((await bots.list(other)).revision).toBeGreaterThan(before);

    // The owner's Applet is a tombstone: no tools, no shares, not listed for
    // the Bot it was shared with, and not in any Composition.
    expect(await bots.entry(applet)).toMatchObject({
      status: "deleted",
      sharedWithBotIds: [],
      tools: [],
    });
    expect(await bots.listed(other)).toEqual([theirs]);
    expect(await refusal(() => bots.read(other, applet))).toMatchObject({
      name: "AppletUnavailableError",
    });
    expect((await bots.composition()).map((member) => member.appletId)).toEqual(
      [theirs],
    );

    // The deleted Bot is off the share of the Applet it did not own, which
    // otherwise survives untouched.
    expect(await bots.entry(theirs)).toMatchObject({
      status: "published",
      ownerBotId: other,
      sharedWithBotIds: [],
      available: true,
    });

    // The cleanup the settle queued was swept on the command's own path: the
    // to-do is drained and the Applet's storage is empty.
    expect(await bots.cleanups()).toEqual([]);
    expect(
      await runInDurableObject(state, async (_instance, durable) =>
        (await durable.storage.list()).size,
      ),
    ).toBe(0);
  });
});
