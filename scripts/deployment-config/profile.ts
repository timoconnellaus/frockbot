import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import {
  DEPLOYMENT_PROFILE_SCHEMA_V1,
  type DeploymentProfileV1,
} from "./profile-schema.generated.ts";

export const REPO_ROOT_V1 = join(import.meta.dirname, "..", "..");
export const PROFILE_DIRECTORY_V1 = join(REPO_ROOT_V1, "deployments");

export { DEPLOYMENT_PROFILE_SCHEMA_V1, type DeploymentProfileV1 };

export type DeploymentWorkerV1 = NonNullable<
  NonNullable<DeploymentProfileV1["workers"]>["app"]
>;

export type DeploymentImagesV1 = NonNullable<DeploymentProfileV1["images"]>;
export type DeploymentRegionV1 = NonNullable<DeploymentProfileV1["region"]>;

export const DEPLOYMENT_REGIONS_V1 =
  DEPLOYMENT_PROFILE_SCHEMA_V1.properties.region.enum;

export function deploymentRegionV1(value: string): DeploymentRegionV1 {
  if ((DEPLOYMENT_REGIONS_V1 as readonly string[]).includes(value)) {
    return value as DeploymentRegionV1;
  }
  throw new Error(
    `"${value}" is not a deployment region (${DEPLOYMENT_REGIONS_V1.join(", ")})`,
  );
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
