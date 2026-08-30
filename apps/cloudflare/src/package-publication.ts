import { type PackagePublisherUserHost } from "@frockbot/plugin-package-publisher/user";
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
    scheduleRecovery: () => storage.setAlarm(Date.now() + 60_000),
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
      const response = await worker
        .getEntrypoint()
        .fetch(new Request("https://verify.invalid/app-manifest"));
      if (!response.ok) {
        throw new Error(`candidate health check returned ${response.status}`);
      }
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("deployment" in value) ||
        !value.deployment ||
        typeof value.deployment !== "object" ||
        Array.isArray(value.deployment) ||
        !("applicationHash" in value.deployment) ||
        value.deployment.applicationHash !== applicationHash
      ) {
        throw new Error("candidate health check returned the wrong deployment");
      }
    },
  };
}
