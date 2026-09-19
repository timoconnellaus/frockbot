// The app Worker's administration, across the service binding.
//
// This is the seam: every answer is decoded here, with the app's own decoders,
// before anything renders it. The binding is trusted to be the app and nothing
// more — a shape that drifted would otherwise reach the page as `undefined`.

import {
  decodeAccountAccessV1,
  decodeAccountAccessViewV1,
  decodeAdminUserBillingV1,
  decodeAdminUserListViewV1,
  decodeAdminWriteResultV1,
  decodeDeploymentPolicyV1,
  decodeEmailInvitationV1,
  decodeUserFeaturesV1,
  type AccountAccessV1,
  type AccountAccessViewV1,
  type AdminUserBillingV1,
  type AdminUserListViewV1,
  type AdminWriteResultV1,
  type DeploymentPolicyV1,
  type EmailInvitationV1,
  type GrantUserCreditCommandV1,
  type SetAccountAccessCommandV1,
  type SetAdmissionModeCommandV1,
  type SetUserFeaturesCommandV1,
  type UserFeaturesV1,
} from "@frockbot/app/admin/shared";

/** The `AdminEntrypoint` RPC surface, as this Worker calls it. */
export interface AdminAppBindingV1 {
  readPolicy(): Promise<unknown>;
  setAdmissionMode(input: unknown): Promise<unknown>;
  listAccounts(): Promise<unknown>;
  readAccountAccess(input: unknown): Promise<unknown>;
  setAccountAccess(input: unknown): Promise<unknown>;
  inviteEmail(input: unknown): Promise<unknown>;
  setAccountFeatures(input: unknown): Promise<unknown>;
  grantCredit(input: unknown): Promise<unknown>;
}

export interface AdministrationV1 {
  readPolicy(): Promise<DeploymentPolicyV1>;
  setAdmissionMode(
    command: SetAdmissionModeCommandV1,
    updatedBy: string,
  ): Promise<AdminWriteResultV1<DeploymentPolicyV1>>;
  listAccounts(): Promise<AdminUserListViewV1>;
  readAccountAccess(userId: string): Promise<AccountAccessViewV1>;
  setAccountAccess(
    userId: string,
    command: SetAccountAccessCommandV1,
    updatedBy: string,
  ): Promise<AdminWriteResultV1<AccountAccessV1>>;
  inviteEmail(email: string, invitedBy: string): Promise<EmailInvitationV1>;
  setAccountFeatures(
    userId: string,
    command: SetUserFeaturesCommandV1,
    updatedBy: string,
  ): Promise<UserFeaturesV1>;
  grantCredit(
    userId: string,
    command: GrantUserCreditCommandV1,
    grantedBy: string,
  ): Promise<AdminUserBillingV1>;
}

export function administrationV1(app: AdminAppBindingV1): AdministrationV1 {
  return {
    readPolicy: async () => decodeDeploymentPolicyV1(await app.readPolicy()),

    setAdmissionMode: async (command, updatedBy) =>
      decodeAdminWriteResultV1(
        await app.setAdmissionMode({ schemaVersion: 1, command, updatedBy }),
        decodeDeploymentPolicyV1,
        "admission mode answer",
      ),

    listAccounts: async () =>
      decodeAdminUserListViewV1(await app.listAccounts()),

    readAccountAccess: async (userId) =>
      decodeAccountAccessViewV1(
        await app.readAccountAccess({ schemaVersion: 1, userId }),
      ),

    setAccountAccess: async (userId, command, updatedBy) =>
      decodeAdminWriteResultV1(
        await app.setAccountAccess({
          schemaVersion: 1,
          userId,
          command,
          updatedBy,
        }),
        decodeAccountAccessV1,
        "account access answer",
      ),

    inviteEmail: async (email, invitedBy) =>
      decodeEmailInvitationV1(
        await app.inviteEmail({
          schemaVersion: 1,
          command: { schemaVersion: 1, type: "access/invite-email", email },
          invitedBy,
        }),
      ),

    setAccountFeatures: async (userId, command, updatedBy) =>
      decodeUserFeaturesV1(
        await app.setAccountFeatures({
          schemaVersion: 1,
          userId,
          command,
          updatedBy,
        }),
      ),

    grantCredit: async (userId, command, grantedBy) =>
      decodeAdminUserBillingV1(
        await app.grantCredit({
          schemaVersion: 1,
          userId,
          command,
          grantedBy,
        }),
      ),
  };
}
