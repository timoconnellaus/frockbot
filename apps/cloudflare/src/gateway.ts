import type {
  GatewayDependencies,
  UserApplicationIdentity,
  WorkerCode,
} from "./contracts.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

export function applicationDeploymentId(
  identity: UserApplicationIdentity,
): string {
  if (!ID_PATTERN.test(identity.userId)) {
    throw new Error("invalid user id");
  }
  if (!HASH_PATTERN.test(identity.applicationHash)) {
    throw new Error("invalid application hash");
  }
  return `${identity.userId}:${identity.applicationHash}`;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

interface DevelopmentIdentity {
  userId?: string;
  persist: boolean;
}

function developmentIdentity(request: Request): DevelopmentIdentity {
  const header = request.headers.get("x-frockbot-user-id")?.trim();
  if (header) return { userId: header, persist: false };

  try {
    const query = new URL(request.url).searchParams.get("as_user")?.trim();
    if (query) return { userId: query, persist: true };
  } catch {
    return { persist: false };
  }

  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("frockbot_dev_user="));
  return {
    userId: cookie?.slice("frockbot_dev_user=".length),
    persist: false,
  };
}

export function createGateway(dependencies: GatewayDependencies) {
  const compatibilityDate = dependencies.compatibilityDate ?? "2026-08-27";

  return async (request: Request): Promise<Response> => {
    // Development identity seam. Production auth must replace the header/query/
    // cookie mechanism at the gateway before this handler is exposed publicly.
    const development = developmentIdentity(request);
    const userId = development.userId;
    if (!userId) return jsonError(401, "missing development user identity");

    let applicationHash: string;
    let workerId: string;
    try {
      applicationHash = await dependencies.applicationHashFor(userId);
      workerId = applicationDeploymentId({ userId, applicationHash });
    } catch (error) {
      return jsonError(
        400,
        error instanceof Error ? error.message : "invalid deployment",
      );
    }

    const identity = { userId, applicationHash };
    const worker = dependencies.loader.get(workerId, async () => {
      const source = await dependencies.artifacts.load(applicationHash);
      const code: WorkerCode = {
        compatibilityDate,
        mainModule: "index.js",
        modules: { "index.js": { js: source } },
        globalOutbound: null,
        env: {
          BOT_STATE: dependencies.botStateFor(userId),
          DEPLOYMENT: identity,
        },
        limits: { cpuMs: 30_000, subRequests: 1_000 },
      };
      return code;
    });

    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.delete("x-frockbot-user-id");
    forwardedHeaders.set("x-frockbot-deployment", workerId);
    const response = await worker
      .getEntrypoint()
      .fetch(new Request(request, { headers: forwardedHeaders }));
    if (!development.persist) return response;
    const persisted = new Response(response.body, response);
    persisted.headers.append(
      "set-cookie",
      `frockbot_dev_user=${userId}; Path=/; HttpOnly; SameSite=Strict`,
    );
    return persisted;
  };
}
