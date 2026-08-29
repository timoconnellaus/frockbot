import {
  ComposioRequestError,
  type ComposioClient,
  type ConnectedAccountSummary,
} from "./composio-client.js";

export type ComposioProviderReconciliationRequest =
  | {
      operation: "link";
      userId: string;
      providerAlias: string;
      toolkitSlug: string;
    }
  | {
      operation: "revoke";
      userId: string;
      connectedAccountId: string;
    };

export type ComposioProviderReconciliationResult =
  | { status: "active"; account: ConnectedAccountSummary }
  | { status: "failed"; account: ConnectedAccountSummary }
  | { status: "revoked"; account?: ConnectedAccountSummary }
  | { status: "absent" }
  | { status: "pending"; account?: ConnectedAccountSummary };

export function linkReconciliationDisposition(
  result: ComposioProviderReconciliationResult,
): "ready" | "pending" | "failed" {
  if (result.status === "active") return "ready";
  if (result.status === "pending" || result.status === "absent") {
    return "pending";
  }
  return "failed";
}

export async function reconcileComposioProviderConnection(
  client: ComposioClient,
  request: ComposioProviderReconciliationRequest,
): Promise<ComposioProviderReconciliationResult> {
  if (request.operation === "link") {
    const account = (await client.listConnectedAccounts(request.userId)).find(
      (candidate) =>
        candidate.alias === request.providerAlias &&
        candidate.toolkitSlug === request.toolkitSlug,
    );
    if (!account) return { status: "absent" };
    if (account.status === "ACTIVE") return { status: "active", account };
    if (account.status === "REVOKED") return { status: "revoked", account };
    if (account.status === "FAILED" || account.status === "EXPIRED") {
      return { status: "failed", account };
    }
    return { status: "pending", account };
  }

  let account: ConnectedAccountSummary;
  try {
    account = await client.getConnectedAccount(request.connectedAccountId);
  } catch (error) {
    if (error instanceof ComposioRequestError && error.status === 404) {
      return { status: "absent" };
    }
    throw error;
  }
  if (account.userId !== request.userId) {
    throw new Error("Composio connected account does not belong to the User");
  }
  return account.status === "REVOKED"
    ? { status: "revoked", account }
    : { status: "pending", account };
}
