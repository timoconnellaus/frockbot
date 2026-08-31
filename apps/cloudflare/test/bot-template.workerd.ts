// Staging and sharing a Bot template inside a real User Durable Object, over
// the real `PACKAGE_CATALOG` bucket.
//
// Three claims the unit suite cannot make, because each depends on real
// object storage or real durable state surviving an eviction:
//
//  1. The blob is written through the collision-checking immutable put, so
//     re-staging identical content lands on the same key and writes nothing.
//  2. Visibility lives in the Durable Object, not in the blob: the same
//     immutable bytes go from unreadable to readable to unreadable again as the
//     User moves the share and finally revokes it.
//  3. The share record survives eviction, so a link handed out before a cold
//     start still resolves after one — and a revoked one still refuses.
import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  parseBotTemplateDocumentV1,
  parseTemplateShareIdV1,
  templateObjectKeyV1,
} from "@frockbot/template-core";
import type {
  TemplateShareListViewV1,
  TemplateShareReceiptV1,
} from "@frockbot/plugin-bot-template/shared";
import { provisionBot } from "./provision-bot.ts";

interface TemplateRpc {
  listTemplateShares(input: unknown): Promise<TemplateShareListViewV1>;
  executeTemplateCommand(input: unknown): Promise<TemplateShareReceiptV1>;
  resolveTemplateShare(input: unknown): Promise<
    | {
        schemaVersion: 1;
        hash: string;
        visibility: string;
        document: string;
      }
    | undefined
  >;
}

function user(userId: string): TemplateRpc {
  // SAFETY: USER_CONFIGURATIONS is bound to UserConfiguration; generated RPC
  // methods are not represented by workers-types.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as TemplateRpc;
}

async function stage(
  userId: string,
  botId: string,
  commandId: string,
): Promise<TemplateShareReceiptV1> {
  return user(userId).executeTemplateCommand({
    schemaVersion: 1,
    userId,
    command: { schemaVersion: 1, type: "template/stage", commandId, botId },
  });
}

async function setVisibility(
  userId: string,
  shareId: string,
  visibility: "private" | "link" | "public",
  commandId: string,
): Promise<TemplateShareReceiptV1> {
  return user(userId).executeTemplateCommand({
    schemaVersion: 1,
    userId,
    command: {
      schemaVersion: 1,
      type: "template/set-visibility",
      commandId,
      shareId,
      visibility,
    },
  });
}

async function objectKeys(): Promise<string[]> {
  const listing = await env.PACKAGE_CATALOG.list({ prefix: "templates/" });
  return listing.objects.map((object) => object.key).sort();
}

describe("staging a Bot template in workerd", () => {
  test("writes one immutable blob and re-stages onto the same key", async () => {
    const userId = `template-stage-${crypto.randomUUID()}`;
    const botId = "budget";
    await provisionBot({ userId, botId });

    const first = await stage(userId, botId, "stage-1");
    expect(first.status).toBe("applied");
    expect(first.share.visibility).toBe("private");
    expect(parseTemplateShareIdV1(first.share.shareId).ownerId).toBe(userId);

    const key = templateObjectKeyV1(first.share.hash);
    const stored = await env.PACKAGE_CATALOG.get(key);
    expect(stored).not.toBeNull();
    const document = await stored!.text();
    const template = parseBotTemplateDocumentV1(document);
    expect(template.profile.name).toBe("Workerd Bot");
    // The provisioned Bot's model names a Connection, and neither travels.
    expect(document).not.toContain("workerd-test-key");
    expect(document).not.toContain("connectionId");

    // A second staging of the same Bot produces the same bytes, so the
    // collision check makes the put a no-op and no second object appears.
    const before = await objectKeys();
    expect(before).toContain(key);
    const second = await stage(userId, botId, "stage-2");
    expect(second.share.hash).toBe(first.share.hash);
    expect(second.share.shareId).not.toBe(first.share.shareId);
    expect(await objectKeys()).toEqual(before);
  });

  test("replays one staging command as a read", async () => {
    const userId = `template-replay-${crypto.randomUUID()}`;
    const botId = "budget";
    await provisionBot({ userId, botId });

    const first = await stage(userId, botId, "stage-1");
    const replayed = await stage(userId, botId, "stage-1");
    expect(replayed.share.shareId).toBe(first.share.shareId);
    expect(
      (
        await user(userId).listTemplateShares({
          schemaVersion: 1,
          userId,
        })
      ).shares,
    ).toHaveLength(1);
  });

  test("refuses to stage a Bot this User does not have", async () => {
    const userId = `template-foreign-${crypto.randomUUID()}`;
    await provisionBot({ userId, botId: "budget" });
    await expect(stage(userId, "someone-elses-bot", "stage-1")).rejects.toThrow(
      /not registered/,
    );
  });
});

describe("visibility, revocation and eviction", () => {
  test("moves an immutable blob between visibilities and revokes it", async () => {
    const userId = `template-visibility-${crypto.randomUUID()}`;
    const botId = "budget";
    await provisionBot({ userId, botId });
    const staged = await stage(userId, botId, "stage-1");
    const shareId = staged.share.shareId;

    // Private: the bytes exist, and nothing unauthenticated may read them.
    expect(
      await user(userId).resolveTemplateShare({ schemaVersion: 1, shareId }),
    ).toBeUndefined();

    await setVisibility(userId, shareId, "link", "visibility-link");
    const linked = await user(userId).resolveTemplateShare({
      schemaVersion: 1,
      shareId,
    });
    expect(linked?.visibility).toBe("link");
    expect(linked?.hash).toBe(staged.share.hash);

    await setVisibility(userId, shareId, "public", "visibility-public");
    expect(
      (await user(userId).resolveTemplateShare({ schemaVersion: 1, shareId }))
        ?.visibility,
    ).toBe("public");

    // Back to private, without touching the blob: the object is still there.
    await setVisibility(userId, shareId, "private", "visibility-private");
    expect(
      await user(userId).resolveTemplateShare({ schemaVersion: 1, shareId }),
    ).toBeUndefined();
    expect(await objectKeys()).toContain(
      templateObjectKeyV1(staged.share.hash),
    );
  });

  test("a revoked share stays revoked across Durable Object eviction", async () => {
    const userId = `template-revoke-${crypto.randomUUID()}`;
    const botId = "budget";
    await provisionBot({ userId, botId });
    const staged = await stage(userId, botId, "stage-1");
    const shareId = staged.share.shareId;
    await setVisibility(userId, shareId, "link", "visibility-link");

    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
    expect(
      await user(userId).resolveTemplateShare({ schemaVersion: 1, shareId }),
    ).toBeDefined();

    await user(userId).executeTemplateCommand({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "template/revoke",
        commandId: "revoke-1",
        shareId,
      },
    });
    expect(
      await user(userId).resolveTemplateShare({ schemaVersion: 1, shareId }),
    ).toBeUndefined();

    // A revoked share is a permanent refusal, and the record that says so is
    // durable: a cold start answers the same way.
    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
    const shares = (
      await user(userId).listTemplateShares({ schemaVersion: 1, userId })
    ).shares;
    expect(shares[0]?.revokedAt).toBeDefined();
    expect(
      await user(userId).resolveTemplateShare({ schemaVersion: 1, shareId }),
    ).toBeUndefined();
  });
});
