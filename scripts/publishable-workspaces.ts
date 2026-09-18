import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const PUBLISHABLE_WORKSPACE_DIRECTORIES_V1 = JSON.parse(
  readFileSync(join(here, "publishable-workspaces.json"), "utf8"),
) as readonly string[];
