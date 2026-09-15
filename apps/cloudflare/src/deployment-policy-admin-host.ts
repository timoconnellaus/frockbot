import type { AdminOperationsHostV1 } from "@frockbot/app/admin/operations";
import {
  AccountAccessConflictError,
  decodeAccountAccessV1,
  decodeAccountAccessViewV1,
  decodeDeploymentPolicyV1,
  decodeEmailInvitationV1,
  DeploymentPolicyConflictError,
} from "@frockbot/app/admin/shared";
import { rpcJsonSnapshotV1 } from "./durable-rpc.js";

interface DeploymentPolicyAdminRpc {
  readPolicy(input: unknown): Promise<unknown>;
  setAdmissionMode(input: unknown): Promise<unknown>;
  readAccountAccess(input: unknown): Promise<unknown>;
  setAccountAccess(input: unknown): Promise<unknown>;
  inviteEmail(input: unknown): Promise<unknown>;
}

function appliedWrite(
  answer: unknown,
  conflict: (currentRevision: number) => Error,
): unknown {
  const write = rpcJsonSnapshotV1(answer) as Record<string, unknown> | null;
  if (write?.status === "applied") return write.value;
  if (
    write?.status === "conflict" &&
    Number.isSafeInteger(write.currentRevision)
  ) {
    throw conflict(write.currentRevision as number);
  }
  throw new Error("access authority answered an unknown write result");
}

export function createDeploymentPolicyAdminHost(
  authority: () => DeploymentPolicyAdminRpc,
): Pick<
  AdminOperationsHostV1,
  | "readDeploymentPolicy"
  | "setAdmissionMode"
  | "readAccountAccess"
  | "setAccountAccess"
  | "inviteEmail"
> {
  return {
    readDeploymentPolicy: async () =>
      decodeDeploymentPolicyV1(
        rpcJsonSnapshotV1(await authority().readPolicy({ schemaVersion: 1 })),
      ),
    setAdmissionMode: async (command, updatedBy) =>
      decodeDeploymentPolicyV1(
        appliedWrite(
          await authority().setAdmissionMode({
            schemaVersion: 1,
            command,
            updatedBy,
          }),
          (revision) => new DeploymentPolicyConflictError(revision),
        ),
      ),
    readAccountAccess: async (userId) =>
      decodeAccountAccessViewV1(
        rpcJsonSnapshotV1(
          await authority().readAccountAccess({ schemaVersion: 1, userId }),
        ),
      ),
    setAccountAccess: async (userId, command, updatedBy) =>
      decodeAccountAccessV1(
        appliedWrite(
          await authority().setAccountAccess({
            schemaVersion: 1,
            userId,
            command,
            updatedBy,
          }),
          (revision) => new AccountAccessConflictError(revision),
        ),
      ),
    inviteEmail: async (command, invitedBy) =>
      decodeEmailInvitationV1(
        rpcJsonSnapshotV1(
          await authority().inviteEmail({
            schemaVersion: 1,
            command,
            invitedBy,
          }),
        ),
      ),
  };
}
