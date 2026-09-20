// The deployment-profile TypeScript type is FromSchema of this document.
// JSON modules widen `const`/`enum`, so FromSchema cannot read the `.json`
// import; this writes the same object as a TS `as const` literal.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "deployments/profile.schema.json");
const outputPath = resolve(
  root,
  "scripts/deployment-config/profile-schema.generated.ts",
);

const schema = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
const code = await format(
  `import type { FromSchema } from "json-schema-to-ts";

export const DEPLOYMENT_PROFILE_SCHEMA_V1 = ${JSON.stringify(schema, null, 2)} as const;

export type DeploymentProfileV1 = FromSchema<
  typeof DEPLOYMENT_PROFILE_SCHEMA_V1,
  { parseIfThenElseKeywords: true }
>;
`,
  { parser: "typescript", printWidth: 80 },
);

if (process.argv.includes("--check")) {
  const current = readFileSync(outputPath, "utf8");
  if (current !== code) {
    console.error(
      "Deployment profile schema types are stale; run `bun scripts/generate-deployment-profile-schema.ts`.",
    );
    process.exit(1);
  }
  console.log("Deployment profile schema types are fresh.");
} else {
  await Bun.write(outputPath, code);
  console.log("Generated the deployment profile schema types.");
}
