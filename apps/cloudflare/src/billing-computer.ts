import { BillingError, BILLING_PLAN } from "@frockbot/app/billing/ledger";
import {
  COMPUTER_TARIFF,
  computerChargeMicros,
  computerCostMicros,
} from "@frockbot/app/billing/computer";
import {
  decodeComputerHostHttpRequestV1,
  encodeComputerHostRequestV1,
  problem,
  type ComputerHostOperationV1,
  type ComputerHostRequestV1,
} from "@frockbot/computer/host-protocol";
import type { BillingAccountRpc } from "./billing.js";

/**
 * Fixed launch tariff for Computers, in micro-US-dollars per active hour.
 *
 * Fly exposes 8 vCPU, 16 GB RAM and 100 GB storage to one Computer. At the
 * published rates that ceiling costs US$1.3283/hour while active. Two times
 * the ceiling is US$2.6566; the public rate rounds up so an unmetered Computer
 * cannot turn unusually heavy use into a loss.
 */
export const COMPUTER_ACTIVE_MICROS_PER_HOUR =
  COMPUTER_TARIFF.activeMicrosPerHour;
export const COMPUTER_RATE_DESCRIPTION = "Computer · US$2.75 per active hour";

const SECOND_MS = 1_000;
const VIEWER_OPEN_MS = COMPUTER_TARIFF.viewerOpenSeconds * SECOND_MS;
const VIEWER_RENEW_MS = COMPUTER_TARIFF.viewerRenewSeconds * SECOND_MS;
const DEFAULT_MAXIMUM_MS = 60_000;
const OPEN_MAXIMUM_MS = 10 * 60_000;
const SERVICE_MAXIMUM_MS = 120_000;
const EXEC_SETTLEMENT_GRACE_MS = 6_000;

function maximumDuration(operation: ComputerHostOperationV1): number {
  if (operation.kind === "exec")
    return operation.timeoutMs + EXEC_SETTLEMENT_GRACE_MS;
  if (operation.kind === "open") return OPEN_MAXIMUM_MS;
  if (operation.kind === "service") return SERVICE_MAXIMUM_MS;
  if (operation.kind === "viewer")
    return operation.action === "open"
      ? VIEWER_OPEN_MS
      : operation.action === "renew"
        ? VIEWER_RENEW_MS
        : 0;
  return DEFAULT_MAXIMUM_MS;
}

function billedDuration(
  operation: ComputerHostOperationV1,
  elapsedMs: number,
): number {
  if (operation.kind === "viewer") {
    if (operation.action === "open") return VIEWER_OPEN_MS;
    if (operation.action === "renew") return VIEWER_RENEW_MS;
  }
  return Math.max(SECOND_MS, Math.ceil(elapsedMs / SECOND_MS) * SECOND_MS);
}

function cleanupOperation(operation: ComputerHostOperationV1): boolean {
  return (
    operation.kind === "cancel" ||
    (operation.kind === "viewer" && operation.action === "revoke") ||
    (operation.kind === "control" && operation.action === "release")
  );
}

function revokeViewerRequest(
  request: Request,
  decoded: ComputerHostRequestV1,
): Request | undefined {
  if (
    decoded.operation.kind !== "viewer" ||
    decoded.operation.action !== "renew" ||
    !decoded.operation.sessionId
  )
    return;
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(
      encodeComputerHostRequestV1({
        ...decoded,
        operation: {
          kind: "viewer",
          action: "revoke",
          sessionId: decoded.operation.sessionId,
        },
      }),
    ),
  });
}

async function responseWithSettlement(
  response: Response,
  settle: () => Promise<void>,
): Promise<Response> {
  if (!response.body) {
    await settle();
    return response;
  }
  const reader = response.body.getReader();
  let settled = false;
  const once = async () => {
    if (settled) return;
    settled = true;
    await settle();
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          await once();
          controller.close();
        } catch (error) {
          await once().catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await once();
        }
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

/** Authorize and settle fixed-rate Computer time at the existing host seam. */
export function prepaidComputerHost(
  host: Fetcher,
  account: (userId: string) => BillingAccountRpc,
  now: () => number = Date.now,
): Fetcher {
  return new Proxy(host, {
    get(target, property) {
      if (property !== "fetch") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (request: Request): Promise<Response> => {
        const decoded = await decodeComputerHostHttpRequestV1(
          request.clone() as unknown as Parameters<
            typeof decodeComputerHostHttpRequestV1
          >[0],
        );
        if (!decoded.ok) return decoded.response;
        const { operation, identity, tenant, effectId } = decoded.value;
        if (cleanupOperation(operation)) return target.fetch(request);

        const billing = account(identity.userId);
        let reservation:
          | {
              status: "reserved" | "settled" | "released";
              created: boolean;
            }
          | undefined;
        try {
          reservation = await billing.reserveUsage({
            userId: identity.userId,
            reservation: {
              id: `computer:${effectId}`,
              kind: "computer",
              maximumMicros: computerChargeMicros(maximumDuration(operation)),
              botId: tenant.botId,
              description: COMPUTER_RATE_DESCRIPTION,
              pricingVersion: BILLING_PLAN.pricingVersion,
              unitRates: {
                activeMicrosPerHour: COMPUTER_ACTIVE_MICROS_PER_HOUR,
              },
            },
          });
        } catch (error) {
          const revoke = revokeViewerRequest(request, decoded.value);
          if (revoke) await target.fetch(revoke).catch(() => undefined);
          return problem(
            error instanceof BillingError ? error.status : 402,
            "not-authorized",
            error instanceof Error
              ? error.message
              : "Open Billing to check your subscription and balance.",
          );
        }

        const started = now();
        const settle = async () => {
          if (!reservation?.created) return;
          const durationMs = billedDuration(operation, now() - started);
          const chargeMicros = computerChargeMicros(durationMs);
          await billing.settleUsage({
            userId: identity.userId,
            settlement: {
              id: `computer:${effectId}`,
              costMicros: computerCostMicros(durationMs),
              chargeMicros,
              quantities: { activeSeconds: durationMs / SECOND_MS },
            },
          });
        };

        // A thrown service-binding failure does not say whether the host ran
        // the effect. Keep that reservation for evidence-based reconciliation
        // instead of inventing either a charge or a refund.
        const response = await target.fetch(request);
        const streaming =
          operation.kind === "exec"
            ? operation.stream
            : operation.kind === "open" && operation.stream;
        if (streaming) return await responseWithSettlement(response, settle);
        await settle();
        return response;
      };
    },
  });
}
