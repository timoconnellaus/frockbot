// The inbound email gateway Contribution: the account's username, and one
// Bot's address, switch and senders, as the settings pages read and change
// them.
//
//   GET  /api/email/username              the username and the domain
//   POST /api/email/username              {username} — or null to give it up
//   GET  /api/bots/:botId/email           the address and who may write to it
//   POST /api/bots/:botId/email/switch    {receiving: boolean}
//   POST /api/bots/:botId/email/senders   {action: add | remove, address}
//
// Every answer is the page's whole view. The username and the senders belong
// to the account — one of each for every Bot — and a Bot's own page draws the
// senders because that is where the address they write to is. Messages never
// come through here: they arrive at the Worker's `email()` handler
// (`./inbound.ts`).

import { decodeBotIdV1 } from "@frockbot/core/configuration";
import { defineGatewayContribution } from "@frockbot/core/contracts/contributions";
import {
  EMAIL_USERNAME_ROUTE_V1,
  emailUsernameProblemV1,
  inboundEmailViewV1,
  INBOUND_EMAIL_ROUTE_V1,
  normalizeSenderAddressV1,
  type EmailUsernameViewV1,
  type InboundEmailStateV1,
} from "./shared.js";

export type InboundEmailCommandOutcomeV1 =
  { status: "applied" } | { status: "rejected"; reason: string };

export interface InboundEmailGatewayHostV1 {
  /** Absent: this deployment receives no email, and the pages say so. */
  inboundEmailDomain?: string;
  /** The User's verified sign-in address, when the identity has one. */
  inboundEmailSignIn(userId: string): Promise<string | undefined>;
  readEmailUsername(userId: string): Promise<string | undefined>;
  /** Claim a username for the User, or give theirs up with `undefined`. */
  claimEmailUsername(
    userId: string,
    username: string | undefined,
  ): Promise<{ status: "claimed" } | { status: "taken" }>;
  readInboundEmail(userId: string, botId: string): Promise<InboundEmailStateV1>;
  setInboundEmailReceiving(
    userId: string,
    botId: string,
    receiving: boolean,
  ): Promise<InboundEmailCommandOutcomeV1>;
  commandInboundEmailSender(
    userId: string,
    command: {
      action: "add" | "remove";
      address: string;
      signInEmail?: string;
    },
  ): Promise<InboundEmailCommandOutcomeV1>;
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

const UNAVAILABLE = "Email isn’t set up on this deployment.";

export function createInboundEmailBackendContribution(
  host: InboundEmailGatewayHostV1,
): InboundEmailBackendRouteContribution {
  async function usernameView(userId: string): Promise<Response> {
    const username = await host.readEmailUsername(userId);
    return Response.json(
      {
        schemaVersion: 1,
        available: host.inboundEmailDomain !== undefined,
        ...(host.inboundEmailDomain ? { domain: host.inboundEmailDomain } : {}),
        ...(username ? { username } : {}),
      } satisfies EmailUsernameViewV1,
      { headers: NO_STORE },
    );
  }

  async function botView(userId: string, botId: string): Promise<Response> {
    const [state, signInEmail, username] = await Promise.all([
      host.readInboundEmail(userId, botId),
      host.inboundEmailSignIn(userId),
      host.readEmailUsername(userId),
    ]);
    return Response.json(
      inboundEmailViewV1(state, {
        ...(host.inboundEmailDomain ? { domain: host.inboundEmailDomain } : {}),
        ...(username ? { username } : {}),
        ...(signInEmail ? { signInEmail } : {}),
        now: Date.now(),
      }),
      { headers: NO_STORE },
    );
  }

  async function username(request: Request, userId: string): Promise<Response> {
    if (request.method === "GET") return usernameView(userId);
    if (request.method !== "POST") return jsonError(405, "method not allowed");
    const body = await readBody(request);
    if (body.username === null) {
      await host.claimEmailUsername(userId, undefined);
      return usernameView(userId);
    }
    if (!host.inboundEmailDomain) return jsonError(503, UNAVAILABLE);
    const wanted =
      typeof body.username === "string"
        ? body.username.trim().toLowerCase()
        : undefined;
    const problem = emailUsernameProblemV1(wanted);
    if (problem) return jsonError(400, problem);
    const claim = await host.claimEmailUsername(userId, wanted);
    if (claim.status === "taken") {
      return jsonError(409, "That username is taken. Choose another.");
    }
    return usernameView(userId);
  }

  async function bot(
    request: Request,
    userId: string,
    botId: string,
    tail: string,
  ): Promise<Response> {
    if (tail === "") {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      return botView(userId, botId);
    }
    if (request.method !== "POST") return jsonError(405, "method not allowed");
    const body = await readBody(request);
    if (tail === "/switch") {
      if (typeof body.receiving !== "boolean") {
        return jsonError(400, "receiving must be true or false");
      }
      if (body.receiving && !host.inboundEmailDomain) {
        return jsonError(503, UNAVAILABLE);
      }
      const outcome = await host.setInboundEmailReceiving(
        userId,
        botId,
        body.receiving,
      );
      if (outcome.status === "rejected") return jsonError(409, outcome.reason);
      return botView(userId, botId);
    }
    if (tail === "/senders") {
      const action = body.action;
      if (action !== "add" && action !== "remove") {
        return jsonError(400, "action must be add or remove");
      }
      const address = normalizeSenderAddressV1(body.address);
      if (!address) {
        return jsonError(400, "Enter an email address, like you@example.com.");
      }
      const signInEmail =
        action === "add" ? await host.inboundEmailSignIn(userId) : undefined;
      const outcome = await host.commandInboundEmailSender(userId, {
        action,
        address,
        ...(signInEmail ? { signInEmail } : {}),
      });
      if (outcome.status === "rejected") return jsonError(409, outcome.reason);
      return botView(userId, botId);
    }
    return jsonError(404, "not found");
  }

  return {
    packageId: "email",
    async route(request, url, context) {
      const isUsername = url.pathname === EMAIL_USERNAME_ROUTE_V1;
      const match = isUsername
        ? null
        : url.pathname.match(INBOUND_EMAIL_ROUTE_V1);
      if (!isUsername && !match) return undefined;
      const userId = context.userId;
      if (!userId) return jsonError(401, "authentication required");
      try {
        if (isUsername) return await username(request, userId);
        let botId: string;
        try {
          botId = decodeBotIdV1(decodeURIComponent(match![1]!), "bot id");
        } catch {
          return jsonError(400, "invalid bot id");
        }
        return await bot(request, userId, botId, match![2] ?? "");
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
