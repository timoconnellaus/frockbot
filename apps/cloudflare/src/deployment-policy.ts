import {
  decodeAccountAccessReadRequestV1,
  decodeAccountAccessV1,
  decodeAccountDeletionAccessRequestV1,
  decodeAdmissionIdentityV1,
  decodeDeploymentPolicyReadRequestV1,
  decodeDeploymentPolicyV1,
  decodeEmailInvitationV1,
  decodeIdentityCreationRequestV1,
  decodeInviteEmailRequestV1,
  decodeSetAccountAccessRequestV1,
  decodeSetAdmissionModeRequestV1,
  type AccountAccessV1,
  type AccountAccessViewV1,
  type AccountAdmissionDecisionV1,
  type AdmissionIdentityV1,
  type DeploymentPolicyV1,
  type EmailInvitationV1,
} from "@frockbot/app/admin/shared";
import {
  forgetInboundEmailUserV1,
  registerInboundAddressV1,
  releaseInboundAddressV1,
  resolveInboundAddressV1,
} from "@frockbot/app/email/directory";
import { DurableObject } from "cloudflare:workers";
import {
  evaluateAdmissionV1,
  identityMayBeCreatedV1,
} from "./account-admission.js";
import {
  decodeModelRatesReadRequestV1,
  type HostedModelRatesV1,
  type HostedModelRatesViewV1,
} from "@frockbot/app/billing/rates";
import {
  currentHostedModelRatesV1,
  hostedModelRatesViewV1,
  reportUnpricedServedModelV1,
  saveHostedModelRatesV1,
  seedHostedModelRatesStorageV1,
  type ModelRatesWriteV1,
} from "./model-rates.js";
import {
  decodeRpcEnvelopeV1,
  rpcBotId,
  rpcIdentifier,
  rpcPattern,
} from "./durable-rpc.js";

const POLICY_KEY = "deployment:admission:v1";
const ACCESS_PREFIX = "account:access:v1:";
const INVITATION_PREFIX = "invitation:email:v1:";
export const DEPLOYMENT_POLICY_SINGLETON_NAME = "frockbot-deployment-policy";

/** A SHA-256 digest, as the inbound email directory keys a Bot's token. */
const INBOUND_EMAIL_DIGEST = rpcPattern(/^[0-9a-f]{64}$/, 64);

/** Written by admission itself, so an audit can tell a sign-in from an admin. */
export const ADMISSION_UPDATED_BY = "admission";
/** Written when the account's own deletion ends its access. */
export const DELETION_UPDATED_BY = "account-deletion";

/** The signups-switch record this authority replaced; see `cleanRetiredDeploymentPolicyV1`. */
export const RETIRED_SIGNUPS_POLICY_KEY = "deployment:policy:v1";
export const RETIRED_SIGNUPS_POLICY_RECEIPT_KEY =
  "maintenance:retired-signups-policy:2026-09-14";

/**
 * Deletes the retired signups-switch record, which nothing decodes any more.
 *
 * Scoped to that one key, so accounts, invitations and the admission policy
 * are untouched, and repeatable: it runs whenever the object starts, and a
 * second run finds the receipt and does nothing. It carries no value forward
 * — a deployment whose signups were open starts `closed`, the fail-safe mode,
 * until an admin chooses one.
 */
export function cleanRetiredDeploymentPolicyV1(
  storage: DurableObjectStorage,
): void {
  storage.transactionSync(() => {
    if (storage.kv.get(RETIRED_SIGNUPS_POLICY_RECEIPT_KEY) !== undefined) {
      return;
    }
    const present = storage.kv.get(RETIRED_SIGNUPS_POLICY_KEY) !== undefined;
    storage.kv.delete(RETIRED_SIGNUPS_POLICY_KEY);
    storage.kv.put(RETIRED_SIGNUPS_POLICY_RECEIPT_KEY, {
      at: new Date().toISOString(),
      deleted: present ? 1 : 0,
    });
  });
}

/**
 * A compare-and-swap answered as a value. A thrown error's class does not
 * survive the Durable Object RPC boundary, and a lost race is an ordinary
 * answer, not a failure.
 */
export type RevisionedWriteV1<T> =
  | { status: "applied"; value: T }
  | { status: "conflict"; currentRevision: number };

function defaultPolicy(): DeploymentPolicyV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    admission: { mode: "closed" },
    updatedAt: new Date().toISOString(),
    updatedBy: "deployment-default",
  };
}

function nextRevision(current: number, label: string): number {
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} revision is exhausted`);
  }
  return current + 1;
}

/**
 * The deployment's beta-access authority: the admission mode, each account's
 * access record and the email invitations not yet redeemed. It also holds the
 * versioned hosted model rate table (`./model-rates.ts`), which is equally
 * deployment-wide and equally an administrator's to change, and the inbound
 * email directory (`app/email/directory.ts`), because a message names only
 * its recipient's token, and something the whole deployment shares has to say
 * whose it is before any User's object may be addressed.
 *
 * One object, and every read-decide-write in it is a synchronous storage
 * transaction, so two sign-ins, or a sign-in racing an admin, are serialized
 * here rather than reconciled later. That is what stops a sign-in that read
 * `invited` from writing `active` over a pause that landed in between.
 */
export class DeploymentPolicy extends DurableObject<Record<string, never>> {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      cleanRetiredDeploymentPolicyV1(ctx.storage);
      seedHostedModelRatesStorageV1(ctx.storage);
    });
  }

  private get kv() {
    return this.ctx.storage.kv;
  }

  private policy(): DeploymentPolicyV1 {
    const stored = this.kv.get<unknown>(POLICY_KEY);
    return stored === undefined
      ? defaultPolicy()
      : decodeDeploymentPolicyV1(stored);
  }

  private access(userId: string): AccountAccessV1 | null {
    const stored = this.kv.get<unknown>(ACCESS_PREFIX + userId);
    if (stored === undefined) return null;
    const access = decodeAccountAccessV1(stored);
    if (access.userId !== userId) {
      throw new Error("stored account access names another account");
    }
    return access;
  }

  private invitation(email: string | undefined): EmailInvitationV1 | null {
    if (email === undefined) return null;
    const stored = this.kv.get<unknown>(INVITATION_PREFIX + email);
    return stored === undefined ? null : decodeEmailInvitationV1(stored);
  }

  async readPolicy(input: unknown): Promise<DeploymentPolicyV1> {
    decodeDeploymentPolicyReadRequestV1(input);
    return this.policy();
  }

  async setAdmissionMode(
    input: unknown,
  ): Promise<RevisionedWriteV1<DeploymentPolicyV1>> {
    const request = decodeSetAdmissionModeRequestV1(input);
    return this.ctx.storage.transactionSync<
      RevisionedWriteV1<DeploymentPolicyV1>
    >(() => {
      const current = this.policy();
      if (request.command.revision !== current.revision) {
        return { status: "conflict", currentRevision: current.revision };
      }
      const next: DeploymentPolicyV1 = {
        schemaVersion: 1,
        revision: nextRevision(current.revision, "deployment policy"),
        admission: { mode: request.command.mode },
        updatedAt: new Date().toISOString(),
        updatedBy: request.updatedBy,
      };
      this.kv.put(POLICY_KEY, next);
      return { status: "applied", value: next };
    });
  }

  async readAccountAccess(input: unknown): Promise<AccountAccessViewV1> {
    const { userId } = decodeAccountAccessReadRequestV1(input);
    return { schemaVersion: 1, userId, access: this.access(userId) };
  }

  /**
   * An admin's decision about one account. Compare-and-swap on the record's
   * revision, which admission also advances, so an admin who read `invited`
   * and chose `paused` learns the account activated meanwhile instead of
   * silently overwriting what they did not see.
   */
  async setAccountAccess(
    input: unknown,
  ): Promise<RevisionedWriteV1<AccountAccessV1>> {
    const request = decodeSetAccountAccessRequestV1(input);
    return this.ctx.storage.transactionSync<RevisionedWriteV1<AccountAccessV1>>(
      () => {
        const current = this.access(request.userId);
        const revision = current?.revision ?? 0;
        if (request.command.revision !== revision) {
          return { status: "conflict", currentRevision: revision };
        }
        const next: AccountAccessV1 = {
          schemaVersion: 1,
          userId: request.userId,
          state: request.command.state,
          revision: nextRevision(revision, "account access"),
          updatedAt: new Date().toISOString(),
          updatedBy: request.updatedBy,
        };
        this.kv.put(ACCESS_PREFIX + request.userId, next);
        return { status: "applied", value: next };
      },
    );
  }

  /** Idempotent: inviting an address twice keeps the first invitation. */
  async inviteEmail(input: unknown): Promise<EmailInvitationV1> {
    const request = decodeInviteEmailRequestV1(input);
    return this.ctx.storage.transactionSync(() => {
      const existing = this.invitation(request.command.email);
      if (existing) return existing;
      const invitation: EmailInvitationV1 = {
        schemaVersion: 1,
        email: request.command.email,
        invitedAt: new Date().toISOString(),
        invitedBy: request.invitedBy,
      };
      this.kv.put(INVITATION_PREFIX + invitation.email, invitation);
      return invitation;
    });
  }

  /**
   * Commits browser/native admission before a User can be provisioned.
   * Deciding and activating are one transaction, and an invitation is spent
   * in the same one, so it binds to exactly one account.
   */
  async admitAccount(input: unknown): Promise<AccountAdmissionDecisionV1> {
    const identity = decodeAdmissionIdentityV1(input);
    return this.ctx.storage.transactionSync(() => {
      const access = this.access(identity.userId);
      const evaluation = this.evaluateAccount(identity, access);
      if (evaluation.activate) {
        const next: AccountAccessV1 = {
          schemaVersion: 1,
          userId: identity.userId,
          state: "active",
          revision: nextRevision(access?.revision ?? 0, "account access"),
          updatedAt: new Date().toISOString(),
          updatedBy: ADMISSION_UPDATED_BY,
        };
        this.kv.put(ACCESS_PREFIX + identity.userId, next);
      }
      if (evaluation.redeemInvitation && identity.email !== undefined) {
        this.kv.delete(INVITATION_PREFIX + identity.email);
      }
      return evaluation.decision;
    });
  }

  private evaluateAccount(
    identity: AdmissionIdentityV1,
    access: AccountAccessV1 | null,
  ) {
    return evaluateAdmissionV1({
      mode: this.policy().admission.mode,
      identity,
      access,
      invitation: identity.emailVerified
        ? this.invitation(identity.email)
        : null,
    });
  }

  async checkAccount(input: unknown): Promise<AccountAdmissionDecisionV1> {
    const identity = decodeAdmissionIdentityV1(input);
    return this.ctx.storage.transactionSync(
      () =>
        this.evaluateAccount(identity, this.access(identity.userId)).decision,
    );
  }

  /**
   * One Bot's inbound address is now this token's digest. The User object
   * that holds the token is the only caller; the Bot's previous digest stops
   * resolving in the same write.
   */
  async registerInboundEmailAddress(
    input: unknown,
  ): Promise<{ schemaVersion: 1 }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      tokenDigest: INBOUND_EMAIL_DIGEST,
    });
    this.ctx.storage.transactionSync(() =>
      registerInboundAddressV1(this.kv, {
        userId: request.userId as string,
        botId: request.botId as string,
        tokenDigest: request.tokenDigest as string,
      }),
    );
    return { schemaVersion: 1 };
  }

  /** One Bot has no inbound address any more. */
  async releaseInboundEmailAddress(
    input: unknown,
  ): Promise<{ schemaVersion: 1 }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    this.ctx.storage.transactionSync(() =>
      releaseInboundAddressV1(this.kv, {
        userId: request.userId as string,
        botId: request.botId as string,
      }),
    );
    return { schemaVersion: 1 };
  }

  /** The User and Bot an address token's digest names, or `null`. */
  async resolveInboundEmailAddress(input: unknown): Promise<{
    schemaVersion: 1;
    recipient: { userId: string; botId: string } | null;
  }> {
    const request = decodeRpcEnvelopeV1(input, {
      tokenDigest: INBOUND_EMAIL_DIGEST,
    });
    return {
      schemaVersion: 1,
      recipient:
        resolveInboundAddressV1(this.kv, request.tokenDigest as string) ?? null,
    };
  }

  async mayCreateIdentity(input: unknown): Promise<boolean> {
    const request = decodeIdentityCreationRequestV1(input);
    return identityMayBeCreatedV1(
      this.policy().admission.mode,
      request,
      request.emailVerified ? this.invitation(request.email) : null,
    );
  }

  /** The hosted model prices every Bot reserves and settles against. */
  async readModelRates(input: unknown): Promise<HostedModelRatesV1> {
    decodeModelRatesReadRequestV1(input);
    return currentHostedModelRatesV1(this.ctx.storage);
  }

  async readModelRatesView(input: unknown): Promise<HostedModelRatesViewV1> {
    decodeModelRatesReadRequestV1(input);
    return hostedModelRatesViewV1(this.ctx.storage);
  }

  async saveModelRates(input: unknown): Promise<ModelRatesWriteV1> {
    return saveHostedModelRatesV1(this.ctx.storage, input);
  }

  async reportUnpricedServedModel(input: unknown): Promise<void> {
    reportUnpricedServedModelV1(this.ctx.storage, input);
  }

  /**
   * The first step of deleting an account: `ended`, whatever the record said
   * and whether or not there was one, so no request of the account's starts
   * anything while its data is being destroyed. Not a compare-and-swap — the
   * person already confirmed, and an admin's concurrent write must not
   * reopen an account mid-deletion. Repeating it changes nothing.
   */
  async closeAccountForDeletion(input: unknown): Promise<AccountAccessV1> {
    const { userId } = decodeAccountDeletionAccessRequestV1(input);
    return this.ctx.storage.transactionSync(() => {
      const current = this.access(userId);
      if (
        current?.state === "ended" &&
        current.updatedBy === DELETION_UPDATED_BY
      )
        return current;
      const next: AccountAccessV1 = {
        schemaVersion: 1,
        userId,
        state: "ended",
        revision: nextRevision(current?.revision ?? 0, "account access"),
        updatedAt: new Date().toISOString(),
        updatedBy: DELETION_UPDATED_BY,
      };
      this.kv.put(ACCESS_PREFIX + userId, next);
      return next;
    });
  }

  /**
   * The last trace of a deleted account here: its access record, any
   * invitation still waiting under its address, and its Bots' inbound
   * addresses. Called only once the identity itself is gone, so no session is
   * left that could be admitted afresh.
   */
  async forgetAccount(input: unknown): Promise<{ schemaVersion: 1 }> {
    const request = decodeAccountDeletionAccessRequestV1(input);
    this.ctx.storage.transactionSync(() => {
      this.kv.delete(ACCESS_PREFIX + request.userId);
      if (request.email !== undefined) {
        this.kv.delete(INVITATION_PREFIX + request.email);
      }
      forgetInboundEmailUserV1(this.kv, request.userId);
    });
    return { schemaVersion: 1 };
  }
}
