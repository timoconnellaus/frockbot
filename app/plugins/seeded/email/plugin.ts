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
 * The Bot drafts; the person edits and decides; the deployment sends. The
 * draft card is the whole of the Plugin's face — who it is to, what it says,
 * each of them a field the person can change, and one control that sends it
 * and one that discards it — and when it is sent the card settles into a
 * receipt rather than disappearing.
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

/**
 * What happened to one surface's mail. `edited` says the person changed the
 * draft before sending it, so the Bot is told that what left is theirs.
 * `unclear` is a send whose outcome nobody can vouch for: it may have
 * reached its recipients, so it is never sent again.
 */
type DraftState =
  | { status: "drafted"; draft: Draft; edited?: true }
  | {
      status: "sent";
      draft: Draft;
      messageId: string;
      at: string;
      edited?: true;
    }
  | { status: "unclear"; draft: Draft; reason: string; at: string }
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
 * kernel would refuse is refused here, when the card is drawn or edited,
 * rather than after a person has read it and pressed Send.
 */
const ADDRESS = /^[^\s@,<>]+@[^\s@,<>.]+(?:\.[^\s@,<>.]+)+$/;

/** The kernel's own bounds on one message (`ISOLATE_EMAIL_LIMITS_V1`). */
const LIMITS = { recipients: 16, address: 320, subject: 512, body: 64_000 };

/**
 * Why this draft could not be sent, or nothing. The card tool's schema holds
 * the Bot's values to the same bounds before `render` sees them; an edit
 * reaches `revise` with nothing in front of it, so both ask this.
 */
function draftProblem(draft: Draft): string | undefined {
  if (draft.to.length === 0) return "a draft needs at least one recipient";
  const recipients = [...draft.to, ...(draft.cc ?? [])];
  if (draft.to.length > LIMITS.recipients) {
    return `a draft is sent to at most ${LIMITS.recipients} people`;
  }
  if ((draft.cc ?? []).length > LIMITS.recipients) {
    return `a draft copies at most ${LIMITS.recipients} people`;
  }
  const malformed = recipients.find(
    (address) => address.length > LIMITS.address || !ADDRESS.test(address),
  );
  if (malformed !== undefined) {
    return `"${malformed}" is not an email address`;
  }
  if (draft.subject.length === 0) return "a draft needs a subject";
  if (draft.subject.length > LIMITS.subject) {
    return `a subject is at most ${LIMITS.subject} characters`;
  }
  if (/[\r\n]/.test(draft.subject)) return "a subject is one line";
  if (draft.body.trim().length === 0) return "a draft needs a message";
  if (draft.body.length > LIMITS.body) {
    return `a message is at most ${LIMITS.body} characters`;
  }
  return undefined;
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
 * The draft's fields as the card's data model holds them: one line of
 * addresses per header, because a text field edits text. The body is a field
 * only while it fits the Card's data-model budget beside the headers; a
 * longer one is shown whole and sent as the Bot wrote it.
 */
interface DraftFields {
  to: string;
  cc: string;
  subject: string;
  body?: string;
}

/** A Card's data model is at most 16,000 bytes; this leaves the headers room. */
const EDITABLE_FIELDS_BYTES = 15_000;

function fieldsOf(draft: Draft): DraftFields {
  const headers = {
    to: draft.to.join(", "),
    cc: (draft.cc ?? []).join(", "),
    subject: draft.subject,
  };
  const whole = { ...headers, body: draft.body };
  return new TextEncoder().encode(JSON.stringify(whole)).length <=
    EDITABLE_FIELDS_BYTES
    ? whole
    : headers;
}

/** Addresses as a person types them: commas, semicolons, spaces or lines. */
function addressList(value: unknown): string[] {
  return typeof value === "string"
    ? value.split(/[\s,;]+/).filter((address) => address.length > 0)
    : [];
}

/**
 * The draft the person's fields describe. Whatever the card did not offer as
 * a field — the thread it answers, a body too long to edit — is the draft it
 * was drawn with.
 */
function draftFromFields(
  fields: { [key: string]: unknown },
  drawn: Draft,
): Draft {
  const cc = addressList(fields.cc);
  return {
    to: addressList(fields.to),
    ...(cc.length > 0 ? { cc } : {}),
    subject: typeof fields.subject === "string" ? fields.subject.trim() : "",
    body: typeof fields.body === "string" ? fields.body : drawn.body,
    ...(drawn.inReplyTo === undefined ? {} : { inReplyTo: drawn.inReplyTo }),
  };
}

/** Whether two drafts are the same message. */
function sameDraft(left: Draft, right: Draft): boolean {
  const canonical = (draft: Draft) =>
    JSON.stringify([
      draft.to,
      draft.cc ?? [],
      draft.subject,
      draft.body,
      draft.inReplyTo ?? "",
    ]);
  return canonical(left) === canonical(right);
}

/**
 * The catalog every Frock card is drawn from:
 * `core/protocol-schemas/schema/frock-catalog.json`. The client registers
 * A2UI's standard components and the Frock family as one catalog under this
 * id, so naming it is naming both.
 */
const FROCK_CATALOG_ID = "https://frockbot.com/a2ui/catalogs/frock/v1.json";

function surface(
  surfaceId: string,
  components: unknown[],
  dataModel?: DraftFields,
): CardMessage[] {
  return [
    {
      version: "v1.0",
      createSurface: {
        surfaceId,
        catalogId: FROCK_CATALOG_ID,
        components,
        ...(dataModel === undefined
          ? {}
          : {
              dataModel,
              // The fields are bound into the data model, so the press has to
              // carry them back for the kernel to put an edit to `revise`.
              sendDataModel: true,
            }),
      },
    },
  ];
}

/** What the person is asked. The words the Approval is recorded with. */
function decisionFor(draft: Draft): PluginCardDecision {
  return {
    action: `Send an email to ${draft.to.join(", ")} — ${draft.subject}`,
    risk: "medium",
  };
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
  const fields = fieldsOf(draft);
  return {
    messages: surface(surfaceId, draftComponents(draft, fields), fields),
    covers: { ...draft },
    // What the person is actually asked. The catalog's ApprovalActions holds
    // an id and two labels, so the words the Approval is recorded with are
    // declared here, beside the values that decision covers.
    decision: decisionFor(draft),
  };
}

/** One header the person can change, bound to its field. */
function field(id: keyof DraftFields, label: string): unknown {
  return {
    id,
    component: "TextField",
    label,
    value: { path: `/${id}` },
    ...(id === "body" ? { variant: "longText" } : {}),
  };
}

function draftComponents(draft: Draft, fields: DraftFields): unknown[] {
  const editableBody = fields.body !== undefined;
  return [
    {
      id: "root",
      component: "Column",
      children: [
        "status",
        "to",
        "cc",
        "subject",
        ...(draft.inReplyTo ? ["thread"] : []),
        "body",
        "actions",
      ],
    },
    {
      id: "status",
      component: "StatusPill",
      label: "Ready to send",
      // The catalog's tone for a card waiting on the person.
      tone: "ready",
    },
    field("to", "To"),
    field("cc", "Cc"),
    field("subject", "Subject"),
    // The thread it answers is a fact about the draft, not a field: changing
    // it would send the reply into a conversation nobody chose.
    ...(draft.inReplyTo
      ? [
          {
            id: "thread",
            component: "KeyValueRows",
            rows: [{ label: "In reply to", value: draft.inReplyTo }],
          },
        ]
      : []),
    editableBody
      ? field("body", "Message")
      : {
          id: "body",
          component: "CollapsibleText",
          text: draft.body,
          collapsedLines: 6,
        },
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
  tone: "neutral" | "success" | "warning",
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
  if (state.status === "unclear") {
    return receiptComponents(
      state.draft.subject,
      "May have sent",
      "warning",
      `May have reached ${state.draft.to.join(", ")} — ${state.draft.subject}. It was not sent again.`,
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
   * The card, in whichever of its states this surface is in. A surface the
   * Plugin has already sent or discarded never draws the controls again,
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
    const problem = draftProblem(draft);
    if (problem !== undefined) {
      return { drop: true, reason: `${problem}, so nothing was drawn` };
    }
    await writeState(ctx, surfaceId, { status: "drafted", draft });
    return drawDraft(surfaceId, draft);
  },
  /**
   * The person changed the fields and pressed Send. The draft this surface
   * holds becomes what they left there — held to exactly the checks the
   * Bot's own draft was — and that is what the decision covers from now on,
   * so `email_send` sends their words and the kernel holds it to them. An
   * edit that could not be sent is refused before anything is decided, with
   * the reason the person reads on the card.
   */
  async revise({ surfaceId, dataModel }, ctx) {
    const existing = await readState(ctx, surfaceId);
    if (!existing) {
      return { drop: true, reason: `no draft is on card "${surfaceId}"` };
    }
    if (existing.status !== "drafted") {
      return { drop: true, reason: "this email has already been settled" };
    }
    const draft = draftFromFields(dataModel, existing.draft);
    const problem = draftProblem(draft);
    if (problem !== undefined) return { drop: true, reason: problem };
    const edited =
      existing.edited === true || !sameDraft(draft, existing.draft);
    await writeState(ctx, surfaceId, {
      status: "drafted",
      draft,
      ...(edited ? { edited: true as const } : {}),
    });
    return {
      covers: { ...draft },
      decision: decisionFor(draft),
      // The card now holds what the decision covers, spelled the way the
      // fields spell it, so every device reads the message that was approved.
      messages: [
        {
          version: "v1.0",
          updateDataModel: { surfaceId, value: fieldsOf(draft) },
        },
      ],
    };
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
  const settle =
    "Draw the card again with email_draft, the same surfaceId and the same values to settle it into a receipt.";
  if (tool === "email_discard") {
    if (state.status === "sent") {
      throw new Error("that email has already been sent");
    }
    if (state.status === "unclear") {
      throw new Error("that email may already have been sent");
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
  if (state.status === "unclear") {
    return `Whether it reached ${state.draft.to.join(", ")} is not known, so it was not sent again. Tell the person it may have arrived.`;
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
  if (outcome.status === "unknown") {
    // It may have left, so it is written as if it did: a second email_send
    // on this surface answers rather than delivering the mail twice.
    await writeState(ctx, surfaceId, {
      status: "unclear",
      draft: state.draft,
      reason: outcome.reason,
      at: new Date().toISOString(),
    });
    return `The send's outcome is unknown (${outcome.reason}). It may have reached ${state.draft.to.join(", ")}; do not send it again, tell the person instead. ${settle}`;
  }
  if (outcome.status !== "sent") {
    throw new Error(outcome.reason);
  }
  await writeState(ctx, surfaceId, {
    status: "sent",
    draft: state.draft,
    messageId: outcome.messageId,
    at: new Date().toISOString(),
    ...(state.edited ? { edited: true as const } : {}),
  });
  const theirs = state.edited
    ? " The person edited the draft before sending it: what left is their version, not yours."
    : "";
  return `Sent to ${state.draft.to.join(", ")} — ${state.draft.subject}.${theirs} ${settle}`;
};
