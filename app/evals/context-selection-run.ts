import { TypeSafeClient } from "@typesafe-ai/sdk";
import { contextFixturesV1, runContextCaseV1 } from "./context-selection.js";

const apiKey = (
  process.env.JEV_API_KEY ??
  process.env.TYPESAFE_API_KEY ??
  ""
).trim();
if (!apiKey) {
  console.error(
    "Set JEV_API_KEY, or TYPESAFE_API_KEY, in the main checkout's .dev.vars",
  );
  process.exit(2);
}
const client = new TypeSafeClient({
  apiKey,
  defaultModel: "jev-1.13.0",
  retry: { maxRetries: 0 },
  timeout: 30_000,
  logLevel: "off",
});
let passed = 0;
for (const fixture of contextFixturesV1) {
  const result = await runContextCaseV1(client, fixture);
  if (result.passed) passed++;
  console.log(`${result.passed ? "PASS" : "FAIL"} ${fixture.name}`);
  if (!result.passed)
    console.log(`  expected ${result.expected}, got ${result.actual}`);
}
console.log(`${passed}/${contextFixturesV1.length} cases passed`);
process.exitCode = passed === contextFixturesV1.length ? 0 : 1;
