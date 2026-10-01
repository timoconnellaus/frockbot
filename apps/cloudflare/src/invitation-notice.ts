import type { EmailSenderV1 } from "@frockbot/app/email/sender";
import { invitationNoticeMessageV1 } from "@frockbot/app/admin/waitlist";

/**
 * The local part invitations are sent from. Reserved as an email username,
 * and a Bot's address always carries a dot, so no Bot can hold it.
 */
export const INVITATION_SENDER_LOCAL_PART_V1 = "frockbot";

export interface InvitationNoticeAuthorityV1 {
  claimInvitationNotice(input: unknown): Promise<unknown>;
  recordInvitationNotice(input: unknown): Promise<unknown>;
}

function claimed(answer: unknown): boolean {
  return (
    typeof answer === "object" &&
    answer !== null &&
    (answer as { claimed?: unknown }).claimed === true
  );
}

/**
 * Sends an invitation's "you're in" email once: the authority's claim is the
 * idempotency key, taken before the send and never released. A deployment
 * with no sender or no origin claims nothing, so the invitation still works
 * by signing in and nothing is marked as sent.
 */
export function createInvitationNoticeSenderV1(options: {
  authority: () => InvitationNoticeAuthorityV1;
  sender: EmailSenderV1 | undefined;
  origin: string | undefined;
  productName: string;
  senderName: string;
}): (email: string) => Promise<void> {
  return async (email) => {
    const { sender, origin } = options;
    if (!sender || !origin) return;
    const authority = options.authority();
    if (
      !claimed(
        await authority.claimInvitationNotice({ schemaVersion: 1, email }),
      )
    ) {
      return;
    }
    const message = invitationNoticeMessageV1({
      productName: options.productName,
      origin,
      email,
    });
    const outcome = await sender.send({
      from: {
        address: `${INVITATION_SENDER_LOCAL_PART_V1}@${sender.domain}`,
        name: options.senderName,
      },
      to: [email],
      subject: message.subject,
      body: message.body,
    });
    await authority.recordInvitationNotice({
      schemaVersion: 1,
      email,
      status: outcome.status,
      ...(outcome.status === "sent"
        ? {}
        : { detail: outcome.reason.slice(0, 1000) }),
    });
  };
}
