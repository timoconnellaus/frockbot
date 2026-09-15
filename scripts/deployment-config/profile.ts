import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";

export const REPO_ROOT_V1 = join(import.meta.dirname, "..", "..");
export const PROFILE_DIRECTORY_V1 = join(REPO_ROOT_V1, "deployments");

export interface DeploymentWorkerV1 {
  name?: string;
  hostnames?: readonly string[];
}

/**
 * Where the container Workers get their image. Building from the Dockerfile
 * needs Docker on the deploying machine; pulling a published one does not,
 * which is the whole reason `bun run setup` can deploy into an account that has
 * never built an image (ADR 0028 steps 4 and 5).
 */
export type DeploymentImagesV1 =
  | { source: "dockerfile" }
  | { source: "registry"; registry: string; tag: string };

export interface DeploymentProfileV1 {
  schemaVersion: 1;
  name: string;
  accountId: string;
  region?: string;
  prefix: string;
  authPackage: "better-auth" | "access";
  workers?: {
    app?: DeploymentWorkerV1;
    computerHost?: DeploymentWorkerV1;
    appletBuild?: DeploymentWorkerV1;
    marketing?: DeploymentWorkerV1;
    adminPortal?: DeploymentWorkerV1;
  };
  artifactHostname?: string;
  images?: DeploymentImagesV1;
  access?: { teamDomain: string; aud: string };
  adminEmails?: readonly string[];
  d1DatabaseId?: string;
  aiGateway?: { accountId: string; id?: string; autoRoute?: string };
  nativeAuth?: "android" | "android,macos";
  resources?: {
    applicationArtifactsBucket?: string;
    memoryFilesBucket?: string;
    memoryIndex?: string;
    authDatabaseName?: string;
  };
}

/**
 * The schema is the contract, so it is the thing that refuses a bad profile —
 * not a hand-written check that drifts from it.
 */
export function validateProfileV1(value: unknown, what: string): void {
  const schema: unknown = JSON.parse(
    readFileSync(join(PROFILE_DIRECTORY_V1, "profile.schema.json"), "utf8"),
  );
  // Ajv ships a CommonJS default export; under this project's ESM resolution
  // the constructor is one property in.
  const AjvConstructor = ((Ajv as unknown as { default?: typeof Ajv })
    .default ?? Ajv) as typeof Ajv;
  const ajv = new AjvConstructor({ allErrors: true, strict: true });
  const validate = ajv.compile(schema as object);
  if (validate(value)) return;
  const detail = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
    .join("; ");
  throw new Error(`${what} is not a deployment profile: ${detail}`);
}

export function loadProfileV1(name: string): DeploymentProfileV1 {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`"${name}" is not a profile name`);
  }
  const file = join(PROFILE_DIRECTORY_V1, `${name}.json`);
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No deployment profile at ${file}`);
  }
  const profile: unknown = JSON.parse(source);
  validateProfileV1(profile, file);
  const loaded = profile as DeploymentProfileV1;
  if (loaded.name !== name) {
    throw new Error(
      `${file} names the profile "${loaded.name}"; a profile's name is its file name`,
    );
  }
  return loaded;
}
