/**
 * The connectors Plugin: a Bot offering an app it cannot reach yet, drawn the
 * way the kernel draws it.
 *
 * The module under test is the built artifact, not the source beside it: the
 * artifact is what a Bot's worker actually loads, and the freshness gate in
 * `bun run typecheck` is what keeps the two the same thing.
 */
import { describe, expect, test } from "bun:test";
import {
  decodeSendToUserPayloadV1,
  validateAgainstJsonSchemaV1,
  type A2uiAgentMessageV1,
  type A2uiComponentV1,
} from "@frockbot/core/contracts";
import { bindCardConnectAppsV1 } from "@frockbot/app/shell/cards";
import { connectCardAppV1 } from "@frockbot/app/connect/card";
import { DEPLOYMENT_PLUGIN_CATALOG_V1 } from "../catalog.ts";
import { SEEDED_PLUGIN_ARTIFACTS_V1 } from "./artifacts.generated.ts";

const artifact = SEEDED_PLUGIN_ARTIFACTS_V1.find(
  (entry) => entry.pluginId === "connectors",
)!;
// Written outside the checkout: it is a build output, not a source file.
const modulePath = `${process.env.TMPDIR ?? "/tmp"}/frockbot-connectors-${artifact.contentHash.slice(0, 16)}.mjs`;
await Bun.write(modulePath, artifact.module);
const { cards } = (await import(modulePath)) as {
  cards: Record<
    string,
    { render(payload: unknown, ctx: unknown): Promise<unknown> | unknown }
  >;
};

/** The `ctx` the wrapper builds for a Plugin holding no grant at all. */
const ctx = {
  user: { userId: "user-1" },
  bot: { botId: "bot-1" },
  session: {
    sessionId: "user-1:bot-1",
    runId: "run-1",
    turnId: "run-1",
    generationId: "gen-1",
  },
  deadlineMs: 10_000,
  bindings: ["CAPABILITIES", "IDENTITY"],
  services: {},
} as never;

const seeded = DEPLOYMENT_PLUGIN_CATALOG_V1.find(
  (plugin) => plugin.pluginId === "connectors",
)!;
const offer = seeded.descriptor.cards!.find((card) => card.id === "offer")!;

/** What the seam records: decoded like any send, then bound to the catalog. */
function recorded(answer: unknown): A2uiComponentV1[] {
  const payload = decodeSendToUserPayloadV1(
    {
      type: "card",
      surfaceId: "connectors_offer.1",
      messages: answer as A2uiAgentMessageV1[],
    },
    "card",
    { kernelMinted: true },
  );
  if (payload.type !== "card") throw new Error("not a card");
  const [first] = bindCardConnectAppsV1(payload.messages, connectCardAppV1);
  if (!first || !("createSurface" in first)) throw new Error("no surface");
  return first.createSurface.components ?? [];
}

describe("the connectors Plugin's offer card", () => {
  test("ships locked, with one card and nothing else", () => {
    expect(seeded.seed).toBe("locked");
    expect(seeded.descriptor.cards?.map((card) => card.id)).toEqual(["offer"]);
    expect(seeded.descriptor.tools).toEqual([]);
    expect(seeded.descriptor.grants).toEqual([]);
  });

  test("takes an app and a reason, and nothing it would not draw", () => {
    const valid = (data: unknown) => {
      try {
        validateAgainstJsonSchemaV1(data, offer.dataSchema);
        return true;
      } catch {
        return false;
      }
    };
    expect(valid({ app: "gmail", reason: "So I can read your inbox." })).toBe(
      true,
    );
    expect(valid({ app: "gmail" })).toBe(true);
    expect(valid({ app: "" })).toBe(false);
    expect(valid({ reason: "No app." })).toBe(false);
    expect(valid({ app: "gmail", name: "Slack" })).toBe(false);
  });

  test("draws the reason above the app, bound to what it connects", async () => {
    const components = recorded(
      await cards.offer!.render(
        {
          surfaceId: "connectors_offer.1",
          data: { app: "Gmail", reason: "So I can read your inbox." },
        },
        ctx,
      ),
    );
    expect(components).toEqual([
      { id: "root", component: "Column", children: ["reason", "connect"] },
      {
        id: "reason",
        component: "Markdown",
        text: "So I can read your inbox.",
      },
      {
        id: "connect",
        component: "ConnectApp",
        app: "gmail",
        name: "Gmail",
        description: "Read, search, label and send email in a Gmail account.",
        packageId: "connect",
        connectionTypeId: "connect-gmail",
      },
    ]);
  });

  test("draws the app alone when there is no reason", async () => {
    const components = recorded(
      await cards.offer!.render(
        { surfaceId: "connectors_offer.1", data: { app: "slack" } },
        ctx,
      ),
    );
    expect(components.map((component) => component.id)).toEqual([
      "root",
      "connect",
    ]);
  });
});
