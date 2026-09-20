import type { RoutineEventEvidenceV1 } from "@frockbot/core/contracts";
import type { RoutineEventFixtureV1 } from "./routine-event.js";

function evidence(
  over: Partial<RoutineEventEvidenceV1> &
    Pick<RoutineEventEvidenceV1, "prompt" | "payload">,
): RoutineEventEvidenceV1 {
  return {
    eventId: over.eventId ?? "evt_1",
    fireId: over.fireId ?? "rf-inbox-connect-evt_1",
    routineName: over.routineName ?? "Inbox",
    prompt: over.prompt,
    triggerType: over.triggerType ?? "GMAIL_NEW_GMAIL_MESSAGE",
    payload: over.payload,
  };
}

const SHIPPING =
  "When a shipping confirmation arrives, file the tracking number.";
const INVOICE = "When an invoice arrives, extract the amount and due date.";

export const routineEventFixturesV1: readonly RoutineEventFixtureV1[] = [
  {
    name: "shipping-confirmation",
    intent: "A standalone shipping confirmation matches a shipping Routine.",
    evidence: evidence({
      routineName: "Shipping",
      prompt: SHIPPING,
      payload: {
        subject: "Your Amazon order has shipped",
        sender: "ship-confirm@amazon.com",
        snippet: "Track your package: TBA123456789.",
      },
    }),
    expected: { fit: "is_or_might_be" },
  },
  {
    name: "newsletter-vs-shipping",
    intent: "A newsletter is a clear miss for a shipping Routine.",
    evidence: evidence({
      routineName: "Shipping",
      prompt: SHIPPING,
      payload: {
        subject: "This week in design: 12 tools we love",
        sender: "hello@sidebar.io",
        snippet:
          "Unsubscribe at any time. Here's what the industry is reading.",
      },
    }),
    expected: { fit: "clearly_unrelated" },
  },
  {
    name: "invoice-arrives",
    intent: "A standalone invoice matches an invoice Routine.",
    evidence: evidence({
      routineName: "Invoices",
      prompt: INVOICE,
      payload: {
        subject: "Invoice 1842 from Acme",
        sender: "billing@acme.test",
        snippet: "Amount due $240.00 by 30 September.",
      },
    }),
    expected: { fit: "is_or_might_be" },
  },
  {
    name: "lunch-vs-invoice",
    intent: "A lunch invite is a clear miss for an invoice Routine.",
    evidence: evidence({
      routineName: "Invoices",
      prompt: INVOICE,
      payload: {
        subject: "Lunch tomorrow?",
        sender: "sam@friends.test",
        snippet: "Thai place at 12:30 if you're free.",
      },
    }),
    expected: { fit: "clearly_unrelated" },
  },
  {
    name: "short-yes-reply",
    intent:
      "A one-word reply is not a clear miss — the Gmail thread may hold the meaning.",
    evidence: evidence({
      routineName: "Shipping",
      prompt: SHIPPING,
      payload: {
        subject: "Re: your order",
        sender: "dana@example.com",
        snippet: "Yes.",
      },
    }),
    expected: { fit: "is_or_might_be" },
  },
  {
    name: "re-your-order",
    intent: "A Re: subject alone is not a clear miss.",
    evidence: evidence({
      routineName: "Shipping",
      prompt: SHIPPING,
      payload: {
        subject: "Re: your order",
        sender: "support@shop.test",
        snippet: "Thanks for getting back to us.",
      },
    }),
    expected: { fit: "is_or_might_be" },
  },
  {
    name: "empty-body",
    intent: "An empty-ish body is not a clear miss.",
    evidence: evidence({
      routineName: "Shipping",
      prompt: SHIPPING,
      payload: {
        subject: "Fwd: package",
        sender: "alex@home.test",
      },
    }),
    expected: { fit: "is_or_might_be" },
  },
];
