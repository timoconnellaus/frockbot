// The authenticated Computer presence routes. The gateway owns no Computer
// state: it decodes one exact DTO, proves User-to-Bot membership through its
// host, and forwards to the Bot Durable Object that owns the records.
import {
  ComputerProtocolDecodeError,
  decodeComputerCommandResponse,
  decodeComputerCommandV1,
  decodeComputerProjectionV1,
  type ComputerCommandResponse,
  type ComputerCommandV1,
  type ComputerProjectionV1,
} from "./protocol.js";
import { defineGatewayContribution } from "@frockbot/core/contracts/contributions";

export interface ComputerGatewayHost {
  readComputer(userId: string, botId: string): Promise<ComputerProjectionV1>;
  /** The Bot's current frame when its hash is `contentHash`, else nothing. */
  readComputerFrame(
    userId: string,
    botId: string,
    contentHash: string,
  ): Promise<Uint8Array<ArrayBuffer> | undefined>;
  executeComputerCommand(
    userId: string,
    botId: string,
    command: ComputerCommandV1,
  ): Promise<ComputerCommandResponse>;
}

export interface ComputerBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

export class ComputerBotNotFoundError extends Error {
  override readonly name = "ComputerBotNotFoundError";
}

function missingBot(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "ComputerBotNotFoundError" ||
      error.name === "BotNotFoundError")
  );
}

function errorResponse(error: unknown): Response {
  if (missingBot(error)) {
    return Response.json(
      { error: "Computer not found", code: "bot-not-found", definitive: true },
      { status: 404 },
    );
  }
  if (
    error instanceof ComputerProtocolDecodeError ||
    error instanceof SyntaxError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ComputerProtocolDecodeError")
  ) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Computer request is invalid",
        code: "invalid-request",
        definitive: true,
      },
      { status: 400 },
    );
  }
  return Response.json(
    {
      error: error instanceof Error ? error.message : "Computer request failed",
    },
    { status: 500 },
  );
}

function pathId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ComputerProtocolDecodeError("Computer botId is invalid");
  }
  if (!decoded.trim() || decoded.length > 200) {
    throw new ComputerProtocolDecodeError("Computer botId is invalid");
  }
  return decoded;
}

export function createComputerBackendContribution(
  host: ComputerGatewayHost,
): ComputerBackendRouteContribution {
  return {
    packageId: "computer",
    async route(request, url, context) {
      if (!context.userId) return undefined;
      const read = /^\/api\/bots\/([^/]+)\/computer$/.exec(url.pathname);
      const frame =
        /^\/api\/bots\/([^/]+)\/computer\/frame\/([0-9a-f]{64})$/.exec(
          url.pathname,
        );
      const command = /^\/api\/bots\/([^/]+)\/computer\/commands$/.exec(
        url.pathname,
      );
      const match = read ?? frame ?? command;
      if (!match) return undefined;
      if ([...url.searchParams.keys()].length > 0) {
        return errorResponse(
          new ComputerProtocolDecodeError(
            "Computer routes take no query parameters",
          ),
        );
      }
      try {
        const encodedBotId = match[1];
        if (encodedBotId === undefined) {
          throw new ComputerProtocolDecodeError("Computer botId is invalid");
        }
        const botId = pathId(encodedBotId);
        if (frame) {
          if (request.method !== "GET") {
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          }
          const bytes = await host.readComputerFrame(
            context.userId,
            botId,
            frame[2]!,
          );
          if (!bytes) {
            // Replaced since the projection named it; the card reads again.
            return Response.json(
              { error: "That frame is no longer current", code: "stale" },
              { status: 404 },
            );
          }
          return new Response(bytes, {
            headers: {
              "content-type": "image/png",
              // The URL is the frame's hash, so its bytes never change.
              "cache-control": "private, max-age=31536000, immutable",
            },
          });
        }
        if (read) {
          if (request.method !== "GET") {
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          }
          return Response.json(
            decodeComputerProjectionV1(
              await host.readComputer(context.userId, botId),
            ),
          );
        }
        if (request.method !== "POST") {
          return Response.json(
            { error: "method not allowed" },
            { status: 405 },
          );
        }
        const decoded = decodeComputerCommandV1(await request.json());
        if (decoded.botId !== botId) {
          throw new ComputerProtocolDecodeError(
            "Computer command does not match the request path",
          );
        }
        return Response.json(
          decodeComputerCommandResponse(
            await host.executeComputerCommand(context.userId, botId, decoded),
          ),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

/**
 * The manifest's gateway `backend` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const backendContribution = defineGatewayContribution<
  ComputerGatewayHost,
  ComputerBackendRouteContribution
>({
  specifier: "@frockbot/computer/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createComputerBackendContribution(host)),
});
