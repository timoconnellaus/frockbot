// The authenticated Computer presence routes. The gateway owns no Computer
// state: it decodes one exact DTO, proves User-to-Bot membership through its
// host, and forwards to the Bot Durable Object that owns the records.
import type { Plugin } from "cordis";
import {
  ComputerProtocolDecodeError,
  decodeComputerCommandResponse,
  decodeComputerCommandV1,
  decodeComputerProjectionV1,
  type ComputerCommandResponse,
  type ComputerCommandV1,
  type ComputerProjectionV1,
} from "./protocol.js";

export interface ComputerGatewayHost {
  readComputer(userId: string, botId: string): Promise<ComputerProjectionV1>;
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
      const command = /^\/api\/bots\/([^/]+)\/computer\/commands$/.exec(
        url.pathname,
      );
      const match = read ?? command;
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

export function createComputerBackendPlugin(
  host: ComputerGatewayHost,
  lifecycle: { mount(value: ComputerBackendRouteContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createComputerBackendContribution(host));
}
