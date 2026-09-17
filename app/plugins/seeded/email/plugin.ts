import type {
  CardMessage,
  PluginCard,
  PluginContext,
  PluginExecute,
  PluginTool,
} from "@frockbot/applet-sdk/plugin";

/**
 * Email: the first seeded Plugin, and the first Card (ADR 0030).
 *
 * The Bot drafts; the person decides; the deployment sends. The draft card is
 * the whole of the Plugin's face — who it is to, what it says, and one
 * control that sends it and one that discards it — and when it is sent the
 * card settles into a receipt rather than disappearing.
 *
 * Two things are deliberately not here. The Plugin never sends by itself: the
 * approval the card asks for is the kernel's, and the tool that sends is
 * called on the Turn after the person decided. And the Plugin holds no
 * credential: `ctx.email` is the deployment's own sender, reached through the
 * kernel and attributed to the Bot that asked.
 */

export const tools: PluginTool[] = [
  {
    name: "email_send",
    description:
      "Send the email a draft card is showing, after the person approved it. Takes the card's surfaceId. Draw the card again with the same surfaceId afterwards to settle it into a receipt.",
    inputSchema: {
      type: "object",
      properties: {
        surfaceId: {
          type: "string",
          description: "The draft card's surface, as email_draft returned it.",
        },
      },
      required: ["surfaceId"],
    },
  },
  {
    name: "email_discard",
    description:
      "Discard the email a draft card is showing, after the person declined it. Takes the card's surfaceId. Draw the card again with the same surfaceId afterwards to settle it into a discarded receipt.",
    inputSchema: {
      type: "object",
      properties: {
        surfaceId: { type: "string", description: "The draft card's surface." },
      },
      required: ["surfaceId"],
    },
  },
];

interface Draft {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
}

type DraftState =
  | { status: "drafted"; draft: Draft }
  | { status: "sent"; draft: Draft; messageId: string; at: string }
  | { status: "discarded"; draft: Draft; at: string };

/** One surface's state. Keyed by the surface, because the card is the state. */
function stateKey(surfaceId: string): string {
  return `card:${surfaceId}`;
}

async function readState(
  ctx: PluginContext,
  surfaceId: string,
): Promise<DraftState | undefined> {
  const storage = ctx.storage;
  if (!storage) throw new Error("the storage grant is not open");
  const stored = await storage.get({ key: stateKey(surfaceId) });
  if (stored.status !== "available" || !stored.value) return undefined;
  return stored.value as DraftState;
}

async function writeState(
  ctx: PluginContext,
  surfaceId: string,
  state: DraftState,
): Promise<void> {
  const storage = ctx.storage;
  if (!storage) throw new Error("the storage grant is not open");
  await storage.put({ key: stateKey(surfaceId), value: state });
}

function readDraft(data: { [key: string]: unknown }): Draft {
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((entry) => String(entry)) : [];
  const cc = list(data.cc);
  return {
    to: list(data.to),
    ...(cc.length > 0 ? { cc } : {}),
    subject: String(data.subject ?? ""),
    body: String(data.body ?? ""),
    ...(typeof data.inReplyTo === "string" && data.inReplyTo.length > 0
      ? { inReplyTo: data.inReplyTo }
      : {}),
  };
}

function surface(surfaceId: string, components: unknown[]): CardMessage[] {
  return [
    {
      version: "v1.0",
      createSurface: { surfaceId, components },
    },
  ];
}

/** The rows a person reads before deciding: who, and about what. */
function addressRows(draft: Draft, full: boolean): unknown {
  const rows: { label: string; value: string }[] = [
    { label: "To", value: draft.to.join(", ") },
  ];
  if (draft.cc && draft.cc.length > 0) {
    rows.push({ label: "Cc", value: draft.cc.join(", ") });
  }
  rows.push({ label: "Subject", value: draft.subject });
  if (full && draft.inReplyTo) {
    rows.push({ label: "In reply to", value: draft.inReplyTo });
  }
  return { id: "rows", component: "KeyValueRows", rows };
}

/**
 * The two components a "More details" press changes, and only those: a press
 * redraws what it was about, never the ApprovalActions, whose approvalId the
 * kernel bound when the card was sent and which the Plugin cannot mint again.
 */
function detailComponents(draft: Draft, full: boolean): unknown[] {
  return [
    addressRows(draft, full),
    {
      id: "more",
      component: "Button",
      label: full ? "Fewer details" : "More details",
      // A press the kernel routes to this Plugin's own handler, which answers
      // with the rows again. Costs no Turn, which is the point of the route.
      action: { name: `plugin/email/details`, context: { full: !full } },
    },
  ];
}

function draftComponents(draft: Draft, full: boolean): unknown[] {
  const [rows, more] = detailComponents(draft, full);
  return [
    {
      id: "root",
      component: "Column",
      children: ["status", "rows", "body", "more", "actions"],
    },
    {
      id: "status",
      component: "StatusPill",
      label: "Ready to send",
      tone: "pending",
    },
    rows,
    {
      id: "body",
      component: "CollapsibleText",
      text: draft.body,
      collapsedLines: 6,
    },
    more,
    {
      id: "actions",
      component: "ApprovalActions",
      // Overwritten by the kernel with the Approval it records for this card:
      // a Card never mints the id its own decision is read under.
      approvalId: "pending",
      approveLabel: "Send",
      declineLabel: "Discard",
      action: `Send an email to ${draft.to.join(", ")} — ${draft.subject}`,
      risk: "medium",
    },
  ];
}

function receiptComponents(
  title: string,
  status: { label: string; tone: string },
  summary: string,
): unknown[] {
  return [
    { id: "root", component: "Column", children: ["receipt"] },
    { id: "receipt", component: "Receipt", title, status, summary },
  ];
}

function settledComponents(state: DraftState): unknown[] | undefined {
  if (state.status === "sent") {
    return receiptComponents(
      state.draft.subject,
      { label: "Sent", tone: "positive" },
      `Sent to ${state.draft.to.join(", ")} — ${state.draft.subject}`,
    );
  }
  if (state.status === "discarded") {
    return receiptComponents(
      state.draft.subject,
      { label: "Discarded", tone: "muted" },
      `Discarded — ${state.draft.subject}`,
    );
  }
  return undefined;
}

const draftCard: PluginCard = {
  /**
   * The card, in whichever of its three states this surface is in. A surface
   * the Plugin has already sent or discarded never draws the controls again,
   * however the Bot calls the tool: what happened to the mail is the
   * Plugin's own record, not a value the model can rewrite.
   */
  async render({ surfaceId, data }, ctx) {
    const existing = await readState(ctx, surfaceId);
    const settled = existing && settledComponents(existing);
    if (settled) return surface(surfaceId, settled);
    const draft = readDraft(data);
    if (draft.to.length === 0) {
      return { drop: true, reason: "a draft needs at least one recipient" };
    }
    await writeState(ctx, surfaceId, { status: "drafted", draft });
    return surface(surfaceId, draftComponents(draft, false));
  },
  actions: {
    /** "More details": the same card, with the rest of the headers on it. */
    async details({ surfaceId, context }, ctx) {
      const state = await readState(ctx, surfaceId);
      if (!state || state.status !== "drafted") {
        return { drop: true, reason: "this draft has already settled" };
      }
      const full = context?.full === true;
      return [
        {
          version: "v1.0",
          updateComponents: {
            surfaceId,
            components: detailComponents(state.draft, full),
          },
        },
      ];
    },
  },
};

export const cards = { draft: draftCard };

/**
 * A string answer goes to the Bot as it is; throwing answers with an error it
 * can read. Sending is idempotent per surface: a Turn that retries after a
 * timeout must not send the same mail twice.
 */
export const execute: PluginExecute = async (tool, input, ctx) => {
  const surfaceId = String(
    (input as { surfaceId?: unknown } | null)?.surfaceId ?? "",
  );
  if (surfaceId.length === 0) throw new Error("surfaceId is required");
  const state = await readState(ctx, surfaceId);
  if (!state) throw new Error(`no draft is on card "${surfaceId}"`);
  if (tool === "email_discard") {
    if (state.status === "sent") {
      throw new Error("that email has already been sent");
    }
    await writeState(ctx, surfaceId, {
      status: "discarded",
      draft: state.draft,
      at: new Date().toISOString(),
    });
    return `Discarded. Draw the card again with email_draft, the same surfaceId and the same values to settle it.`;
  }
  if (tool !== "email_send") throw new Error(`unknown tool ${tool}`);
  if (state.status === "sent") {
    return `Already sent to ${state.draft.to.join(", ")}. Nothing was sent twice.`;
  }
  if (state.status === "discarded") {
    throw new Error("that draft was discarded");
  }
  const send = ctx.email;
  if (!send) throw new Error("the http grant is not open");
  const outcome = await send(state.draft);
  if (outcome.status !== "sent") {
    throw new Error(outcome.reason);
  }
  await writeState(ctx, surfaceId, {
    status: "sent",
    draft: state.draft,
    messageId: outcome.messageId,
    at: new Date().toISOString(),
  });
  return `Sent to ${state.draft.to.join(", ")} — ${state.draft.subject}. Draw the card again with email_draft, the same surfaceId and the same values to settle it into a receipt.`;
};
