import { describe, expect, test } from "bun:test";
import { isTaskIdV1 } from "@frockbot/app/subagents/records";
import { subagentTaskIdV1 } from "./durable-binding.js";

describe("subagentTaskIdV1", () => {
  test("mints the same task id when the same call is replayed", async () => {
    const id = await subagentTaskIdV1("run-chat", "tool:1:1:0");
    expect(isTaskIdV1(id)).toBe(true);
    expect(await subagentTaskIdV1("run-chat", "tool:1:1:0")).toBe(id);
  });

  test("mints another task id for the same effect in another run", async () => {
    // Effect ids restart in every Session: a Routine Turn's first call is
    // `tool:1:1:0` exactly as the conversation's first call was.
    expect(await subagentTaskIdV1("run-chat", "tool:1:1:0")).not.toBe(
      await subagentTaskIdV1("run-routine", "tool:1:1:0"),
    );
  });
});
