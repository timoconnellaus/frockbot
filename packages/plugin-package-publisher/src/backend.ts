import type { Plugin } from "cordis";
import {
  PackagePublisherConflictError,
  PackagePublisherDecodeError,
  decodeRollbackPackageCommandV1,
  type PackagePublicationReceiptV1,
  type PackageRevisionHistoryV1,
  type RollbackPackageCommandV1,
} from "./shared.js";

export interface PackagePublisherGatewayHost {
  read(userId: string): Promise<PackageRevisionHistoryV1>;
  rollback(
    userId: string,
    command: RollbackPackageCommandV1,
  ): Promise<PackagePublicationReceiptV1>;
}

export interface PackagePublisherBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

function errorResponse(error: unknown): Response {
  if (
    error instanceof PackagePublisherDecodeError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "PackagePublisherDecodeError")
  ) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "package request is invalid",
        code: "invalid-request",
        definitive: true,
      },
      { status: 400 },
    );
  }
  if (
    error instanceof PackagePublisherConflictError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "PackagePublisherConflictError")
  ) {
    const currentRevision =
      typeof error === "object" &&
      error !== null &&
      "currentRevision" in error &&
      typeof error.currentRevision === "number"
        ? error.currentRevision
        : 0;
    return Response.json(
      {
        error: `package revision is ${currentRevision}`,
        code: "revision-conflict",
        currentRevision,
        definitive: true,
      },
      { status: 409 },
    );
  }
  return Response.json(
    {
      error:
        error instanceof Error ? error.message : "package publication failed",
    },
    { status: 500 },
  );
}

export function createPackagePublisherBackendContribution(
  host: PackagePublisherGatewayHost,
): PackagePublisherBackendRouteContribution {
  return {
    packageId: "package-publisher",
    async route(request, url, context) {
      if (!context.userId) return undefined;
      const revisions = url.pathname === "/api/package-revisions";
      const rollback = url.pathname === "/api/package-revisions/rollback";
      if (!revisions && !rollback) return undefined;
      try {
        if (revisions && request.method === "GET") {
          return Response.json(await host.read(context.userId));
        }
        if (request.method !== "POST") {
          return Response.json(
            { error: "method not allowed" },
            { status: 405 },
          );
        }
        if (rollback) {
          return Response.json(
            await host.rollback(
              context.userId,
              decodeRollbackPackageCommandV1(await request.json()),
            ),
          );
        }
        return Response.json({ error: "method not allowed" }, { status: 405 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export namespace createPackagePublisherBackendContribution {
  export function plugin(
    host: PackagePublisherGatewayHost,
    lifecycle: {
      mount(value: PackagePublisherBackendRouteContribution): () => void;
    },
  ): Plugin {
    return () =>
      lifecycle.mount(createPackagePublisherBackendContribution(host));
  }
}
