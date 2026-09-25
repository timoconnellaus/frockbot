// Whether a Bot may type a saved secret into the page in front of it, and the
// value for that one action.
//
// Two classes, one rule each (item 12's groundwork):
//
//   * A payment detail — a card number, a security code, bank details, by
//     what the person saved or by the field it is going into — is filled only
//     under a fresh Approval of this page's origin, this field and this
//     secret, used once.
//   * Anything else is filled without asking on the one site it was saved
//     for, and under the same kind of Approval anywhere else.
//
// The Approval is the machine command's pattern: an intent recorded before
// the card exists, an approval send on the Turn's own log, the Turn over.
// What the person approved is the intent, never what the Bot says later, so
// an approved fill cannot be moved to another page or another field. The
// host is told the one origin the page must be on when the value is typed,
// and refuses otherwise; the value itself is leased for that one action,
// opened here, and settled whatever became of it.

import type { BotIdentity } from "@frockbot/core/durable";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  decodeSendToUserPayloadV1,
  SECRET_FILL_APPROVAL_ID_PREFIX_V1,
} from "@frockbot/core/contracts";
import type { ComputerSecretFillSeamV1 } from "@frockbot/computer/agent";
import { CredentialLeaseRuntime } from "@frockbot/app/credentials/user";
import {
  approvalKeyV1,
  decodeApprovalRecordV1,
} from "@frockbot/app/shell/approvals";
import { recordSendToUserV1 } from "@frockbot/app/shell/agent";
import {
  decodeSecretFillIntentV1,
  isSecretIdV1,
  paymentFieldV1,
  SECRET_FILL_APPROVAL_SECONDS_V1,
  SECRETS_PACKAGE_ID_V1,
  secretFillIntentKeyV1,
  secretFillUseKeyV1,
  type SecretFillIntentV1,
} from "./shared.js";
import type { UserSecretsRpcV1 } from "./bot.js";

export interface BotSecretFillStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(
    run: (transaction: {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: unknown): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
}

/** The fill Approval one durable occurrence maps to. */
export async function secretFillApprovalIdV1(
  botId: string,
  runId: string,
  effectId: string,
): Promise<string> {
  const digest = await sha256HexTextV1(
    `${botId}\u0000${runId}\u0000${effectId}`,
  );
  return `${SECRET_FILL_APPROVAL_ID_PREFIX_V1}${digest.slice(0, 32)}`;
}

/** The lease a fill takes, keyed apart from every Connection's leases. */
function leaseEffectIdV1(effectId: string): string {
  return `secret-fill:${effectId}`;
}

export function createBotSecretFillSeamV1(host: {
  identity: BotIdentity;
  /** The admitted Turn, which a fill Approval's intent names. */
  runId: string;
  storage: BotSecretFillStorageV1;
  vault: UserSecretsRpcV1;
  readSecret(name: "CREDENTIAL_KEYRING"): string | undefined;
  now?: () => number;
}): ComputerSecretFillSeamV1 {
  const now = host.now ?? Date.now;
  return {
    async authorize(request) {
      const refused = (content: string) => ({
        status: "refused" as const,
        content,
      });
      if (!isSecretIdV1(request.secretId)) {
        return refused(
          `"${request.secretId}" is not a saved secret's reference. Saved secrets look like "secret-" and 32 letters and digits; ask the user for one with send_to_user type "secret-request".`,
        );
      }
      const secret = await host.vault.describe(request.secretId);
      if (!secret) {
        return refused(
          `The user holds no saved secret "${request.secretId}" — it may have been deleted. Ask for it again with send_to_user type "secret-request".`,
        );
      }
      const payment = secret.payment || paymentFieldV1(request.field);
      if (request.approvalId !== undefined) {
        const intentValue = await host.storage.get<unknown>(
          secretFillIntentKeyV1(request.approvalId),
        );
        if (intentValue === undefined) {
          return refused(
            `"${request.approvalId}" is not an approval to fill a saved secret. Leave approval out, and the fill asks for one if it needs it.`,
          );
        }
        const intent = decodeSecretFillIntentV1(intentValue);
        if (
          intent.secretId !== request.secretId ||
          intent.field !== request.field
        ) {
          return refused(
            `That approval covers filling "${intent.field}" with the saved secret ${intent.secretId} on ${intent.origin}, and nothing else. Ask again for this fill by leaving approval out.`,
          );
        }
        const recordValue = await host.storage.get<unknown>(
          approvalKeyV1(request.approvalId),
        );
        if (recordValue === undefined) {
          return refused(
            "The user has not been asked about that fill yet. End your Turn and wait for their answer.",
          );
        }
        const approval = decodeApprovalRecordV1(recordValue);
        if (approval.decision === "pending") {
          return refused(
            "The user has not answered that approval yet. Wait for their answer.",
          );
        }
        if (approval.decision === "denied") {
          return refused(
            "The user denied that fill. Do not fill it, and do not ask again unless they bring it up.",
          );
        }
        const decidedAt = Date.parse(approval.decidedAt ?? "");
        if (
          approval.decision !== "approved" ||
          !Number.isFinite(decidedAt) ||
          now() - decidedAt > SECRET_FILL_APPROVAL_SECONDS_V1 * 1_000
        ) {
          return refused(
            "That approval is no longer fresh. Ask again by repeating the fill without approval.",
          );
        }
        // Spent before anything is typed: an approval releases one fill, and
        // a fill whose outcome was lost costs the person another approval
        // rather than typing a card number twice.
        const claimed = await host.storage.transaction(async (transaction) => {
          const used = secretFillUseKeyV1(request.approvalId!);
          if ((await transaction.get<unknown>(used)) !== undefined) {
            return false;
          }
          await transaction.put(used, new Date(now()).toISOString());
          return true;
        });
        if (!claimed) {
          return refused(
            "That approval was already used for one fill. Ask again by repeating the fill without approval.",
          );
        }
        return {
          status: "granted",
          origin: intent.origin,
          label: secret.label,
        };
      }
      if (!payment && secret.origin !== undefined) {
        return {
          status: "granted",
          origin: secret.origin,
          label: secret.label,
        };
      }
      // A person has to approve this fill, and only a conversation can ask.
      if (request.context.turnType !== "chat") {
        return refused(
          payment
            ? `"${secret.label}" is a payment detail, and filling it needs the user's approval, which can only be asked in your conversation with them.`
            : `"${secret.label}" names no site, so filling it needs the user's approval, which can only be asked in your conversation with them.`,
        );
      }
      const origin = await request.pageOrigin();
      if (origin === undefined) {
        return refused(
          "Open the page with the field first: the approval names the site the page is on.",
        );
      }
      const approvalId = await secretFillApprovalIdV1(
        host.identity.botId,
        host.runId,
        request.context.effectId,
      );
      const intent: SecretFillIntentV1 = {
        schemaVersion: 1,
        approvalId,
        secretId: secret.secretId,
        field: request.field,
        origin,
        runId: host.runId,
        createdAt: new Date(now()).toISOString(),
      };
      // Intent first, and durable before anybody is asked.
      await host.storage.put(secretFillIntentKeyV1(approvalId), intent);
      const payload = decodeSendToUserPayloadV1(
        {
          type: "approval",
          approvalId,
          action: `Fill your saved “${secret.label}” into “${request.field}” on ${origin}`,
          rationale: payment
            ? "It is a payment detail, so your Bot asks before every use. It types it into that field on that site only, without the value being put in the conversation."
            : secret.origin === undefined
              ? "It was saved without a site, so your Bot asks before each use. It types it into that field on that site only, without the value being put in the conversation."
              : `It was saved for ${secret.origin}, and this page is on another site. Your Bot types it into that field on that site only, without the value being put in the conversation.`,
          risk: payment ? "high" : "medium",
          expiresInSeconds: SECRET_FILL_APPROVAL_SECONDS_V1,
        },
        "secret fill approval",
        // Minted a few lines above; the prefix is refused to every author.
        { kernelMinted: true },
      );
      const recorded = await recordSendToUserV1(
        request.runtime.sessions,
        payload,
        {
          sessionId: request.context.sessionId,
          occurrenceId: request.context.effectId,
          tool: "computer_browser",
          ...(request.runtime.firstPartyCards === undefined
            ? {}
            : { cards: request.runtime.firstPartyCards }),
          context: request.context,
        },
      );
      if (recorded.status !== "sent") {
        return refused(`The approval could not be asked: ${recorded.reason}`);
      }
      return {
        status: "asked",
        content: [
          `Approval requested to fill "${request.field}" with the saved secret "${secret.label}" on ${origin}. Nothing has been typed.`,
          `When the user approves, repeat the fill on the same page with {"action":"fill","label":"${request.field}","secret":"${secret.secretId}","approval":"${approvalId}"}.`,
          "This Turn is over.",
        ].join(" "),
      };
    },
    async open(request) {
      const lease = await host.vault.lease(
        request.secretId,
        leaseEffectIdV1(request.effectId),
      );
      if (lease.connectionId !== request.secretId) {
        throw new Error("The saved secret's lease is invalid");
      }
      return new CredentialLeaseRuntime({
        readSecret: host.readSecret,
      }).open({
        accountId: host.identity.userId,
        connectionId: request.secretId,
        packageId: SECRETS_PACKAGE_ID_V1,
        lease,
      });
    },
    async release(request) {
      await host.vault.settle(
        request.secretId,
        leaseEffectIdV1(request.effectId),
      );
    },
  };
}
