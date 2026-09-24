import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createAdminOperationsV1,
  type AdminOperationsHostV1,
  type AdminOperationsV1,
} from "@frockbot/app/admin/operations";
import {
  decodeAdminUserBillingV1,
  decodeUserFeaturesV1,
  type AccountAccessV1,
  type AccountAccessViewV1,
  type AdminUserBillingV1,
  type AdminUserListViewV1,
  type AdminWriteResultV1,
  type DeploymentPolicyV1,
  type EmailInvitationV1,
  type UserFeaturesV1,
} from "@frockbot/app/admin/shared";
import type {
  HostedModelRatesV1,
  HostedModelRatesViewV1,
} from "@frockbot/app/billing/rates";
import { createDeploymentPolicyAdminHost } from "./deployment-policy-admin-host.js";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "./deployment-policy.js";
import { rpcJsonSnapshotV1 } from "./durable-rpc.js";

/**
 * What administration needs from the Worker's environment: the access
 * authority, the identity store and one account's User Durable Object.
 *
 * Deliberately narrower than the app's `Env`. Administration reaches three
 * bindings, and naming them here is what says so.
 */
export interface AdminEntrypointEnvV1 {
  AUTH_DB: D1Database;
  USER_CONFIGURATIONS: DurableObjectNamespace;
  DEPLOYMENT_POLICY: DurableObjectNamespace;
}

interface DeploymentPolicyAdminRpc {
  readPolicy(input: unknown): Promise<unknown>;
  setAdmissionMode(input: unknown): Promise<unknown>;
  readAccountAccess(input: unknown): Promise<unknown>;
  setAccountAccess(input: unknown): Promise<unknown>;
  inviteEmail(input: unknown): Promise<unknown>;
  readModelRatesView(input: unknown): Promise<unknown>;
  saveModelRates(input: unknown): Promise<unknown>;
}

interface UserAccountRpc {
  readFeatures(input: unknown): Promise<unknown>;
  setFeatures(input: unknown): Promise<unknown>;
  readBillingBalance(input: unknown): Promise<unknown>;
  grantComplimentaryCredit(input: unknown): Promise<unknown>;
}

function userAccountStub(
  env: AdminEntrypointEnvV1,
  userId: string,
): UserAccountRpc {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration; workers-types cannot infer its account features and billing RPC surface.
  return env.USER_CONFIGURATIONS.get(id) as unknown as UserAccountRpc;
}

function deploymentPolicyStub(
  env: AdminEntrypointEnvV1,
): DeploymentPolicyAdminRpc {
  // SAFETY: Wrangler binds DEPLOYMENT_POLICY to DeploymentPolicy; workers-types cannot infer its authority RPC surface.
  return env.DEPLOYMENT_POLICY.getByName(
    DEPLOYMENT_POLICY_SINGLETON_NAME,
  ) as unknown as DeploymentPolicyAdminRpc;
}

export function createAdminOperationsHostV1(
  env: AdminEntrypointEnvV1,
): AdminOperationsHostV1 {
  return {
    ...createDeploymentPolicyAdminHost(() => deploymentPolicyStub(env)),
    listUsers: async () => {
      const result = await env.AUTH_DB.prepare(
        'select "id", "email", "name" from "user" order by "createdAt" desc limit 200',
      ).all<{ id: string; email: string; name: string }>();
      return (result.results ?? []).map((user) => ({
        userId: user.id,
        email: user.email,
        name: user.name,
      }));
    },
    readUserFeatures: async (userId) =>
      decodeUserFeaturesV1(
        rpcJsonSnapshotV1(
          await userAccountStub(env, userId).readFeatures({
            schemaVersion: 1,
            userId,
          }),
        ),
      ),
    setUserFeatures: async (userId, command, updatedBy) =>
      decodeUserFeaturesV1(
        rpcJsonSnapshotV1(
          await userAccountStub(env, userId).setFeatures({
            schemaVersion: 1,
            userId,
            command,
            updatedBy,
          }),
        ),
      ),
    readUserBilling: async (userId) =>
      decodeAdminUserBillingV1(
        rpcJsonSnapshotV1(
          await userAccountStub(env, userId).readBillingBalance({ userId }),
        ),
      ),
    grantUserCredit: async (userId, command, grantedBy) =>
      decodeAdminUserBillingV1(
        rpcJsonSnapshotV1(
          await userAccountStub(env, userId).grantComplimentaryCredit({
            userId,
            command: {
              id: command.id,
              micros: command.cents * 10_000,
              grantedBy,
              reason: command.reason,
            },
          }),
        ),
      ),
  };
}

/**
 * Administration, reachable only over a service binding.
 *
 * No HTTP route reaches this class: the admin portal
 * (`apps/admin-portal`) binds it as `APP` and is the one caller, so the
 * authority that decides who administers the deployment is Cloudflare Access
 * plus the admin emails list, checked there, and never a session in this
 * Worker (ADR 0028). Every method decodes its input the way the Durable
 * Objects behind it do, and every compare-and-swap answers `applied` or
 * `conflict` rather than throwing, because a conflict is an answer.
 */
export class AdminEntrypoint extends WorkerEntrypoint<AdminEntrypointEnvV1> {
  private get operations(): AdminOperationsV1 {
    return createAdminOperationsV1(createAdminOperationsHostV1(this.env));
  }

  readPolicy(): Promise<DeploymentPolicyV1> {
    return this.operations.readPolicy();
  }

  setAdmissionMode(
    input: unknown,
  ): Promise<AdminWriteResultV1<DeploymentPolicyV1>> {
    return this.operations.setAdmissionMode(input);
  }

  listAccounts(): Promise<AdminUserListViewV1> {
    return this.operations.listAccounts();
  }

  readAccountAccess(input: unknown): Promise<AccountAccessViewV1> {
    return this.operations.readAccountAccess(input);
  }

  setAccountAccess(
    input: unknown,
  ): Promise<AdminWriteResultV1<AccountAccessV1>> {
    return this.operations.setAccountAccess(input);
  }

  inviteEmail(input: unknown): Promise<EmailInvitationV1> {
    return this.operations.inviteEmail(input);
  }

  setAccountFeatures(input: unknown): Promise<UserFeaturesV1> {
    return this.operations.setAccountFeatures(input);
  }

  grantCredit(input: unknown): Promise<AdminUserBillingV1> {
    return this.operations.grantCredit(input);
  }

  readModelRates(): Promise<HostedModelRatesViewV1> {
    return this.operations.readModelRates();
  }

  saveModelRates(
    input: unknown,
  ): Promise<AdminWriteResultV1<HostedModelRatesV1>> {
    return this.operations.saveModelRates(input);
  }
}
