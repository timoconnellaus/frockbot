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
  decodeInvitationNoticeRequestV1,
  decodeInvitationNoticeV1,
  decodeInviteWaitlistRequestV1,
  decodeJoinWaitlistRequestV1,
  decodeRecordInvitationNoticeRequestV1,
  decodeWaitlistEntryV1,
  WAITLIST_CAPACITY_V1,
  WAITLIST_VIEW_LIMIT_V1,
  type InvitationNoticeV1,
  type InviteWaitlistResultV1,
  type JoinWaitlistResultV1,
  type WaitlistEntryV1,
  type WaitlistRowV1,
  type WaitlistViewV1,
} from "@frockbot/app/admin/waitlist";
import {
  claimEmailUsernameV1,
  readEmailUsernameV1,
  releaseEmailUsernameV1,
  resolveEmailUsernameV1,
} from "@frockbot/app/email/directory";
import { isEmailUsernameV1 } from "@frockbot/app/email/shared";
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
import { decodeRpcEnvelopeV1, rpcIdentifier } from "./durable-rpc.js";

const POLICY_KEY = "deployment:admission:v1";
const ACCESS_PREFIX = "account:access:v1:";
const INVITATION_PREFIX = "invitation:email:v1:";
const INVITATION_NOTICE_PREFIX = "invitation:notice:v1:";
const WAITLIST_PREFIX = "waitlist:entry:v1:";
/** How many entries the waitlist holds, so a join need not count them all. */
const WAITLIST_SIZE_KEY = "waitlist:size:v1";
export const DEPLOYMENT_POLICY_SINGLETON_NAME = "frockbot-deployment-policy";

/** An email username, in the shape and outside the names nobody may hold. */
const EMAIL_USERNAME = (value: unknown, label: string): unknown => {
  if (!isEmailUsernameV1(value)) throw new Error(`${label} is invalid`);
  return value;
};

/** Written by admission itself, so an audit can tell a sign-in from an admin. */
const ADMISSION_UPDATED_BY = "admission";
/** Written when the account's own deletion ends its access. */
const DELETION_UPDATED_BY = "account-deletion";

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
type RevisionedWriteV1<T> =
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
 * deployment-wide and equally an administrator's to change, the beta
 * waitlist and the email each invitation sends, and the email
 * usernames (`app/email/directory.ts`): one account per username across the
 * deployment, and the one object the whole deployment shares is what can say
 * whose a message's username is before any User's object is addressed.
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

  private notice(email: string): InvitationNoticeV1 | null {
    const stored = this.kv.get<unknown>(INVITATION_NOTICE_PREFIX + email);
    return stored === undefined ? null : decodeInvitationNoticeV1(stored);
  }

  private waitlistSize(): number {
    return this.kv.get<number>(WAITLIST_SIZE_KEY) ?? 0;
  }

  /** Oldest first; ties broken by address so the order never wavers. */
  private waitlistEntries(): WaitlistEntryV1[] {
    return [...this.kv.list<unknown>({ prefix: WAITLIST_PREFIX })]
      .map(([, value]) => decodeWaitlistEntryV1(value))
      .sort(
        (a, b) =>
          a.joinedAt.localeCompare(b.joinedAt) ||
          a.email.localeCompare(b.email),
      );
  }

  /** The person is in, or gone: they are no longer waiting. */
  private leaveWaitlist(email: string): void {
    if (this.kv.get(WAITLIST_PREFIX + email) === undefined) return;
    this.kv.delete(WAITLIST_PREFIX + email);
    this.kv.put(WAITLIST_SIZE_KEY, Math.max(0, this.waitlistSize() - 1));
  }

  private recordInvitation(
    email: string,
    invitedBy: string,
  ): EmailInvitationV1 {
    const invitation: EmailInvitationV1 = {
      schemaVersion: 1,
      email,
      invitedAt: new Date().toISOString(),
      invitedBy,
    };
    this.kv.put(INVITATION_PREFIX + email, invitation);
    return invitation;
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
      return this.recordInvitation(request.command.email, request.invitedBy);
    });
  }

  /**
   * A public sign-up. Joining twice keeps the first entry, and a full list
   * answers without keeping anything, so the page a person sees is the same
   * either way and a flood of addresses is bounded.
   */
  async joinWaitlist(input: unknown): Promise<JoinWaitlistResultV1> {
    const request = decodeJoinWaitlistRequestV1(input);
    return this.ctx.storage.transactionSync<JoinWaitlistResultV1>(() => {
      if (this.kv.get(WAITLIST_PREFIX + request.email) !== undefined) {
        return { schemaVersion: 1, status: "already-joined" };
      }
      const size = this.waitlistSize();
      if (size >= WAITLIST_CAPACITY_V1) {
        return { schemaVersion: 1, status: "full" };
      }
      const entry: WaitlistEntryV1 = {
        schemaVersion: 1,
        email: request.email,
        joinedAt: new Date().toISOString(),
        ...(request.firstJob === undefined
          ? {}
          : { firstJob: request.firstJob }),
      };
      this.kv.put(WAITLIST_PREFIX + entry.email, entry);
      this.kv.put(WAITLIST_SIZE_KEY, size + 1);
      return { schemaVersion: 1, status: "joined" };
    });
  }

  /** Who is waiting, oldest first, then who is invited and not yet in. */
  async readWaitlist(input: unknown): Promise<WaitlistViewV1> {
    decodeDeploymentPolicyReadRequestV1(input);
    return this.ctx.storage.transactionSync(() => {
      const waiting: WaitlistRowV1[] = [];
      const invited: WaitlistRowV1[] = [];
      for (const entry of this.waitlistEntries()) {
        const invitation = this.invitation(entry.email);
        if (!invitation) {
          waiting.push({ entry });
          continue;
        }
        const notice = this.notice(entry.email);
        invited.push({ entry, invitation, ...(notice ? { notice } : {}) });
      }
      return {
        schemaVersion: 1,
        total: waiting.length + invited.length,
        waiting: waiting.length,
        rows: [...waiting, ...invited].slice(0, WAITLIST_VIEW_LIMIT_V1),
      };
    });
  }

  /** Invites the longest-waiting entries that hold no invitation yet. */
  async inviteWaitlist(input: unknown): Promise<InviteWaitlistResultV1> {
    const request = decodeInviteWaitlistRequestV1(input);
    return this.ctx.storage.transactionSync(() => {
      const invitations: EmailInvitationV1[] = [];
      for (const entry of this.waitlistEntries()) {
        if (invitations.length === request.count) break;
        if (this.invitation(entry.email)) continue;
        invitations.push(this.recordInvitation(entry.email, request.invitedBy));
      }
      return { schemaVersion: 1, invitations };
    });
  }

  /**
   * The right to send one invitation's email, taken once. The claim is
   * recorded before anything is sent, so whatever happens to the send — an
   * answer, an error, an eviction mid-call — this invitation never sends
   * another.
   */
  async claimInvitationNotice(
    input: unknown,
  ): Promise<{ schemaVersion: 1; claimed: boolean }> {
    const { email } = decodeInvitationNoticeRequestV1(input);
    return this.ctx.storage.transactionSync(() => {
      if (!this.invitation(email) || this.notice(email)) {
        return { schemaVersion: 1, claimed: false };
      }
      const notice: InvitationNoticeV1 = {
        schemaVersion: 1,
        email,
        status: "sending",
        updatedAt: new Date().toISOString(),
      };
      this.kv.put(INVITATION_NOTICE_PREFIX + email, notice);
      return { schemaVersion: 1, claimed: true };
    });
  }

  /** What a claimed send came to. Only a claim still `sending` is answered. */
  async recordInvitationNotice(input: unknown): Promise<{ schemaVersion: 1 }> {
    const request = decodeRecordInvitationNoticeRequestV1(input);
    this.ctx.storage.transactionSync(() => {
      if (this.notice(request.email)?.status !== "sending") return;
      const notice: InvitationNoticeV1 = {
        schemaVersion: 1,
        email: request.email,
        status: request.status,
        updatedAt: new Date().toISOString(),
        ...(request.detail === undefined ? {} : { detail: request.detail }),
      };
      this.kv.put(INVITATION_NOTICE_PREFIX + request.email, notice);
    });
    return { schemaVersion: 1 };
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
        if (identity.email !== undefined) this.leaveWaitlist(identity.email);
      }
      if (evaluation.redeemInvitation && identity.email !== undefined) {
        this.kv.delete(INVITATION_PREFIX + identity.email);
        this.kv.delete(INVITATION_NOTICE_PREFIX + identity.email);
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
   * The User's email username is now this one, unless another account holds
   * it; the one they held before is released in the same write.
   */
  async claimEmailUsername(
    input: unknown,
  ): Promise<{ schemaVersion: 1; status: "claimed" | "taken" }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      username: EMAIL_USERNAME,
    });
    const claim = this.ctx.storage.transactionSync(() =>
      claimEmailUsernameV1(this.kv, {
        userId: request.userId as string,
        username: request.username as string,
      }),
    );
    return { schemaVersion: 1, status: claim.status };
  }

  /** The User has no email username any more. */
  async releaseEmailUsername(input: unknown): Promise<{ schemaVersion: 1 }> {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    this.ctx.storage.transactionSync(() =>
      releaseEmailUsernameV1(this.kv, request.userId as string),
    );
    return { schemaVersion: 1 };
  }

  /** The User a username belongs to, or `null`. */
  async resolveEmailUsername(
    input: unknown,
  ): Promise<{ schemaVersion: 1; userId: string | null }> {
    const request = decodeRpcEnvelopeV1(input, { username: EMAIL_USERNAME });
    return {
      schemaVersion: 1,
      userId:
        resolveEmailUsernameV1(this.kv, request.username as string) ?? null,
    };
  }

  /** A User's email username, or `null`. */
  async readEmailUsername(
    input: unknown,
  ): Promise<{ schemaVersion: 1; username: string | null }> {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    return {
      schemaVersion: 1,
      username: readEmailUsernameV1(this.kv, request.userId as string) ?? null,
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
   * invitation, invitation email or waitlist entry still under its address,
   * and its email username, which
   * anyone may take again. Called only once the identity itself is gone, so no
   * session is left that could be admitted afresh.
   */
  async forgetAccount(input: unknown): Promise<{ schemaVersion: 1 }> {
    const request = decodeAccountDeletionAccessRequestV1(input);
    this.ctx.storage.transactionSync(() => {
      this.kv.delete(ACCESS_PREFIX + request.userId);
      if (request.email !== undefined) {
        this.kv.delete(INVITATION_PREFIX + request.email);
        this.kv.delete(INVITATION_NOTICE_PREFIX + request.email);
        this.leaveWaitlist(request.email);
      }
      releaseEmailUsernameV1(this.kv, request.userId);
    });
    return { schemaVersion: 1 };
  }
}
