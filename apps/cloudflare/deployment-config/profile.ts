import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import {
  DEPLOYMENT_PROFILE_SCHEMA_V1,
  type DeploymentProfileV1 as GeneratedDeploymentProfileV1,
} from "./profile-schema.generated.ts";

/**
 * `@frockbot/cloudflare` itself: where the app Worker's tracked wrangler config
 * is, in this repository and in a consumer's `node_modules` alike.
 */
export const PACKAGE_ROOT_V1 = join(import.meta.dirname, "..");

/** The profile contract, shipped beside the generator that enforces it. */
export const PROFILE_SCHEMA_FILE_V1 = join(
  import.meta.dirname,
  "profile.schema.json",
);

export { DEPLOYMENT_PROFILE_SCHEMA_V1 };

type ProfileWithoutAuthV1 = Omit<
  GeneratedDeploymentProfileV1,
  | "authPackage"
  | "access"
  | "authEnvironment"
  | "payments"
  | "paymentsEnvironment"
>;
type AccessApplicationV1 = NonNullable<GeneratedDeploymentProfileV1["access"]>;
type AuthEnvironmentShapeV1 = NonNullable<
  GeneratedDeploymentProfileV1["authEnvironment"]
>;
type PaymentsEnvironmentShapeV1 = NonNullable<
  GeneratedDeploymentProfileV1["paymentsEnvironment"]
>;

/**
 * A deployment profile, as the schema admits one.
 *
 * `FromSchema` of the schema, with the auth Package's three cases spelled out:
 * `authPackage` may be a path, which `FromSchema` can only read as `string`,
 * and a `string` cannot exclude `"access"` — so the generated type alone would
 * let an Access profile name no Access application. The payments Package's
 * cases are spelled out for the same reason: only a chooser named by path
 * names its environment. The schema's `allOf` says the same thing to ajv,
 * which is what refuses a profile file.
 */
export type DeploymentProfileV1 = ProfileWithoutAuthV1 &
  (
    | {
        payments?: "stripe" | "none";
        paymentsEnvironment?: never;
      }
    | {
        payments: `./${string}` | `../${string}`;
        paymentsEnvironment: PaymentsEnvironmentShapeV1;
      }
  ) &
  (
    | {
        authPackage: "better-auth";
        access?: AccessApplicationV1;
        authEnvironment?: never;
      }
    | {
        authPackage: "access";
        access: AccessApplicationV1;
        authEnvironment?: never;
      }
    | {
        authPackage: `./${string}` | `../${string}`;
        access?: AccessApplicationV1;
        authEnvironment: AuthEnvironmentShapeV1;
      }
  );

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
    readFileSync(PROFILE_SCHEMA_FILE_V1, "utf8"),
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

/** `<profileDirectory>/<name>.json`, validated against the schema. */
export function loadProfileV1(
  name: string,
  profileDirectory: string,
): DeploymentProfileV1 {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`"${name}" is not a profile name`);
  }
  const file = join(profileDirectory, `${name}.json`);
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
