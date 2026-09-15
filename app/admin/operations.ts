// The deployment's administration, as operations rather than routes.
//
// Administration is not part of the product surface: it lives in the admin
// portal, a Worker of its own behind Cloudflare Access, which reaches these
// operations over a service binding (ADR 0028). Nothing here reads a request
// or writes a response — the entrypoint that mounts it does — so the portal
// and a test call exactly the same thing.

import {
  decodeAccountAccessReadRequestV1,
  decodeAdminUserListViewV1,
  decodeGrantUserCreditRequestV1,
  decodeInviteEmailRequestV1,
  decodeSetAccountAccessRequestV1,
  decodeSetAdmissionModeRequestV1,
  decodeSetUserFeaturesRequestV1,
  type AccountAccessV1,
  type AccountAccessViewV1,
  type AdminGatedPluginV1,
  type AdminUserBillingV1,
  type AdminUserListViewV1,
  type AdminUserViewV1,
  type AdminWriteResultV1,
  type DeploymentPolicyV1,
  type EmailInvitationV1,
  type GrantUserCreditCommandV1,
  type InviteEmailCommandV1,
  type SetAccountAccessCommandV1,
  type SetAdmissionModeCommandV1,
  type SetUserFeaturesCommandV1,
  type UserFeaturesV1,
} from "./shared.js";
import {
  DEPLOYMENT_PLUGIN_CATALOG_V1,
  type SeededPluginV1,
} from "@frockbot/app/plugins/catalog";
import { isRpcIdentifier } from "@frockbot/core/configuration";

/** One account the identity store knows, before what it holds is read. */
export interface AdminListedUserV1 {
  userId: string;
  email?: string;
  name?: string;
}

/**
 * Everything administration reaches: the access authority, the identity store
 * and one account's User Durable Object. The deployment supplies it; these
 * operations never address a binding themselves.
 */
export interface AdminOperationsHostV1 {
  readDeploymentPolicy(): Promise<DeploymentPolicyV1>;
  /** Throws `DeploymentPolicyConflictError` when the revision is stale. */
  setAdmissionMode(
    command: SetAdmissionModeCommandV1,
    updatedBy: string,
  ): Promise<DeploymentPolicyV1>;
  readAccountAccess(userId: string): Promise<AccountAccessViewV1>;
  /** Throws `AccountAccessConflictError` when the revision is stale. */
  setAccountAccess(
    userId: string,
    command: SetAccountAccessCommandV1,
    updatedBy: string,
  ): Promise<AccountAccessV1>;
  inviteEmail(
    command: InviteEmailCommandV1,
    invitedBy: string,
  ): Promise<EmailInvitationV1>;
  /** Every account the identity store holds, newest first. */
  listUsers(): Promise<AdminListedUserV1[]>;
  readUserFeatures(userId: string): Promise<UserFeaturesV1>;
  setUserFeatures(
    userId: string,
    command: SetUserFeaturesCommandV1,
    updatedBy: string,
  ): Promise<UserFeaturesV1>;
  readUserBilling(userId: string): Promise<AdminUserBillingV1>;
  grantUserCredit(
    userId: string,
    command: GrantUserCreditCommandV1,
    grantedBy: string,
  ): Promise<AdminUserBillingV1>;
}

export interface AdminOperationsV1 {
  readPolicy(): Promise<DeploymentPolicyV1>;
  setAdmissionMode(
    input: unknown,
  ): Promise<AdminWriteResultV1<DeploymentPolicyV1>>;
  listAccounts(): Promise<AdminUserListViewV1>;
  readAccountAccess(input: unknown): Promise<AccountAccessViewV1>;
  setAccountAccess(
    input: unknown,
  ): Promise<AdminWriteResultV1<AccountAccessV1>>;
  inviteEmail(input: unknown): Promise<EmailInvitationV1>;
  setAccountFeatures(input: unknown): Promise<UserFeaturesV1>;
  grantCredit(input: unknown): Promise<AdminUserBillingV1>;
}

function accountId(value: string, label: string): string {
  if (!isRpcIdentifier(value)) throw new Error(`${label} is invalid`);
  return value;
}

/**
 * A compare-and-swap that lost, as a value rather than an exception.
 *
 * The caller is another Worker across a service binding, where an exception
 * arrives as a message and a class name does not survive. A conflict is an
 * ordinary answer — someone else wrote first — so it is returned as one, with
 * the revision the next attempt must carry.
 */
async function write<T>(
  apply: () => Promise<T>,
  conflictName: string,
): Promise<AdminWriteResultV1<T>> {
  try {
    return { status: "applied", value: await apply() };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === conflictName &&
      "currentRevision" in error &&
      Number.isSafeInteger(error.currentRevision)
    ) {
      return {
        status: "conflict",
        currentRevision: error.currentRevision as number,
      };
    }
    throw error;
  }
}

/** The admin-gated seeded Plugins an admin may open for one account. */
export function adminGatedPluginsV1(
  catalog: readonly SeededPluginV1[] = DEPLOYMENT_PLUGIN_CATALOG_V1,
): AdminGatedPluginV1[] {
  return catalog
    .filter((plugin) => plugin.seed === "admin-gated")
    .map((plugin) => ({
      pluginId: plugin.pluginId,
      displayName: plugin.displayName,
    }));
}

export function createAdminOperationsV1(
  host: AdminOperationsHostV1,
  catalog: readonly SeededPluginV1[] = DEPLOYMENT_PLUGIN_CATALOG_V1,
): AdminOperationsV1 {
  return {
    readPolicy: () => host.readDeploymentPolicy(),

    async setAdmissionMode(input) {
      const request = decodeSetAdmissionModeRequestV1(input);
      return write(
        () => host.setAdmissionMode(request.command, request.updatedBy),
        "DeploymentPolicyConflictError",
      );
    },

    /**
     * Every account, with what each holds.
     *
     * Each account's access record, features and credit come from a different
     * authority, so one read can fail while the rest answer. A failed read
     * marks that one account unreadable rather than failing the list or
     * reporting a default: an administrator sees every other account, and the
     * unreadable one is shown as unreadable, never as off.
     */
    async listAccounts() {
      const accounts = await host.listUsers();
      const [features, billing, access] = await Promise.all([
        Promise.allSettled(
          accounts.map((account) => host.readUserFeatures(account.userId)),
        ),
        Promise.allSettled(
          accounts.map((account) => host.readUserBilling(account.userId)),
        ),
        Promise.allSettled(
          accounts.map((account) => host.readAccountAccess(account.userId)),
        ),
      ]);
      const users: AdminUserViewV1[] = accounts.map((account, index) => {
        const read = features[index];
        const balance = billing[index];
        const record = access[index];
        return {
          ...account,
          features:
            read?.status === "fulfilled" ? read.value : { unavailable: true },
          billing:
            balance?.status === "fulfilled"
              ? balance.value
              : { unavailable: true },
          access:
            record?.status === "fulfilled"
              ? record.value
              : { unavailable: true },
        };
      });
      return decodeAdminUserListViewV1({
        schemaVersion: 1,
        users,
        gatedPlugins: adminGatedPluginsV1(catalog),
      });
    },

    async readAccountAccess(input) {
      const request = decodeAccountAccessReadRequestV1(input);
      return host.readAccountAccess(
        accountId(request.userId, "account access read request.userId"),
      );
    },

    async setAccountAccess(input) {
      const request = decodeSetAccountAccessRequestV1(input);
      const userId = accountId(request.userId, "account access request.userId");
      return write(
        () => host.setAccountAccess(userId, request.command, request.updatedBy),
        "AccountAccessConflictError",
      );
    },

    async inviteEmail(input) {
      const request = decodeInviteEmailRequestV1(input);
      return host.inviteEmail(request.command, request.invitedBy);
    },

    async setAccountFeatures(input) {
      const request = decodeSetUserFeaturesRequestV1(input);
      const userId = accountId(request.userId, "user features request.userId");
      const opened = request.command.plugins ?? [];
      const gated = new Set(
        adminGatedPluginsV1(catalog).map((plugin) => plugin.pluginId),
      );
      // An id that names no admin-gated seeded Plugin would sit in the record
      // forever, opening nothing and outliving the catalog entry it guessed at.
      const unknown = opened.find((pluginId) => !gated.has(pluginId));
      if (unknown !== undefined) {
        throw new Error(
          `user features request.command.plugins names no admin-gated Plugin: ${unknown}`,
        );
      }
      return host.setUserFeatures(userId, request.command, request.updatedBy);
    },

    async grantCredit(input) {
      const request = decodeGrantUserCreditRequestV1(input);
      return host.grantUserCredit(
        accountId(request.userId, "credit grant request.userId"),
        request.command,
        request.grantedBy,
      );
    },
  };
}
