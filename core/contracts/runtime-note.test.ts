import { expect, test } from "bun:test";
import { appendRuntimeNoteV1 } from "./runtime-note.js";
import type { NormalizedModelRequest } from "./types.js";

const request = {
  requestId: "r",
  provider: "p",
  model: "m",
  system: "s",
  messages: [{ role: "user", content: "Hello." }],
  tools: [],
} as NormalizedModelRequest;

test("notes share one trailing message, and never touch what came before", () => {
  const once = appendRuntimeNoteV1(request, "[FrockBot runtime: a]\nFirst.");
  const twice = appendRuntimeNoteV1(once, "[FrockBot runtime: b]\nSecond.");
  expect(twice.messages).toEqual([
    { role: "user", content: "Hello." },
    {
      role: "user",
      content:
        "[FrockBot runtime: a]\nFirst.\n\n[FrockBot runtime: b]\nSecond.",
    },
  ]);
  expect(twice.system).toBe(request.system);
  expect(request.messages).toHaveLength(1);
});
