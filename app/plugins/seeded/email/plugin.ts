import type {
  CardMessage,
  PluginCard,
  PluginCardDecision,
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
      "Send the email a draft card is showing, after the person approved it. Takes the card's surfaceId and the approvalId the decision line named. Draw the card again with the same surfaceId afterwards to settle it into a receipt.",
    inputSchema: {
      type: "object",
      properties: {
        surfaceId: {
          type: "string",
          description: "The draft card's surface, as email_draft returned it.",
        },
        approvalId: {
          type: "string",
          description:
            'The id the approval decision line carried: [Approval] The decision on "<approvalId>" is approved.',
        },
      },
      required: ["surfaceId", "approvalId"],
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

/**
 * A mailbox, as loosely as one may be written and still be one. The same
 * shape the kernel's own email request holds addresses to: an address the
 * kernel would refuse is refused here, when the card is drawn, rather than
 * after a person has read it and pressed Send.
 */
const ADDRESS = /^[^\s@,<>]+@[^\s@,<>.]+(?:\.[^\s@,<>.]+)+$/;

function malformedAddress(draft: Draft): string | undefined {
  return [...draft.to, ...(draft.cc ?? [])].find(
    (address) => !ADDRESS.test(address),
  );
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

/**
 * The catalog every Frock card is drawn from:
 * `core/protocol-schemas/schema/frock-catalog.json`. The client registers
 * A2UI's standard components and the Frock family as one catalog under this
 * id, so naming it is naming both.
 */
const FROCK_CATALOG_ID = "https://frockbot.com/a2ui/catalogs/frock/v1.json";

function surface(surfaceId: string, components: unknown[]): CardMessage[] {
  return [
    {
      version: "v1.0",
      createSurface: { surfaceId, catalogId: FROCK_CATALOG_ID, components },
    },
  ];
}

/**
 * The draft card, and what a decision on it authorizes. `covers` is the draft
 * this surface is holding — exactly what the card draws and exactly what
 * `email_send` will hand to `ctx.email` — so the Approval the kernel binds is
 * about the message the person read rather than about whatever values the
 * model last passed to the tool.
 */
function drawDraft(
  surfaceId: string,
  draft: Draft,
): {
  messages: CardMessage[];
  covers: { [key: string]: unknown };
  decision: PluginCardDecision;
} {
  return {
    messages: surface(surfaceId, draftComponents(draft, false)),
    covers: { ...draft },
    // What the person is actually asked. The catalog's ApprovalActions holds
    // an id and two labels, so the words the Approval is recorded with are
    // declared here, beside the values that decision covers.
    decision: {
      action: `Send an email to ${draft.to.join(", ")} — ${draft.subject}`,
      risk: "medium",
    },
  };
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
 * The components a "More details" press changes, and only those: a press
 * redraws what it was about, never the ApprovalActions, whose approvalId the
 * kernel bound when the card was sent and which the Plugin cannot mint again.
 * The catalog's Button carries no label of its own — it names a child — so
 * the word on it is a Text the press redraws beside the rows.
 */
function detailComponents(draft: Draft, full: boolean): unknown[] {
  return [
    addressRows(draft, full),
    {
      id: "more-label",
      component: "Text",
      text: full ? "Fewer details" : "More details",
    },
    {
      id: "more",
      component: "Button",
      child: "more-label",
      variant: "borderless",
      // A press the kernel routes to this Plugin's own handler, which answers
      // with the rows again. Costs no Turn, which is the point of the route.
      action: { name: `plugin/email/details`, context: { full: !full } },
    },
  ];
}

function draftComponents(draft: Draft, full: boolean): unknown[] {
  const [rows, moreLabel, more] = detailComponents(draft, full);
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
      // The catalog's tone for a card waiting on the person.
      tone: "ready",
    },
    rows,
    {
      id: "body",
      component: "CollapsibleText",
      text: draft.body,
      collapsedLines: 6,
    },
    moreLabel,
    more,
    {
      id: "actions",
      component: "ApprovalActions",
      // Overwritten by the kernel with the Approval it records for this card:
      // a Card never mints the id its own decision is read under.
      approvalId: "pending",
      approveLabel: "Send",
      declineLabel: "Discard",
    },
  ];
}

function receiptComponents(
  title: string,
  status: string,
  tone: "neutral" | "success",
  summary: string,
): unknown[] {
  return [
    { id: "root", component: "Column", children: ["receipt"] },
    { id: "receipt", component: "Receipt", title, status, tone, summary },
  ];
}

function settledComponents(state: DraftState): unknown[] | undefined {
  if (state.status === "sent") {
    return receiptComponents(
      state.draft.subject,
      "Sent",
      "success",
      `Sent to ${state.draft.to.join(", ")} — ${state.draft.subject}`,
    );
  }
  if (state.status === "discarded") {
    return receiptComponents(
      state.draft.subject,
      "Discarded",
      "neutral",
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
    // A surface that already holds a draft is redrawn from what it holds,
    // never from new values. The card asked for a decision when it was first
    // drawn, and a redraw that changed the recipients would change what that
    // pending decision covers; a different email is a different card, which
    // the Bot gets by calling email_draft with no surfaceId.
    if (existing) {
      return drawDraft(surfaceId, existing.draft);
    }
    const draft = readDraft(data);
    if (draft.to.length === 0) {
      return { drop: true, reason: "a draft needs at least one recipient" };
    }
    const malformed = malformedAddress(draft);
    if (malformed !== undefined) {
      return {
        drop: true,
        reason: `"${malformed}" is not an email address, so nothing was drawn`,
      };
    }
    await writeState(ctx, surfaceId, { status: "drafted", draft });
    return drawDraft(surfaceId, draft);
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
  const args = input as {
    surfaceId?: unknown;
    approvalId?: unknown;
  } | null;
  const surfaceId = String(args?.surfaceId ?? "");
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
  const approvalId = String(args?.approvalId ?? "");
  if (approvalId.length === 0) {
    throw new Error(
      'approvalId is required: pass the id the decision line named, as in [Approval] The decision on "<approvalId>" is approved.',
    );
  }
  const send = ctx.email;
  if (!send) throw new Error("the http grant is not open");
  const outcome = await send({ ...state.draft, approvalId, surfaceId });
  if (outcome.status !== "sent") {
    throw new Error(outcome.reason);
  }
  // Written the moment anything left. A partial send is still a send, and a
  // second email_send on this surface answers "already sent" rather than
  // delivering the mail again to whoever did receive it.
  await writeState(ctx, surfaceId, {
    status: "sent",
    draft: state.draft,
    messageId: outcome.messageId,
    at: new Date().toISOString(),
  });
  const undelivered = outcome.undelivered ?? [];
  const missed =
    undelivered.length === 0
      ? ""
      : ` It did not reach ${undelivered.join(", ")}; do not send it again, tell the person instead.`;
  return `Sent to ${state.draft.to.join(", ")} — ${state.draft.subject}.${missed} Draw the card again with email_draft, the same surfaceId and the same values to settle it into a receipt.`;
};
