import {
  decodeAccountAccessReadRequestV1,
  decodeAccountAccessV1,
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
import { DurableObject } from "cloudflare:workers";
import {
  evaluateAdmissionV1,
  identityMayBeCreatedV1,
} from "./account-admission.js";

const POLICY_KEY = "deployment:admission:v1";
const ACCESS_PREFIX = "account:access:v1:";
const INVITATION_PREFIX = "invitation:email:v1:";
export const DEPLOYMENT_POLICY_SINGLETON_NAME = "frockbot-deployment-policy";

/** Written by admission itself, so an audit can tell a sign-in from an admin. */
export const ADMISSION_UPDATED_BY = "admission";

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
 * access record and the email invitations not yet redeemed.
 *
 * One object, and every read-decide-write in it is a synchronous storage
 * transaction, so two sign-ins, or a sign-in racing an admin, are serialized
 * here rather than reconciled later. That is what stops a sign-in that read
 * `invited` from writing `active` over a pause that landed in between.
 */
export class DeploymentPolicy extends DurableObject<Record<string, never>> {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () =>
      cleanRetiredDeploymentPolicyV1(ctx.storage),
    );
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
   * The gate every authenticated request passes before a User is touched.
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

  async mayCreateIdentity(input: unknown): Promise<boolean> {
    const request = decodeIdentityCreationRequestV1(input);
    return identityMayBeCreatedV1(
      this.policy().admission.mode,
      request,
      request.emailVerified ? this.invitation(request.email) : null,
    );
  }
}
