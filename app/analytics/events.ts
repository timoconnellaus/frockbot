import type { PaymentsAccountV1 } from "@frockbot/core/contracts";

/**
 * Product events: what people do with FrockBot, for finding where new
 * accounts stall. Written to Cloudflare Analytics Engine and read back with
 * SQL (`scripts/analytics.ts`, docs/analytics.md).
 *
 * Analytics Engine is lossy by design — it samples under load and keeps about
 * three months — so nothing here is ever a source of truth, and an event that
 * fails to write is dropped rather than retried. What a User must be able to
 * see belongs in the Bot's own durable records, not here.
 *
 * An event names who and what, never what was said: no message text, no
 * email address, no tool arguments.
 */

export const PRODUCT_EVENT_NAMES_V1 = [
  // The account
  "account_created",
  "app_opened",
  "message_sent",
  "push_registered",
  "desktop_paired",
  // Bots and what they did
  "bot_created",
  "turn_settled",
  "tool_used",
  "routine_created",
  "plugin_installed",
  "plugin_enabled",
  "voice_call_started",
  // Money
  "checkout_started",
  "trial_started",
  "subscription_changed",
  "paid_period",
  "credit_exhausted",
  "account_suspended",
] as const;

export type ProductEventNameV1 = (typeof PRODUCT_EVENT_NAMES_V1)[number];

export const CLIENT_PLATFORMS_V1 = [
  "web",
  "android",
  "ios",
  "macos",
  "windows",
  "linux",
] as const;

export type ClientPlatformV1 = (typeof CLIENT_PLATFORMS_V1)[number];

export interface ProductEventV1 {
  name: ProductEventNameV1;
  userId: string;
  botId?: string;
  /** The one qualifier a name needs: a Turn's status, a tool's name, a plan. */
  kind?: string;
  /** A second qualifier: where a Turn came from. */
  detail?: string;
  platform?: ClientPlatformV1;
  appVersion?: string;
  /** Money in micro-dollars, where the event moves or costs some. */
  micros?: number;
  durationMs?: number;
  count?: number;
}

/** The part of an Analytics Engine dataset binding this module writes to. */
export interface ProductEventSinkV1 {
  writeDataPoint(point: {
    indexes?: string[];
    blobs?: (string | null)[];
    doubles?: number[];
  }): void;
}

/**
 * The column each field lands in. Analytics Engine columns are positional
 * (`blob1`…, `double1`…), so this order is the query contract: append, never
 * reorder.
 *
 * The User is the index, which is also the sampling key: when Analytics Engine
 * samples, it keeps or drops a User's events together, so a funnel over Users
 * stays whole.
 */
export function productEventDataPointV1(event: ProductEventV1) {
  return {
    indexes: [event.userId.slice(0, 96)],
    blobs: [
      event.name,
      event.userId,
      event.botId ?? null,
      event.kind ?? null,
      event.detail ?? null,
      event.platform ?? null,
      event.appVersion ?? null,
    ],
    doubles: [event.micros ?? 0, event.durationMs ?? 0, event.count ?? 1],
  };
}

/**
 * Writes one event, never throwing and never waiting: a lost data point costs
 * a gap in a chart, which is less than anything the caller was doing.
 */
export function emitProductEventV1(
  sink: ProductEventSinkV1 | undefined,
  event: ProductEventV1,
): void {
  if (!sink) return;
  try {
    sink.writeDataPoint(productEventDataPointV1(event));
  } catch {
    // Deliberately dropped; see the module comment.
  }
}

/** The platform and release a client's hello names, when it names them. */
export function clientOfHelloV1(hello: unknown): {
  platform?: ClientPlatformV1;
  appVersion?: string;
} {
  if (typeof hello !== "object" || hello === null) return {};
  const { platform, nativeVersion } = hello as {
    platform?: unknown;
    nativeVersion?: unknown;
  };
  return {
    ...(CLIENT_PLATFORMS_V1.includes(platform as ClientPlatformV1)
      ? { platform: platform as ClientPlatformV1 }
      : {}),
    ...(typeof nativeVersion === "string" ? { appVersion: nativeVersion } : {}),
  };
}

/** The part of a settled run the Turn's events are read from. */
export interface ProductEventRunV1 {
  runId: string;
  acceptedAt: string;
  status: string;
  origin: string;
  events: readonly {
    type: string;
    timestamp?: string;
    name?: string;
    input?: unknown;
  }[];
}

/**
 * What one settled Turn says about how a Bot is used: the Turn itself, and each
 * tool it called with how many times. Tool names say what a Bot did — wrote a
 * memory, made a Routine, drove its Computer — without anything it was given.
 */
export function productEventsFromSettledRunV1(
  identity: { userId: string; botId: string },
  run: ProductEventRunV1,
  toolName: (name: string, input: unknown) => string = (name) => name,
): ProductEventV1[] {
  const tools = new Map<string, number>();
  let last = Date.parse(run.acceptedAt);
  for (const event of run.events) {
    const at = event.timestamp ? Date.parse(event.timestamp) : NaN;
    if (at > last) last = at;
    if (event.type !== "tool/call" || !event.name) continue;
    const name = toolName(event.name, event.input);
    tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  const accepted = Date.parse(run.acceptedAt);
  return [
    {
      name: "turn_settled",
      ...identity,
      kind: run.status,
      detail: run.origin,
      ...(Number.isFinite(accepted) ? { durationMs: last - accepted } : {}),
    },
    ...[...tools].map(([name, count]): ProductEventV1 => ({
      name: "tool_used",
      ...identity,
      kind: name,
      detail: run.origin,
      count,
    })),
  ];
}

/**
 * What one payments command changed about the account: a trial begun, a
 * subscription that moved (a plan change, a cancellation at period end, a
 * lapse), a month paid for, a suspension. Read as a difference so that every
 * route to a change — checkout, a webhook, the provider's own portal — is
 * counted the same way.
 */
export function productEventsFromAccountChangeV1(
  userId: string,
  before: PaymentsAccountV1,
  after: PaymentsAccountV1,
): ProductEventV1[] {
  const events: ProductEventV1[] = [];
  const was = before.subscription;
  const now = after.subscription;
  if (!before.trialUsed && after.trialUsed) {
    events.push({
      name: "trial_started",
      userId,
      ...(now ? { kind: now.planId } : {}),
    });
  }
  if (
    now &&
    (was?.subscriptionId !== now.subscriptionId ||
      was.status !== now.status ||
      was.planId !== now.planId ||
      was.cancelAtPeriodEnd !== now.cancelAtPeriodEnd)
  ) {
    events.push({
      name: "subscription_changed",
      userId,
      kind: now.cancelAtPeriodEnd ? "cancelling" : now.status,
      detail: now.planId,
    });
  }
  const paid = after.paidPeriod;
  if (
    paid &&
    (before.paidPeriod?.subscriptionId !== paid.subscriptionId ||
      before.paidPeriod.periodStart !== paid.periodStart)
  ) {
    events.push({ name: "paid_period", userId, kind: paid.planId });
  }
  if (!before.suspended && after.suspended) {
    events.push({ name: "account_suspended", userId });
  }
  return events;
}
