import { requiredEvalJevClientV1 } from "./jev-client.js";
import { contextFixturesV1, runContextCaseV1 } from "./context-selection.js";

const client = requiredEvalJevClientV1(process.env, {
  defaultModel: "jev-1.13.0",
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
