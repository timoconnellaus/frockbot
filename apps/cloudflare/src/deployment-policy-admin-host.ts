import type { AdminOperationsHostV1 } from "@frockbot/app/admin/operations";
import {
  AccountAccessConflictError,
  decodeAccountAccessV1,
  decodeAccountAccessViewV1,
  decodeAdminWriteResultV1,
  decodeDeploymentPolicyV1,
  decodeEmailInvitationV1,
  DeploymentPolicyConflictError,
} from "@frockbot/app/admin/shared";
import {
  decodeHostedModelRatesV1,
  decodeHostedModelRatesViewV1,
  ModelRatesConflictError,
} from "@frockbot/app/billing/rates";
import { rpcJsonSnapshotV1 } from "./durable-rpc.js";

interface DeploymentPolicyAdminRpc {
  readPolicy(input: unknown): Promise<unknown>;
  setAdmissionMode(input: unknown): Promise<unknown>;
  readAccountAccess(input: unknown): Promise<unknown>;
  setAccountAccess(input: unknown): Promise<unknown>;
  inviteEmail(input: unknown): Promise<unknown>;
  readModelRatesView(input: unknown): Promise<unknown>;
  saveModelRates(input: unknown): Promise<unknown>;
}

function appliedWrite(
  answer: unknown,
  conflict: (currentRevision: number) => Error,
): unknown {
  const write = rpcJsonSnapshotV1(answer) as Record<string, unknown> | null;
  let decoded;
  try {
    decoded = decodeAdminWriteResultV1(
      write,
      (value) => value,
      "access authority write result",
    );
  } catch {
    throw new Error("access authority answered an unknown write result");
  }
  if (decoded.status === "conflict") throw conflict(decoded.currentRevision);
  return decoded.value;
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
  | "readModelRates"
  | "saveModelRates"
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
    readModelRates: async () =>
      decodeHostedModelRatesViewV1(
        rpcJsonSnapshotV1(
          await authority().readModelRatesView({ schemaVersion: 1 }),
        ),
      ),
    saveModelRates: async (command, createdBy) =>
      decodeHostedModelRatesV1(
        appliedWrite(
          await authority().saveModelRates({
            schemaVersion: 1,
            command,
            createdBy,
          }),
          (revision) => new ModelRatesConflictError(revision),
        ),
      ),
  };
}
