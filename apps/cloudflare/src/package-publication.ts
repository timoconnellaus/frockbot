import type { PackagePublisherUserHost } from "@frockbot/plugin-package-publisher/user";
import type {
  UserApplicationEnv,
  WorkerCode,
  WorkerLoader,
} from "./contracts.js";

interface PublicationEnvironment {
  APPLICATION_ARTIFACTS: R2Bucket;
  USER_APPLICATIONS: WorkerLoader;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function candidateHash(input: {
  source: string;
  applicationArtifact: string;
}): Promise<string> {
  const encoded = new TextEncoder().encode(
    `${input.source.length}:${input.source}${input.applicationArtifact}`,
  );
  return `sha256:${hex(await crypto.subtle.digest("SHA-256", encoded))}`;
}

async function putImmutable(
  bucket: R2Bucket,
  key: string,
  value: string,
): Promise<void> {
  const existing = await bucket.get(key);
  if (existing) {
    if ((await existing.text()) !== value) {
      throw new Error(`immutable artifact collision at ${key}`);
    }
    return;
  }
  await bucket.put(key, value);
}

function validManifest(
  value: unknown,
  userId: string,
  applicationHash: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  const deployment = manifest.deployment;
  if (
    !deployment ||
    typeof deployment !== "object" ||
    Array.isArray(deployment)
  ) {
    return false;
  }
  const identity = deployment as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1 ||
    identity.userId !== userId ||
    identity.applicationHash !== applicationHash ||
    typeof manifest.applicationHash !== "string" ||
    !Array.isArray(manifest.packages)
  ) {
    return false;
  }
  return manifest.packages.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const pkg = value as Record<string, unknown>;
    return (
      pkg.id === "package-publisher" &&
      Array.isArray(pkg.contributions) &&
      pkg.contributions.includes("backend") &&
      pkg.contributions.includes("client")
    );
  });
}

async function requireHostedAsset(
  fetch: (request: Request) => Promise<Response>,
  path: string,
  contentType: string,
): Promise<void> {
  const response = await fetch(new Request(`https://verify.invalid${path}`));
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith(contentType) ||
    (await response.arrayBuffer()).byteLength === 0
  ) {
    throw new Error(`candidate health check failed for ${path}`);
  }
}

export function createPackagePublicationHost(
  env: PublicationEnvironment,
  storage: PackagePublisherUserHost["storage"] & {
    setAlarm(scheduledTime: number | Date): Promise<void>;
  },
  compatibilityDate = "2026-08-27",
): PackagePublisherUserHost {
  return {
    storage,
    hash: candidateHash,
    async storeAndVerify({ userId, applicationHash, candidate }) {
      await putImmutable(
        env.APPLICATION_ARTIFACTS,
        `applications/${applicationHash}.mjs`,
        candidate.applicationArtifact,
      );
      await putImmutable(
        env.APPLICATION_ARTIFACTS,
        `application-sources/${applicationHash}.txt`,
        candidate.source,
      );

      const deployment = { userId, applicationHash };
      const worker = env.USER_APPLICATIONS.get(
        `verify:${userId}:${applicationHash}`,
        async () => {
          const code: WorkerCode = {
            compatibilityDate,
            mainModule: "index.js",
            modules: { "index.js": { js: candidate.applicationArtifact } },
            env: {
              // Candidate health must be side-effect free and cannot call Bot state.
              BOT_STATE: {} as UserApplicationEnv["BOT_STATE"],
              DEPLOYMENT: deployment,
            },
            limits: { cpuMs: 30_000, subRequests: 1_000 },
          };
          return code;
        },
      );
      const entrypoint = worker.getEntrypoint();
      const fetch = (request: Request) => entrypoint.fetch(request);
      const response = await fetch(
        new Request("https://verify.invalid/app-manifest"),
      );
      if (!response.ok) {
        throw new Error(`candidate health check returned ${response.status}`);
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error("candidate health check returned an invalid manifest");
      }
      if (!validManifest(value, userId, applicationHash)) {
        throw new Error("candidate health check returned an invalid manifest");
      }
      await Promise.all([
        requireHostedAsset(fetch, "/", "text/html"),
        requireHostedAsset(fetch, "/app.js", "text/javascript"),
        requireHostedAsset(fetch, "/app.css", "text/css"),
      ]);
    },
  };
}
