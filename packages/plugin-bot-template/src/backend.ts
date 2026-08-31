// The Bot Template gateway Contribution.
//
//   GET  /api/bot-templates          this User's shares
//   POST /api/bot-templates          one template command
//   GET  /templates/v1/:shareId      the published blob, unauthenticated
//
// The last one is the only unauthenticated route in this Package, and it is
// unauthenticated on purpose: a `link` share is a capability URL, and asking
// the recipient to hold an account first would make it something else. It is
// served through the gateway's `publicRoute` seam, which runs before identity,
// and it answers a `private` or revoked share exactly as it answers one that
// never existed — 404, with no body — so the route cannot be probed.
//
// The gateway owns no state here. It carries each request to the User Durable
// Object that is the authority for that User's shares, and the share id names
// which one that is.
import type { Plugin } from "cordis";
import {
  decodeTemplateContentHashV1,
  parseTemplateShareIdV1,
  TemplateDecodeError,
  type TemplateVisibilityV1,
} from "@frockbot/template-core";
import {
  decodeTemplateCommandV1,
  decodeTemplateShareListViewV1,
  decodeTemplateShareReceiptV1,
  type TemplateCommandV1,
  type TemplateShareListViewV1,
  type TemplateShareReceiptV1,
} from "./shared.js";

export interface PublishedTemplateV1 {
  hash: string;
  visibility: TemplateVisibilityV1;
  document: string;
}

export interface BotTemplateGatewayHostV1 {
  listTemplateShares(userId: string): Promise<TemplateShareListViewV1>;
  executeTemplateCommand(
    userId: string,
    command: TemplateCommandV1,
  ): Promise<TemplateShareReceiptV1>;
  /** `undefined` for a share that is missing, private, or revoked, alike. */
  readPublishedTemplate(
    shareId: string,
  ): Promise<PublishedTemplateV1 | undefined>;
}

export interface BotTemplateBackendRouteContribution {
  packageId: string;
  publicRoute(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

const SHARES_PATH = "/api/bot-templates";
const PUBLIC_PREFIX = "/templates/v1/";

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function notFound(): Response {
  return jsonError(404, "template share was not found");
}

function isDecodeError(error: unknown): boolean {
  return (
    error instanceof TemplateDecodeError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "TemplateDecodeError")
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "TemplateShareNotFoundError" ||
      error.name === "BotNotFoundError")
  );
}

function errorResponse(error: unknown): Response {
  if (isMissing(error)) return notFound();
  if (isDecodeError(error)) {
    return jsonError(
      400,
      error instanceof Error ? error.message : "template request is invalid",
    );
  }
  return jsonError(
    500,
    error instanceof Error ? error.message : "template request failed",
  );
}

/**
 * The blob is content-addressed and immutable, so a matched `etag` is the whole
 * answer: the same hash can only ever be the same bytes. Revocation still
 * bites, because the share record is read before the cache header is ever
 * considered.
 */
function templateResponse(
  request: Request,
  found: PublishedTemplateV1,
): Response {
  const etag = `"${decodeTemplateContentHashV1(found.hash)}"`;
  const headers = {
    "content-type": "application/json; charset=utf-8",
    // Never `public`: revoking a share must not leave copies in a shared cache.
    "cache-control": "private, max-age=300, must-revalidate",
    etag,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(found.document, { headers });
}

export function createBotTemplateBackendContribution(
  host: BotTemplateGatewayHostV1,
): BotTemplateBackendRouteContribution {
  return {
    packageId: "bot-template",

    async publicRoute(request, url) {
      if (!url.pathname.startsWith(PUBLIC_PREFIX)) return undefined;
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonError(405, "method not allowed");
      }
      if ([...url.searchParams.keys()].length > 0) {
        return jsonError(400, "the template route takes no query parameters");
      }
      let shareId: string;
      try {
        shareId = decodeURIComponent(url.pathname.slice(PUBLIC_PREFIX.length));
        parseTemplateShareIdV1(shareId);
      } catch {
        // A malformed share id is indistinguishable from a missing one to the
        // caller, so it gets the same answer.
        return notFound();
      }
      try {
        const found = await host.readPublishedTemplate(shareId);
        if (!found) return notFound();
        return templateResponse(request, found);
      } catch (error) {
        if (isMissing(error) || isDecodeError(error)) return notFound();
        return jsonError(
          502,
          error instanceof Error ? error.message : "template read failed",
        );
      }
    },

    async route(request, url, context) {
      if (url.pathname !== SHARES_PATH) return undefined;
      if (!context.userId) return jsonError(401, "authentication required");
      if ([...url.searchParams.keys()].length > 0) {
        return jsonError(400, "the template route takes no query parameters");
      }
      try {
        if (request.method === "GET") {
          return Response.json(
            decodeTemplateShareListViewV1(
              await host.listTemplateShares(context.userId),
            ),
          );
        }
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        const command = decodeTemplateCommandV1(await request.json());
        return Response.json(
          decodeTemplateShareReceiptV1(
            await host.executeTemplateCommand(context.userId, command),
          ),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export namespace createBotTemplateBackendContribution {
  export function plugin(
    host: BotTemplateGatewayHostV1,
    lifecycle: {
      mount(value: BotTemplateBackendRouteContribution): () => void;
    },
  ): Plugin {
    return () => lifecycle.mount(createBotTemplateBackendContribution(host));
  }
}
