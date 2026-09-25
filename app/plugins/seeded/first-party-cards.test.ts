/**
 * The five locked card Plugins, drawn the way the kernel draws them (ADR 0030
 * step 7).
 *
 * The modules under test are the built artifacts, not the sources beside
 * them: an artifact is what a Bot's worker actually loads, and the source is
 * Plugin code the app's type checker deliberately does not compile. The
 * freshness gate in `bun run typecheck` is what keeps the two the same thing.
 *
 * What each test asks is the same question the seam asks at run time: does
 * the payload the Bot sent validate against the card's declared schema, and
 * does what the Plugin draws survive `decodeSendToUserPayloadV1` and the
 * Card's own budgets?
 */
import { describe, expect, test } from "bun:test";
import {
  decodeSendToUserPayloadV1,
  validateAgainstJsonSchemaV1,
  type A2uiComponentV1,
} from "@frockbot/core/contracts";
import { bindCardApprovalsV1 } from "@frockbot/app/shell/cards";
import {
  FIRST_PARTY_CARD_PLUGINS_V1,
  firstPartyCardDrawV1,
} from "@frockbot/app/shell/first-party-cards";
import { DEPLOYMENT_PLUGIN_CATALOG_V1 } from "../catalog.ts";
import { SEEDED_PLUGIN_ARTIFACTS_V1 } from "./artifacts.generated.ts";

interface CardModule {
  cards: Record<
    string,
    { render(payload: unknown, ctx: unknown): Promise<unknown> | unknown }
  >;
}

const modules = new Map<string, CardModule>();
for (const pluginId of Object.values(FIRST_PARTY_CARD_PLUGINS_V1).map(
  (entry) => entry.pluginId,
)) {
  const artifact = SEEDED_PLUGIN_ARTIFACTS_V1.find(
    (entry) => entry.pluginId === pluginId,
  )!;
  const path = `${process.env.TMPDIR ?? "/tmp"}/frockbot-${pluginId}-${artifact.contentHash.slice(0, 16)}.mjs`;
  await Bun.write(path, artifact.module);
  modules.set(pluginId, (await import(path)) as CardModule);
}

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

function messagesOf(answer: unknown): Record<string, unknown>[] {
  return Array.isArray(answer)
    ? (answer as Record<string, unknown>[])
    : ((answer as { messages: Record<string, unknown>[] }).messages ?? []);
}

function componentsOf(answer: unknown): A2uiComponentV1[] {
  const payload = decodeSendToUserPayloadV1(
    { type: "card", surfaceId: "surface-1", messages: messagesOf(answer) },
    "card",
    { kernelMinted: true },
  );
  if (payload.type !== "card") throw new Error("not a card");
  const first = payload.messages[0]!;
  if (!("createSurface" in first)) throw new Error("not a createSurface");
  return first.createSurface.components ?? [];
}

/** Draws one member exactly as the seam would, through its own Plugin. */
async function drawV1(payload: Parameters<typeof firstPartyCardDrawV1>[0]) {
  const request = firstPartyCardDrawV1(payload)!;
  expect(request).toBeDefined();
  const seeded = DEPLOYMENT_PLUGIN_CATALOG_V1.find(
    (plugin) => plugin.pluginId === request.pluginId,
  )!;
  const card = seeded.descriptor.cards!.find(
    (entry) => entry.id === request.cardId,
  )!;
  // The seam validates the values against the declared schema before the
  // Plugin ever sees them, so a mapping that shaped them wrongly fails here
  // rather than drawing a card nobody asked for.
  validateAgainstJsonSchemaV1(request.data, card.dataSchema, "data");
  const module = modules.get(request.pluginId)!;
  return {
    request,
    seeded,
    answer: await module.cards[request.cardId]!.render(
      { surfaceId: "surface-1", data: request.data },
      ctx,
    ),
  };
}

describe("the five locked card Plugins", () => {
  test("each is seeded locked, with one card and no tool of its own", () => {
    for (const { pluginId, cardId } of Object.values(
      FIRST_PARTY_CARD_PLUGINS_V1,
    )) {
      const seeded = DEPLOYMENT_PLUGIN_CATALOG_V1.find(
        (plugin) => plugin.pluginId === pluginId,
      );
      expect(seeded, pluginId).toBeDefined();
      // Locked is the whole point: a switch on one of these would be a switch
      // on the Bot's voice, so a User may not turn it off or uninstall it.
      expect(seeded!.seed, pluginId).toBe("locked");
      expect(seeded!.descriptor.tools, pluginId).toEqual([]);
      expect(seeded!.descriptor.grants, pluginId).toEqual([]);
      expect(
        seeded!.descriptor.cards!.map((card) => card.id),
        pluginId,
      ).toEqual([cardId]);
      // Nothing to teach the Bot the send tool does not already say.
      expect(seeded!.descriptor.skills, pluginId).toBeUndefined();
    }
  });

  test("an approval draws the kernel's own decision, never one of its own", async () => {
    const { answer } = await drawV1({
      type: "approval",
      approvalId: "ap-1",
      action: "Delete the production bucket",
      rationale: "It is empty and the bill is not.",
      risk: "high",
    });
    const components = componentsOf(answer);
    expect(components.map((component) => component.component)).toEqual([
      "Column",
      "CardHeader",
      "Markdown",
      "ApprovalActions",
    ]);
    const header = components[1] as unknown as Record<string, unknown>;
    expect(header.title).toBe("Delete the production bucket");
    expect(header.status).toBe("High risk");
    expect(header.tone).toBe("danger");
    // The id the card was drawn with is a placeholder; the kernel binds it to
    // the Approval it recorded, which for a mapped send is the id the Bot
    // itself chose, so the decision the card answers is the decision the log
    // already holds.
    const bound = bindCardApprovalsV1(
      [
        {
          version: "v1.0",
          createSurface: { surfaceId: "surface-1", components },
        },
      ],
      () => "ap-1",
    );
    expect(bound.approvalIds).toEqual(["ap-1"]);
    const first = bound.messages[0]!;
    if (!("createSurface" in first)) throw new Error("not a createSurface");
    expect(
      (first.createSurface.components![3] as unknown as Record<string, unknown>)
        .approvalId,
    ).toBe("ap-1");
  });

  test("a question offers its answers and raises conversation input", async () => {
    const { answer } = await drawV1({
      type: "widget",
      widget: {
        prompt: "Which one?",
        helpText: "Either is fine.",
        options: ["A", "B"],
        allowCustom: true,
      },
    });
    const components = componentsOf(answer);
    const chips = components.find(
      (component) => component.component === "ChoiceChips",
    ) as unknown as Record<string, unknown>;
    expect(chips.options).toEqual([
      { label: "A", value: "A" },
      { label: "B", value: "B" },
    ]);
    // Not `approval/` and not `plugin/`, so the kernel routes the press as the
    // Bot's next Turn's pending input — which is what a widget answer was.
    expect(chips.action).toEqual({
      event: {
        name: "question-answer",
        context: { answer: { path: "/answer" } },
      },
    });
    expect(
      components.some((component) => component.component === "Markdown"),
    ).toBe(true);
  });

  test("a one-answer question is a button rather than a chip row", async () => {
    const { answer } = await drawV1({
      type: "widget",
      widget: { prompt: "Ready?", options: ["Yes"] },
    });
    const components = componentsOf(answer);
    expect(components.map((component) => component.component)).toEqual([
      "Column",
      "CardHeader",
      "Button",
      "Text",
    ]);
    expect(
      (components[2] as unknown as Record<string, unknown>).action,
    ).toEqual({
      event: { name: "question-answer", context: { answer: "Yes" } },
    });
  });

  test("an attachment names the file, and offers no door it cannot open", async () => {
    const secure = componentsOf(
      (
        await drawV1({
          type: "attachment",
          url: "https://files.example.com/reports/q3.pdf",
          mediaType: "application/pdf",
        })
      ).answer,
    );
    const file = secure[1] as unknown as Record<string, unknown>;
    expect(file.component).toBe("FileAttachment");
    expect(file.name).toBe("q3.pdf");
    expect(file.kind).toBe("document");
    expect(file.url).toBe("https://files.example.com/reports/q3.pdf");

    // The send seam still accepts `http`, and the catalog opens `https` only.
    // The link is named rather than made into a control that cannot work —
    // and, just as importantly, the whole card is not refused for it.
    const plain = componentsOf(
      (
        await drawV1({
          type: "attachment",
          url: "http://files.example.com/a.txt",
          name: "notes",
        })
      ).answer,
    );
    const insecure = plain[1] as unknown as Record<string, unknown>;
    expect(insecure.url).toBeUndefined();
    expect(insecure.detail).toContain("http://files.example.com/a.txt");
  });

  test("a secret request carries one host field and no action", async () => {
    const components = componentsOf(
      (
        await drawV1({
          type: "secret-request",
          prompt: "I need the Stripe key.",
          secretName: "STRIPE_KEY",
        })
      ).answer,
    );
    expect(components.map((component) => component.component)).toEqual([
      "Column",
      "CardHeader",
      "KeyValueRows",
      "SecretField",
      "Callout",
    ]);
    // The one field is the host's `SecretField`, which the kernel binds.
    // Nothing is an action, and nothing is a form input whose value would
    // land in the card's data model.
    for (const component of components) {
      const record = component as unknown as Record<string, unknown>;
      expect(record.action).toBeUndefined();
      expect(record.component).not.toBe("TextField");
    }
    expect(
      (components[2] as unknown as Record<string, unknown>).rows,
    ).toMatchObject([
      { label: "Saved as", value: "STRIPE_KEY" },
      { label: "Used on", value: "Any site, with your approval each time" },
    ]);
  });

  test("an agent card is a title, whose Bot it is, and the body", async () => {
    const components = componentsOf(
      (
        await drawV1({
          type: "agent-card",
          agentId: "bot-2",
          title: "Routine ready",
          body: "It runs every morning at eight.",
        })
      ).answer,
    );
    expect(components.map((component) => component.component)).toEqual([
      "Column",
      "CardHeader",
      "Markdown",
    ]);
    expect((components[1] as unknown as Record<string, unknown>).subtitle).toBe(
      "bot-2",
    );
  });

  test("a draw with nothing to draw is a deliberate drop, not a throw", async () => {
    const module = modules.get("approvals")!;
    expect(
      await module.cards.decision!.render(
        { surfaceId: "surface-1", data: { action: "", risk: "low" } },
        ctx,
      ),
    ).toMatchObject({ drop: true });
  });
});
