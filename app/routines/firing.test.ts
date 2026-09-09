import { describe, expect, test } from "bun:test";
import { isPublicIdentifier } from "@frockbot/core/configuration";
import {
  ROUTINE_FIRE_ID_MAX_LENGTH,
  routineFireIdV1,
} from "@frockbot/app/routines/firing";
import { isMessageBoundaryV1 } from "@frockbot/app/shell/unread";
import { messageIdV1 } from "@frockbot/app/notifications/messages";

const LONG_ROUTINE_ID = "r".repeat(120);
const LONG_DISCRIMINATOR = "d".repeat(80);

describe("the id a firing is admitted under", () => {
  test("an ordinary firing keeps the id its occurrence names", () => {
    expect(routineFireIdV1("brief", "1767225600000")).toBe(
      "rf-brief-1767225600000",
    );
  });

  test("even the longest Routine and occurrence mint a usable run id", () => {
    const fireId = routineFireIdV1(LONG_ROUTINE_ID, LONG_DISCRIMINATOR);
    // A fire id *is* the run id, and a run the kernel cannot admit is a
    // Routine that can never fire.
    expect(isPublicIdentifier(fireId)).toBe(true);
    expect(fireId.length).toBeLessThanOrEqual(ROUTINE_FIRE_ID_MAX_LENGTH);
    // And the message that firing produces is nameable by the unread record
    // that has to survive being read back.
    expect(isMessageBoundaryV1(messageIdV1(fireId, 0))).toBe(true);
  });

  test("two occurrences of one long-named Routine keep separate ids", () => {
    // Truncating alone would give both the same id, and the kernel would
    // refuse the second occurrence as a replay of the first.
    expect(routineFireIdV1(LONG_ROUTINE_ID, "1767225600000")).not.toBe(
      routineFireIdV1(LONG_ROUTINE_ID, "1767225660000"),
    );
    expect(routineFireIdV1(`${LONG_ROUTINE_ID}a`, LONG_DISCRIMINATOR)).not.toBe(
      routineFireIdV1(`${LONG_ROUTINE_ID}b`, LONG_DISCRIMINATOR),
    );
  });

  test("the same occurrence mints the same id, so a retry is a replay", () => {
    expect(routineFireIdV1(LONG_ROUTINE_ID, LONG_DISCRIMINATOR)).toBe(
      routineFireIdV1(LONG_ROUTINE_ID, LONG_DISCRIMINATOR),
    );
  });
});
