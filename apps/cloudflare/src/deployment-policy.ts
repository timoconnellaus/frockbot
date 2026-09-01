import {
  decodeDeploymentPolicyReadRequestV1,
  decodeDeploymentPolicyV1,
  decodeSetSignupsRequestV1,
  DeploymentPolicyConflictError,
  type DeploymentPolicyV1,
} from "@frockbot/plugin-admin/shared";
import { DurableObject } from "cloudflare:workers";

const POLICY_KEY = "deployment:policy:v1";
export const DEPLOYMENT_POLICY_SINGLETON_NAME = "frockbot-deployment-policy";

function defaultPolicy(): DeploymentPolicyV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    signups: { open: false },
    updatedAt: new Date().toISOString(),
    updatedBy: "deployment-default",
  };
}

export class DeploymentPolicy extends DurableObject<Record<string, never>> {
  private async current(): Promise<DeploymentPolicyV1> {
    const stored = await this.ctx.storage.get<unknown>(POLICY_KEY);
    if (stored !== undefined) return decodeDeploymentPolicyV1(stored);
    const initial = defaultPolicy();
    await this.ctx.storage.put(POLICY_KEY, initial);
    return initial;
  }

  async readPolicy(input: unknown): Promise<DeploymentPolicyV1> {
    decodeDeploymentPolicyReadRequestV1(input);
    return this.current();
  }

  async setSignups(input: unknown): Promise<DeploymentPolicyV1> {
    const request = decodeSetSignupsRequestV1(input);
    const current = await this.current();
    if (request.command.revision !== current.revision) {
      throw new DeploymentPolicyConflictError(current.revision);
    }
    if (current.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error("deployment policy revision is exhausted");
    }
    const next: DeploymentPolicyV1 = {
      schemaVersion: 1,
      revision: current.revision + 1,
      signups: { open: request.command.open },
      updatedAt: new Date().toISOString(),
      updatedBy: request.updatedBy,
    };
    await this.ctx.storage.put(POLICY_KEY, next);
    return next;
  }
}
