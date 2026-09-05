import { decodeDeploymentPolicyV1 } from "@frockbot/plugin-admin/shared";
import type { GatewayDependencies } from "./contracts.js";

/** Shared browser/native account policy, before any User materialization. */
export async function accountIsAdmitted(
  userId: string,
  isAdmin: boolean,
  owner: Pick<GatewayDependencies, "userExists" | "readDeploymentPolicy">,
): Promise<boolean> {
  return (
    isAdmin ||
    (await owner.userExists(userId)) ||
    decodeDeploymentPolicyV1(await owner.readDeploymentPolicy()).signups.open
  );
}
