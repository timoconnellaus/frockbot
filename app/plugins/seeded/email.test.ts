/**
 * The email Plugin, drawn and driven the way the kernel drives it (ADR 0030).
 *
 * The module under test is the Plugin's source, which is exactly what the
 * artifact beside it is a bundle of — the freshness gate at the bottom is what
 * keeps those two the same thing.
 */
import { describe, expect, test } from "bun:test";
import {
  a2uiByteLengthV1,
  A2UI_LIMITS_V1,
  decodeA2uiAgentMessageV1,
  decodeSendToUserPayloadV1,
  type A2uiComponentV1,
} from "@frockbot/core/contracts";
import { bindCardApprovalsV1 } from "@frockbot/app/shell/cards";
import { DEPLOYMENT_PLUGIN_CATALOG_V1 } from "../catalog.ts";
import { SEEDED_PLUGIN_ARTIFACTS_V1 } from "./artifacts.generated.ts";

/**
 * The module under test is the built artifact, not the source beside it: the
 * artifact is what a Bot's worker actually loads, and the source is Plugin
 * code the app's type checker deliberately does not compile.
 */
const artifact = SEEDED_PLUGIN_ARTIFACTS_V1.find(
  (entry) => entry.pluginId === "email",
)!;
// Written outside the checkout: it is a build output, not a source file.
const modulePath = `${process.env.TMPDIR ?? "/tmp"}/frockbot-email-${artifact.contentHash.slice(0, 16)}.mjs`;
await Bun.write(modulePath, artifact.module);
const { cards, execute, tools } = (await import(modulePath)) as {
  cards: Record<
    string,
    {
      render(payload: unknown, ctx: unknown): Promise<unknown>;
      actions: Record<
        string,
        (press: unknown, ctx: unknown) => Promise<unknown>
      >;
    }
  >;
  execute(tool: string, input: unknown, ctx: unknown): Promise<string>;
  tools: { name: string }[];
};

const SURFACE = "email-draft-1";
/** The id the kernel minted for this card's decision, as the Bot reads it. */
const APPROVAL = "card-approval-1";

const draft = {
  to: ["nick@example.com"],
  cc: ["sam@example.com"],
  subject: "Re: Following up",
  inReplyTo: "<earlier@example.com>",
  body: Array.from({ length: 12 }, (_line, index) => `line ${index}`).join(
    "\n",
  ),
};

/** The `ctx` the wrapper builds for a Plugin holding `storage` and `http`. */
function context(
  options: {
    sent?:
      | { status: "sent"; messageId: string; undelivered?: string[] }
      | { status: "unavailable"; reason: string };
  } = {},
) {
  const store = new Map<string, unknown>();
  const sends: unknown[] = [];
  return {
    sends,
    store,
    ctx: {
      user: { userId: "user-1" },
      bot: { botId: "bot-1" },
      session: {
        sessionId: "user-1:bot-1",
        runId: "run-1",
        turnId: "run-1",
        generationId: "gen-1",
      },
      packageId: "email",
      deadlineMs: 10_000,
      bindings: ["CAPABILITIES", "IDENTITY"],
      capabilities: { list: () => Promise.resolve({ status: "available" }) },
      services: {},
      settings: {
        read: () => Promise.resolve({ status: "available", values: {} }),
      },
      storage: {
        get: (request: { key: string }) =>
          Promise.resolve({
            status: "available" as const,
            value: store.get(request.key) ?? null,
          }),
        put: (request: { key: string; value: unknown }) => {
          store.set(request.key, request.value);
          return Promise.resolve({ status: "available" as const, value: null });
        },
        delete: () =>
          Promise.resolve({ status: "available" as const, value: null }),
        list: () =>
          Promise.resolve({ status: "available" as const, entries: [] }),
      },
      email: (request: unknown) => {
        sends.push(request);
        return Promise.resolve(
          options.sent ?? { status: "sent" as const, messageId: "<sent@x.co>" },
        );
      },
    } as never,
  };
}

/** Every component a render answered with, decoded as the kernel decodes it. */
function componentsOf(answer: unknown): A2uiComponentV1[] {
  const messages = (answer as Record<string, unknown>[]).map((message, index) =>
    decodeA2uiAgentMessageV1(message, `message[${index}]`),
  );
  const first = messages[0]!;
  if ("createSurface" in first) return first.createSurface.components ?? [];
  if ("updateComponents" in first) return first.updateComponents.components;
  throw new Error("the card drew no components");
}

function named(components: A2uiComponentV1[], id: string): A2uiComponentV1 {
  const found = components.find((component) => component.id === id);
  expect(found, `no component "${id}"`).toBeDefined();
  return found!;
}

describe("the email Plugin's draft card", () => {
  test("draws the draft, its controls, and the decision the kernel will mint", async () => {
    const { ctx } = context();
    const answer = await cards.draft.render(
      { surfaceId: SURFACE, data: draft },
      ctx,
    );
    const components = componentsOf(answer);
    expect(components.map((component) => component.component)).toEqual([
      "Column",
      "StatusPill",
      "KeyValueRows",
      "CollapsibleText",
      "Button",
      "ApprovalActions",
    ]);
    expect(named(components, "status")).toMatchObject({
      label: "Ready to send",
      tone: "pending",
    });
    expect(named(components, "rows").rows).toEqual([
      { label: "To", value: "nick@example.com" },
      { label: "Cc", value: "sam@example.com" },
      { label: "Subject", value: "Re: Following up" },
    ]);
    expect(named(components, "body")).toMatchObject({ collapsedLines: 6 });
    expect(named(components, "more").action).toMatchObject({
      name: "plugin/email/details",
    });

    // The Plugin writes a placeholder; the kernel binds the real Approval.
    const bound = bindCardApprovalsV1(
      (answer as Record<string, unknown>[]).map((message, index) =>
        decodeA2uiAgentMessageV1(message, `message[${index}]`),
      ),
      () => APPROVAL,
      "email: draft",
    );
    expect(bound.approvals).toEqual([
      {
        approvalId: "card-approval-1",
        action: "Send an email to nick@example.com — Re: Following up",
        risk: "medium",
      },
    ]);
  });

  test("a draft with no recipient draws nothing", async () => {
    const { ctx } = context();
    expect(
      await cards.draft.render(
        { surfaceId: SURFACE, data: { ...draft, to: [] } },
        ctx,
      ),
    ).toMatchObject({ drop: true });
  });

  // The kernel's own sender refuses an address that is not one. Refusing it
  // here is the difference between the Bot fixing a typo and a person
  // approving a draft that could never leave.
  test("a draft naming something that is not an address draws nothing", async () => {
    for (const data of [
      { ...draft, to: ["nick@example"] },
      { ...draft, cc: ["sam at example.com"] },
    ]) {
      const { ctx } = context();
      const answer = await cards.draft.render(
        { surfaceId: `${SURFACE}-${data.to[0]}`, data },
        ctx,
      );
      expect(answer).toMatchObject({ drop: true });
      expect(String((answer as { reason: string }).reason)).toMatch(
        /is not an email address/,
      );
    }
  });

  test("the details action redraws the card with the rest of the headers", async () => {
    const { ctx } = context();
    await cards.draft.render({ surfaceId: SURFACE, data: draft }, ctx);
    const pressed = await cards.draft.actions!.details!(
      { surfaceId: SURFACE, action: "details", context: { full: true } },
      ctx,
    );
    const rows = named(componentsOf(pressed), "rows").rows as {
      label: string;
    }[];
    expect(rows.map((row) => row.label)).toEqual([
      "To",
      "Cc",
      "Subject",
      "In reply to",
    ]);
  });

  test("sends once, settles into a receipt, and never sends a discarded draft", async () => {
    const { ctx, sends } = context();
    await cards.draft.render({ surfaceId: SURFACE, data: draft }, ctx);
    expect(await execute("email_send", { surfaceId: SURFACE, approvalId: APPROVAL }, ctx)).toMatch(
      /Sent to nick@example.com/,
    );
    expect(sends).toEqual([
      {
        approvalId: APPROVAL,
        // The card the decision was given on: the kernel checks the Approval
        // against this surface and against these values.
        surfaceId: SURFACE,
        to: ["nick@example.com"],
        cc: ["sam@example.com"],
        subject: "Re: Following up",
        inReplyTo: "<earlier@example.com>",
        body: draft.body,
      },
    ]);
    // A retried Turn must not send the same mail twice.
    expect(await execute("email_send", { surfaceId: SURFACE, approvalId: APPROVAL }, ctx)).toMatch(
      /Already sent/,
    );
    expect(sends).toHaveLength(1);

    const settled = componentsOf(
      await cards.draft.render({ surfaceId: SURFACE, data: draft }, ctx),
    );
    expect(settled.map((component) => component.component)).toEqual([
      "Column",
      "Receipt",
    ]);
    expect(named(settled, "receipt")).toMatchObject({
      title: "Re: Following up",
      status: { label: "Sent", tone: "positive" },
      summary: "Sent to nick@example.com — Re: Following up",
    });

    await expect(
      execute("email_discard", { surfaceId: SURFACE }, ctx),
    ).rejects.toThrow(/already been sent/);
  });

  test("a discarded draft settles into a discarded receipt", async () => {
    const { ctx, sends } = context();
    await cards.draft.render({ surfaceId: SURFACE, data: draft }, ctx);
    expect(await execute("email_discard", { surfaceId: SURFACE }, ctx)).toMatch(
      /Discarded/,
    );
    const settled = componentsOf(
      await cards.draft.render({ surfaceId: SURFACE, data: draft }, ctx),
    );
    expect(named(settled, "receipt")).toMatchObject({
      status: { label: "Discarded", tone: "muted" },
      summary: "Discarded — Re: Following up",
    });
    await expect(
      execute("email_send", { surfaceId: SURFACE, approvalId: APPROVAL }, ctx),
    ).rejects.toThrow(/discarded/);
    expect(sends).toHaveLength(0);
  });

  test("a deployment with no sender is a refusal the Bot can read", async () => {
    const { ctx } = context({
      sent: { status: "unavailable", reason: "this deployment sends no email" },
    });
    await cards.draft.render({ surfaceId: SURFACE, data: draft }, ctx);
    await expect(
      execute("email_send", { surfaceId: SURFACE, approvalId: APPROVAL }, ctx),
    ).rejects.toThrow(/sends no email/);
  });

  test("every state fits the Card budgets, as one send would carry it", async () => {
    const { ctx } = context();
    for (const state of ["draft", "sent"] as const) {
      if (state === "sent") {
        await execute("email_send", { surfaceId: SURFACE, approvalId: APPROVAL }, ctx);
      }
      const answer = (await cards.draft.render(
        { surfaceId: SURFACE, data: draft },
        ctx,
      )) as Record<string, unknown>[];
      const payload = decodeSendToUserPayloadV1({
        type: "card",
        surfaceId: SURFACE,
        messages: answer,
      });
      expect(payload.type).toBe("card");
      for (const message of answer) {
        expect(a2uiByteLengthV1(message)).toBeLessThan(
          A2UI_LIMITS_V1.bytesPerMessage,
        );
      }
      expect(componentsOf(answer).length).toBeLessThan(
        A2UI_LIMITS_V1.componentsPerSurface,
      );
    }
  });

  test("will not send without the approvalId the decision line named", async () => {
    const { ctx, sends } = context();
    await cards.draft.render({ surfaceId: SURFACE, data: draft }, ctx);
    await expect(
      execute("email_send", { surfaceId: SURFACE }, ctx),
    ).rejects.toThrow(/approvalId is required/);
    expect(sends).toHaveLength(0);
  });

  test("a partial send is still a send, named and never retried", async () => {
    const { ctx, sends } = context({
      sent: {
        status: "sent",
        messageId: "<sent@x.co>",
        undelivered: ["sam@example.com"],
      },
    });
    await cards.draft.render({ surfaceId: SURFACE, data: draft }, ctx);
    const said = await execute(
      "email_send",
      { surfaceId: SURFACE, approvalId: APPROVAL },
      ctx,
    );
    expect(said).toMatch(/did not reach sam@example.com/);
    // The state was written even though one address was refused, so the
    // second call answers "already sent" rather than delivering again.
    expect(
      await execute(
        "email_send",
        { surfaceId: SURFACE, approvalId: APPROVAL },
        ctx,
      ),
    ).toMatch(/Already sent/);
    expect(sends).toHaveLength(1);
  });

  test("a redraw never changes what a pending decision covers", async () => {
    const { ctx, sends } = context();
    await cards.draft.render({ surfaceId: SURFACE, data: draft }, ctx);
    const redrawn = componentsOf(
      await cards.draft.render(
        {
          surfaceId: SURFACE,
          data: { ...draft, to: ["someone-else@example.com"] },
        },
        ctx,
      ),
    );
    const rows = named(redrawn, "rows").rows as { value: string }[];
    expect(rows[0]!.value).toBe("nick@example.com");
    expect(named(redrawn, "actions").action).toBe(
      "Send an email to nick@example.com — Re: Following up",
    );
    await execute(
      "email_send",
      { surfaceId: SURFACE, approvalId: APPROVAL },
      ctx,
    );
    expect((sends[0] as { to: string[] }).to).toEqual(["nick@example.com"]);
  });
});

describe("the seeded email Plugin", () => {
  test("is in the deployment's catalog, with the artifact the build produced", () => {
    const seeded = DEPLOYMENT_PLUGIN_CATALOG_V1.find(
      (plugin) => plugin.pluginId === "email",
    );
    expect(seeded?.seed).toBe("default-off");
    expect(seeded?.descriptor.cards?.map((card) => card.id)).toEqual(["draft"]);
    expect(seeded?.descriptor.tools.map((tool) => tool.name)).toEqual([
      "email_send",
      "email_discard",
    ]);
    // The Skill that says when to draft travels in the descriptor.
    expect(seeded?.descriptor.skills?.[0]?.slug).toBe("email");
    expect(seeded?.descriptor.grants).toContain("http");
    expect(seeded?.artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the module the worker would load is the artifact the catalog names", async () => {
    const artifact = SEEDED_PLUGIN_ARTIFACTS_V1.find(
      (entry) => entry.pluginId === "email",
    )!;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(artifact.module),
    );
    const contentHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(contentHash).toBe(artifact.contentHash);
    expect(artifact.size).toBe(
      new TextEncoder().encode(artifact.module).byteLength,
    );
    // The gate `bun run typecheck` runs: the sources digest to what the build
    // recorded, so an edited Plugin that was not rebuilt fails there.
    const sources = await Promise.all(
      ["plugin.json", "plugin.ts", "skill.md"].map((file) =>
        Bun.file(new URL(`./email/${file}`, import.meta.url)).text(),
      ),
    );
    const sourceDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sources.join(" ")),
    );
    expect(
      [...new Uint8Array(sourceDigest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    ).toBe(artifact.sourceHash);
  });

  test("declares every tool the module exports, and nothing it does not", () => {
    const seeded = DEPLOYMENT_PLUGIN_CATALOG_V1.find(
      (plugin) => plugin.pluginId === "email",
    )!;
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      seeded.descriptor.tools.map((tool) => tool.name).toSorted(),
    );
    expect(Object.keys(cards)).toEqual(
      seeded.descriptor.cards!.map((card) => card.id),
    );
    expect(Object.keys(cards.draft.actions ?? {})).toEqual(
      seeded.descriptor.cards![0]!.actions.map((action) => action.name),
    );
  });
});
