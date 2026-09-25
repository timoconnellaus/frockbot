import { expect, test } from "bun:test";
import type { RoutineReportJudgeV1 } from "@frockbot/app/supervision/routine-report";
import { judgedRoutineDeliveryV1 } from "./bot.js";

const owed = (text: string) => ({
  key: text,
  wake: { title: "Inbox check", text },
});

const judging =
  (
    verdicts: Record<string, { tell: boolean; quiet: boolean } | undefined>,
  ): RoutineReportJudgeV1 =>
  async ({ report }) => {
    const verdict = verdicts[report];
    return verdict ? { ...verdict, worth: 0, urgency: 0 } : undefined;
  };

test("a report nobody needs is dismissed, and one that can wait lands quietly", async () => {
  const result = await judgedRoutineDeliveryV1(
    [owed("No new mail."), owed("Invoice from Acme, due Friday.")],
    judging({
      "No new mail.": { tell: false, quiet: true },
      "Invoice from Acme, due Friday.": { tell: true, quiet: true },
    }),
  );
  expect(result.dismissed.map((entry) => entry.key)).toEqual(["No new mail."]);
  expect(result.told.map((entry) => entry.key)).toEqual([
    "Invoice from Acme, due Friday.",
  ]);
  expect(result.quiet).toBe(true);
});

test("one urgent report makes the whole delivery loud", async () => {
  const result = await judgedRoutineDeliveryV1(
    [owed("Weekly digest."), owed("Your server is down.")],
    judging({
      "Weekly digest.": { tell: true, quiet: true },
      "Your server is down.": { tell: true, quiet: false },
    }),
  );
  expect(result.told).toHaveLength(2);
  expect(result.quiet).toBe(false);
});

test("a report the judge cannot say about is told, loudly, as it always was", async () => {
  expect(
    await judgedRoutineDeliveryV1([owed("Anything.")], judging({})),
  ).toMatchObject({
    told: [{ key: "Anything." }],
    dismissed: [],
    quiet: false,
  });
  expect(
    await judgedRoutineDeliveryV1([owed("Anything.")], undefined),
  ).toMatchObject({ told: [{ key: "Anything." }], quiet: false });
});

test("nothing left to tell is not a quiet delivery, it is no delivery", async () => {
  const result = await judgedRoutineDeliveryV1(
    [owed("No new mail.")],
    judging({ "No new mail.": { tell: false, quiet: true } }),
  );
  expect(result).toMatchObject({ told: [], quiet: false });
});
