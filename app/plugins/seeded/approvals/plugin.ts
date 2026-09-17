import type {
  CardMessage,
  PluginCard,
  PluginExecute,
  PluginTool,
} from "@frockbot/applet-sdk/plugin";

/**
 * Approval cards: the face of a decision, and nothing else (ADR 0030 step 7).
 *
 * The decision itself is the kernel's. It is recorded from the `approval`
 * send on the Turn's own durable log, under the id the Bot chose, with its
 * expiry and its once-only settlement; `decideApproval` is what answers it.
 * This Plugin draws it. The `ApprovalActions` component carries an id the
 * kernel overwrites with the one it recorded, so a card can never point at a
 * decision nobody was asked for — which is why a locked first-party Plugin is
 * safe to draw trust chrome at all.
 */

export const tools: PluginTool[] = [];

const FROCK_CATALOG_ID = "https://frockbot.com/a2ui/catalogs/frock/v1.json";

function surface(surfaceId: string, components: unknown[]): CardMessage[] {
  return [
    {
      version: "v1.0",
      createSurface: { surfaceId, catalogId: FROCK_CATALOG_ID, components },
    },
  ];
}

/** What the pill says, and how loud it says it. */
const RISK = {
  low: { status: "Low risk", tone: "neutral" },
  medium: { status: "Medium risk", tone: "warning" },
  high: { status: "High risk", tone: "danger" },
} as const;

type Risk = keyof typeof RISK;

const decisionCard: PluginCard = {
  render({ surfaceId, data }) {
    const action = String(data.action ?? "");
    if (action.length === 0) {
      return { drop: true, reason: "an approval card needs an action" };
    }
    const risk = (
      typeof data.risk === "string" && data.risk in RISK ? data.risk : "low"
    ) as Risk;
    const rationale =
      typeof data.rationale === "string" && data.rationale.length > 0
        ? data.rationale
        : undefined;
    const children = ["header", ...(rationale ? ["why"] : []), "actions"];
    return surface(surfaceId, [
      { id: "root", component: "Column", children },
      {
        id: "header",
        component: "CardHeader",
        title: action,
        subtitle: "Needs your approval",
        status: RISK[risk].status,
        tone: RISK[risk].tone,
      },
      ...(rationale
        ? [{ id: "why", component: "Markdown", text: rationale }]
        : []),
      {
        id: "actions",
        component: "ApprovalActions",
        // Overwritten by the kernel with the decision it recorded for this
        // send. A Card never names the Approval it is read under.
        approvalId: "pending",
        approveLabel: "Approve",
        // "Deny" rather than the catalog's default "Decline": it is the word
        // the payload's own widget used, and the word the person knows.
        declineLabel: "Deny",
      },
    ]);
  },
};

export const cards = { decision: decisionCard };

export const execute: PluginExecute = (tool) => {
  throw new Error(`unknown tool ${tool}`);
};
