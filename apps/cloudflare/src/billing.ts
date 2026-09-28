import { BRAND_V1 } from "#brand";
import {
  BILLING_LAUNCH_BLOCKERS,
  hostedBillingEnabledV1,
} from "./billing-readiness.js";
import { COMPUTER_TARIFF } from "@frockbot/app/billing/computer";
import type { HostedModelRatesV1 } from "@frockbot/app/billing/rates";
import { normalizeFrockModelIdV1 } from "@frockbot/providers/frock-ai/catalog";
import {
  BillingError,
  type UsageReservation,
  type UsageSettlement,
} from "@frockbot/app/billing/ledger";
import { boundedText, object } from "@frockbot/app/billing/wire";
import type {
  PaymentsAccountV1,
  PaymentsPackageV1,
  PaymentsRouteContextV1,
} from "@frockbot/core/contracts";
import {
  PAYMENTS_PACKAGE_V1,
  type PaymentsPackageEnvironmentV1,
} from "#payments";
import {
  billingPageV1,
  billingScript,
  billingStyles,
} from "@frockbot/app/billing/page";
import type { BillingLedger } from "@frockbot/app/billing/ledger";
import {
  SPEND_DIMENSIONS_V1,
  SPEND_PERIODS_V1,
  type SpendDimensionV1,
  type SpendingReportV1,
  type SpendPeriodV1,
} from "@frockbot/app/billing/spending";
import type { BackendRouteContribution } from "./contracts.js";

export interface BillingEnv extends PaymentsPackageEnvironmentV1 {
  BETTER_AUTH_URL?: string;
}

/** The payments Package this build deploys, over this Worker's `env`. */
export function paymentsPackageV1(env: BillingEnv): PaymentsPackageV1 {
  return PAYMENTS_PACKAGE_V1.create(env, {
    productName: BRAND_V1.productName,
  });
}

/** The billing routes that are the app's own, which no Package may serve. */
const APP_BILLING_PATHS_V1 = new Set([
  "/api/billing",
  "/api/billing/spending",
  "/api/billing/limits",
  "/api/billing/reconcile",
]);

/**
 * The addresses outside `/api/billing/provider/` a Package also serves, held
 * to the contract: under `/api/billing/`, and none the app's own.
 */
export function paymentsPathsV1(payments: PaymentsPackageV1): Set<string> {
  const paths = new Set<string>(payments.paths ?? []);
  for (const path of paths)
    if (
      !/^\/api\/billing\/[a-z0-9/_-]+$/.test(path) ||
      path.startsWith("/api/billing/provider/") ||
      APP_BILLING_PATHS_V1.has(path)
    )
      throw new Error(
        `The payments Package cannot serve ${path}: its own paths are under /api/billing/ and none is the app's`,
      );
  return paths;
}

/** The account as the payments Package reads it, from a ledger snapshot. */
export function paymentsAccountV1(snapshot: {
  subscription: PaymentsAccountV1["subscription"];
  paidAccess: PaymentsAccountV1["paidPeriod"];
  subscribed: boolean;
  suspended: boolean;
  trialUsed: boolean;
}): PaymentsAccountV1 {
  return {
    subscription: snapshot.subscription,
    paidPeriod: snapshot.paidAccess,
    subscribed: snapshot.subscribed,
    suspended: snapshot.suspended,
    trialUsed: snapshot.trialUsed,
  };
}
export interface BillingAccountRpc {
  reconcileBilling(input: {
    userId: string;
    command: Parameters<BillingLedger["reconcile"]>[0];
  }): Promise<void>;
  readBilling(input: {
    userId: string;
    before?: number;
  }): Promise<ReturnType<BillingLedger["snapshot"]>>;
  /** One of the payments Package's account commands, in the ledger's object. */
  paymentsCommand(input: {
    userId: string;
    command: string;
    input: unknown;
    signedIn: boolean;
  }): Promise<unknown>;
  reserveUsage(input: {
    userId: string;
    reservation: UsageReservation;
  }): Promise<{
    status: "reserved" | "settled" | "released";
    created: boolean;
  }>;
  settleUsage(input: {
    userId: string;
    settlement: UsageSettlement;
  }): Promise<void>;
  requirePaidAccount(input: { userId: string }): Promise<void>;
  setSpendingLimit(input: {
    userId: string;
    scope: string;
    dailyMicros: number | null;
  }): Promise<void>;
  readSpendingPaused(input: {
    userId: string;
    scopes: string[];
  }): Promise<boolean>;
  claimSpendingSpike(input: {
    userId: string;
    scope: string;
  }): Promise<{ todayMicros: number; usualMicros: number } | null>;
  readSpending(input: {
    userId: string;
    period: SpendPeriodV1;
    groupBy: SpendDimensionV1;
    filters: Partial<Record<SpendDimensionV1, string>>;
  }): Promise<SpendingReportV1>;
}

/**
 * `GET /api/billing/spending?period=30d&groupBy=cause&bot=<id>…`: one view of
 * the Spending page. Each dimension may also be a filter, named by the key a
 * grouping by it returned.
 */
export function decodeSpendingQueryV1(url: URL): {
  period: SpendPeriodV1;
  groupBy: SpendDimensionV1;
  filters: Partial<Record<SpendDimensionV1, string>>;
} {
  const period = SPEND_PERIODS_V1.find(
    (p) => p === (url.searchParams.get("period") ?? "30d"),
  );
  const groupBy = SPEND_DIMENSIONS_V1.find(
    (d) => d === (url.searchParams.get("groupBy") ?? "bot"),
  );
  if (!period || !groupBy) throw new BillingError("Invalid spending view", 400);
  const filters: Partial<Record<SpendDimensionV1, string>> = {};
  for (const dimension of SPEND_DIMENSIONS_V1) {
    const value = url.searchParams.get(dimension);
    if (value === null) continue;
    if (value.length > 600)
      throw new BillingError("Invalid spending view", 400);
    filters[dimension] = value;
  }
  return { period, groupBy, filters };
}
function failure(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Billing is temporarily unavailable",
    },
    {
      status: error instanceof BillingError ? error.status : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
/**
 * What an account pays per million tokens for each hosted model it can be
 * charged for, the conversation-summary model included. These are ceilings: a call is charged for the model that answered it, never
 * above the rate listed for the one it asked for. A pre-rename `@flock/` id is
 * the same model under its old name, so it is listed once.
 */
export function customerModelRatesV1(table: HostedModelRatesV1 | undefined) {
  const routes = table?.routes ?? {};
  return Object.fromEntries(
    Object.entries(routes)
      .filter(
        ([model]) =>
          normalizeFrockModelIdV1(model) === model ||
          !Object.hasOwn(routes, normalizeFrockModelIdV1(model)),
      )
      .map(([model, rate]) => [
        model,
        {
          inputUsdPerMillion: rate.inputMicrosPerToken * 2,
          cachedInputUsdPerMillion: rate.cachedInputMicrosPerToken * 2,
          outputUsdPerMillion: rate.outputMicrosPerToken * 2,
        },
      ]),
  );
}

export function billingRoutes(
  env: BillingEnv,
  account: (userId: string) => BillingAccountRpc,
  modelRates: () => Promise<HostedModelRatesV1>,
): BackendRouteContribution {
  const payments = paymentsPackageV1(env);
  const providerPaths = paymentsPathsV1(payments);
  const page = () =>
    billingPageV1({
      productName: BRAND_V1.productName,
      plan: PAYMENTS_PACKAGE_V1.plan,
      providerName: payments.providerName,
    });
  return {
    packageId: "billing",
    async publicRoute(request, url, routeContext) {
      if (
        request.method === "GET" &&
        ["/billing", "/billing.js", "/billing.css"].includes(url.pathname)
      ) {
        const type = url.pathname.endsWith(".js")
          ? "text/javascript"
          : url.pathname.endsWith(".css")
            ? "text/css"
            : "text/html";
        return new Response(
          url.pathname.endsWith(".js")
            ? billingScript
            : url.pathname.endsWith(".css")
              ? billingStyles
              : page(),
          {
            headers: {
              "content-type": `${type}; charset=utf-8`,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "content-security-policy":
                "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
            },
          },
        );
      }
      // Everything under here is the payments Package's: provider events,
      // and the purchases the signed-in person starts, which ask the session
      // themselves.
      if (
        !url.pathname.startsWith("/api/billing/provider/") &&
        !providerPaths.has(url.pathname)
      )
        return;
      const context: PaymentsRouteContextV1 = {
        sessionUserId: () =>
          routeContext.sessionUserId?.() ?? Promise.resolve(undefined),
        account: (userId, { signedIn }) => ({
          command: async (command, input) => {
            if (signedIn && BILLING_LAUNCH_BLOCKERS.length)
              throw new BillingError(
                "Payments are not open yet. Launch qualification is still in progress.",
                503,
              );
            return account(userId).paymentsCommand({
              userId,
              command,
              input,
              signedIn,
            });
          },
        }),
      };
      return (
        (await payments.route?.(request, url, context)) ??
        new Response(null, { status: 404 })
      );
    },
    async route(request, url, context) {
      if (
        !url.pathname.startsWith("/api/billing") &&
        !["/billing", "/billing.js", "/billing.css"].includes(url.pathname)
      )
        return;
      if (!context.userId || context.userId === "anonymous")
        return Response.json(
          { error: "Sign in to manage billing" },
          { status: 401 },
        );
      const headers = {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
      };
      if (request.method === "GET") {
        if (url.pathname === "/billing")
          return new Response(page(), {
            headers: { ...headers, "content-type": "text/html; charset=utf-8" },
          });
        if (url.pathname === "/billing.js")
          return new Response(billingScript, {
            headers: {
              ...headers,
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        if (url.pathname === "/billing.css")
          return new Response(billingStyles, {
            headers: { ...headers, "content-type": "text/css; charset=utf-8" },
          });
      }
      try {
        const userId = context.userId;
        if (request.method === "GET" && url.pathname === "/api/billing") {
          const before = url.searchParams.has("before")
            ? Number(url.searchParams.get("before"))
            : undefined;
          if (
            before !== undefined &&
            (!Number.isSafeInteger(before) || before < 0)
          )
            throw new BillingError("Invalid usage cursor", 400);
          const snapshot = await account(userId).readBilling({
            userId,
            ...(before === undefined ? {} : { before }),
          });
          return Response.json(
            {
              ...snapshot,
              // A table that cannot be read just now lists no rates; the
              // balance and history are still the account's to see.
              modelRates: customerModelRatesV1(
                await modelRates().catch(() => undefined),
              ),
              computerRate: {
                activeUsdPerHour: COMPUTER_TARIFF.activeUsdPerHour,
                storageIncludedGb: COMPUTER_TARIFF.storageIncludedGb,
                viewerOpenSeconds: COMPUTER_TARIFF.viewerOpenSeconds,
                viewerRenewSeconds: COMPUTER_TARIFF.viewerRenewSeconds,
              },
              launchBlockers: BILLING_LAUNCH_BLOCKERS,
              // Whether this deployment meters at all. Off, and credit is
              // meaningless: nothing is charged and nothing is refused.
              metered: hostedBillingEnabledV1(env),
              paymentsAvailable:
                BILLING_LAUNCH_BLOCKERS.length === 0 && payments.available,
              // Who handles payments, and what the Billing page offers this
              // account: the payments Package's, drawn as data.
              paymentsProvider: payments.providerName,
              actions: payments.actions(paymentsAccountV1(snapshot)),
            },
            { headers },
          );
        }
        if (
          request.method === "GET" &&
          url.pathname === "/api/billing/spending"
        )
          return Response.json(
            await account(userId).readSpending({
              userId,
              ...decodeSpendingQueryV1(url),
            }),
            { headers },
          );
        if (request.method !== "POST")
          return new Response(null, { status: 405 });
        const origin = request.headers.get("origin");
        if (
          origin &&
          origin !== new URL(env.BETTER_AUTH_URL ?? request.url).origin
        )
          throw new BillingError("Invalid request origin", 403);
        if (
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          throw new BillingError("Expected JSON", 415);
        const body = object(JSON.parse(await boundedText(request, 4096)));
        if (url.pathname === "/api/billing/reconcile") {
          if (!context.isAdmin)
            throw new BillingError("Administrator access required", 403);
          if (
            typeof body.userId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(body.userId)
          )
            throw new BillingError("Invalid account", 400);
          const command = object(body.command);
          if (
            typeof command.id !== "string" ||
            typeof command.reason !== "string"
          )
            throw new BillingError("Invalid reconciliation", 400);
          await account(body.userId).reconcileBilling({
            userId: body.userId,
            command: {
              ...command,
              actorId: context.userId,
            } as unknown as Parameters<BillingLedger["reconcile"]>[0],
          });
          return Response.json({ ok: true }, { headers });
        }
        if (url.pathname === "/api/billing/limits") {
          if (
            typeof body.scope !== "string" ||
            (body.dailyMicros !== null && typeof body.dailyMicros !== "number")
          )
            throw new BillingError("Invalid daily limit", 400);
          await account(userId).setSpendingLimit({
            userId,
            scope: body.scope,
            dailyMicros: body.dailyMicros as number | null,
          });
          return Response.json({ ok: true }, { headers });
        }
        return new Response(null, { status: 404 });
      } catch (error) {
        return failure(error);
      }
    },
  };
}
