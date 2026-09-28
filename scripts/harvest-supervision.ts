// Turns a recorded run into candidate eval cases for labelling.
//
//   .claude/skills/frockbot-debug/scripts/debug.sh run <user> <bot> <run> > run.json
//   bun scripts/harvest-supervision.ts run.json [more.json ...]
//
// Writes `.eval-results/harvest-<runId>.json` (gitignored: it holds the run's
// own content) and prints one line per decision, so the ones worth a case are
// easy to pick. Nothing is sent anywhere.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { harvestRunV1, type HarvestRunV1 } from "../app/evals/harvest.ts";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error(
    "usage: bun scripts/harvest-supervision.ts <debug run json>...",
  );
  process.exit(2);
}
await mkdir(".eval-results", { recursive: true });
for (const path of paths) {
  const snapshot = JSON.parse(await readFile(path, "utf8")) as {
    runs: HarvestRunV1[];
  };
  for (const run of snapshot.runs) {
    const cases = harvestRunV1(run);
    const out = `.eval-results/harvest-${run.runId}.json`;
    await writeFile(out, JSON.stringify(cases, null, 2));
    if (run.omittedEvents)
      console.log(
        `${run.runId}: the snapshot omitted its ${run.omittedEvents} oldest events`,
      );
    for (const harvested of cases) {
      const decision = harvested.recorded as {
        decision?: string;
        reasonCode?: string;
        kind?: string;
        judgments?: { question: string; answer?: string; value: number }[];
      };
      const judged = (decision.judgments ?? [])
        .map(
          (j) =>
            `${j.question}=${j.answer ?? ""}${j.answer ? ":" : ""}${Math.round(j.value * 100) / 100}`,
        )
        .join(" ");
      const label =
        harvested.kind === "call"
          ? `call ${harvested.tool}${harvested.evidence ? "" : " (no arguments in the journal)"} ${decision.decision}/${decision.reasonCode}`
          : `step ${decision.kind ?? ""}`;
      console.log(`  ${harvested.turn}:${harvested.step} ${label} ${judged}`);
    }
    console.log(`${cases.length} candidates -> ${out}`);
  }
}
