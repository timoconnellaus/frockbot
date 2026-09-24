// The inbound email gateway Contribution: one Bot's address and the
// account's senders, as its settings page reads and changes them.
//
//   GET  /api/bots/:botId/email           the address and who may write to it
//   POST /api/bots/:botId/email/address   {action: create | rotate | remove}
//   POST /api/bots/:botId/email/senders   {action: add | remove, address}
//
// Every answer is the page's whole view. The senders belong to the account —
// one list for every Bot — and are drawn on each Bot's page because that is
// where the address they write to is. Messages themselves never come through
// here: they arrive at the Worker's `email()` handler (`./inbound.ts`).

import { decodeBotIdV1 } from "@frockbot/core/configuration";
import { defineGatewayContribution } from "@frockbot/core/contracts/contributions";
import {
  inboundEmailViewV1,
  INBOUND_EMAIL_ROUTE_V1,
  normalizeSenderAddressV1,
  type InboundEmailStateV1,
} from "./shared.js";

export interface InboundEmailGatewayHostV1 {
  /** Absent: this deployment receives no email, and the page says so. */
  inboundEmailDomain?: string;
  /** The User's verified sign-in address, when the identity has one. */
  inboundEmailSignIn(userId: string): Promise<string | undefined>;
  readInboundEmail(userId: string, botId: string): Promise<InboundEmailStateV1>;
  commandInboundEmailAddress(
    userId: string,
    botId: string,
    action: "create" | "rotate" | "remove",
  ): Promise<{ status: "applied" } | { status: "rejected"; reason: string }>;
  commandInboundEmailSender(
    userId: string,
    command: {
      action: "add" | "remove";
      address: string;
      signInEmail?: string;
    },
  ): Promise<{ status: "applied" } | { status: "rejected"; reason: string }>;
}

export interface InboundEmailBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

const NO_STORE = { "cache-control": "no-store" };

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return {};
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createInboundEmailBackendContribution(
  host: InboundEmailGatewayHostV1,
): InboundEmailBackendRouteContribution {
  async function view(userId: string, botId: string): Promise<Response> {
    const [state, signInEmail] = await Promise.all([
      host.readInboundEmail(userId, botId),
      host.inboundEmailSignIn(userId),
    ]);
    return Response.json(
      inboundEmailViewV1(state, {
        ...(host.inboundEmailDomain ? { domain: host.inboundEmailDomain } : {}),
        ...(signInEmail ? { signInEmail } : {}),
        now: Date.now(),
      }),
      { headers: NO_STORE },
    );
  }

  return {
    packageId: "email",
    async route(request, url, context) {
      const match = url.pathname.match(INBOUND_EMAIL_ROUTE_V1);
      if (!match) return undefined;
      const userId = context.userId;
      if (!userId) return jsonError(401, "authentication required");
      let botId: string;
      try {
        botId = decodeBotIdV1(decodeURIComponent(match[1]!), "bot id");
      } catch {
        return jsonError(400, "invalid bot id");
      }
      const tail = match[2] ?? "";
      try {
        if (tail === "") {
          if (request.method !== "GET") {
            return jsonError(405, "method not allowed");
          }
          return await view(userId, botId);
        }
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        const body = await readBody(request);
        if (tail === "/address") {
          const action = body.action;
          if (
            action !== "create" &&
            action !== "rotate" &&
            action !== "remove"
          ) {
            return jsonError(400, "action must be create, rotate or remove");
          }
          if (action !== "remove" && !host.inboundEmailDomain) {
            return jsonError(503, "Email isn’t set up on this deployment.");
          }
          const outcome = await host.commandInboundEmailAddress(
            userId,
            botId,
            action,
          );
          if (outcome.status === "rejected") {
            return jsonError(409, outcome.reason);
          }
          return await view(userId, botId);
        }
        if (tail === "/senders") {
          const action = body.action;
          if (action !== "add" && action !== "remove") {
            return jsonError(400, "action must be add or remove");
          }
          const address = normalizeSenderAddressV1(body.address);
          if (!address) {
            return jsonError(
              400,
              "Enter an email address, like you@example.com.",
            );
          }
          const signInEmail =
            action === "add"
              ? await host.inboundEmailSignIn(userId)
              : undefined;
          const outcome = await host.commandInboundEmailSender(userId, {
            action,
            address,
            ...(signInEmail ? { signInEmail } : {}),
          });
          if (outcome.status === "rejected") {
            return jsonError(409, outcome.reason);
          }
          return await view(userId, botId);
        }
        return jsonError(404, "not found");
      } catch (error) {
        const name =
          typeof error === "object" && error !== null && "name" in error
            ? String(error.name)
            : "";
        if (name === "BotNotFoundError") return jsonError(404, "Bot not found");
        console.error(
          JSON.stringify({
            event: "inbound-email-request-failed",
            error: name || "unknown",
          }),
        );
        return jsonError(500, "Email settings couldn’t be changed. Try again.");
      }
    },
  };
}

/**
 * The gateway `backend` entry, resolved by specifier from the application's
 * Contribution table.
 */
export const backendContribution = defineGatewayContribution<
  InboundEmailGatewayHostV1,
  InboundEmailBackendRouteContribution
>({
  specifier: "@frockbot/app/email/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createInboundEmailBackendContribution(host)),
});
