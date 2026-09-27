import { join } from "node:path";

/** This checkout, whose own profiles are FrockBot's deployments. */
export const REPO_ROOT_V1 = join(import.meta.dirname, "..", "..");
export const PROFILE_DIRECTORY_V1 = join(REPO_ROOT_V1, "deployments");
