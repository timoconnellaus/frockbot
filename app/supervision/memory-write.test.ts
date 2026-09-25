import { expect, test } from "bun:test";
import {
  composeMemoryWriteVerdictV1,
  memoryWriteQuestionsV1,
} from "./memory-write.js";

const kept = [
  { id: "a", text: "Tim drinks flat whites." },
  { id: "b", text: "Tim lives in Wollongong." },
];
const relation = (label: string, p: number) => ({
  choice: label,
  probabilities: { [label]: p },
});

test("lasting is asked only of a profile fact, and one relation per kept fact", () => {
  expect(
    Object.keys(
      memoryWriteQuestionsV1({ fact: "x", tier: "profile", candidates: kept }),
    ),
  ).toEqual(["secret", "lasting", "k0", "k1"]);
  expect(
    Object.keys(
      memoryWriteQuestionsV1({ fact: "x", tier: "log", candidates: [] }),
    ),
  ).toEqual(["secret"]);
});

test("a secret is refused before anything else is weighed", () => {
  expect(
    composeMemoryWriteVerdictV1(
      { fact: "x", tier: "profile", candidates: kept },
      { secret: { noul: 0.9 }, k0: relation("same", 0.99) },
    ),
  ).toEqual({ action: "refuse-secret" });
});

test("a sure match writes nothing; a sure update replaces the one it updates", () => {
  const evidence = { fact: "x", tier: "profile" as const, candidates: kept };
  expect(
    composeMemoryWriteVerdictV1(evidence, {
      secret: { noul: 0 },
      k0: relation("same", 0.9),
    }),
  ).toEqual({ action: "already-kept", id: "a" });
  expect(
    composeMemoryWriteVerdictV1(evidence, {
      secret: { noul: 0 },
      k0: relation("unrelated", 0.9),
      k1: relation("updates", 0.8),
    }),
  ).toEqual({ action: "write", tier: "profile", replaces: kept[1] });
  // Unsure is written as asked.
  expect(
    composeMemoryWriteVerdictV1(evidence, {
      secret: { noul: 0 },
      k0: relation("updates", 0.6),
      k1: relation("same", 0.7),
    }),
  ).toEqual({ action: "write", tier: "profile" });
});

test("a passing profile fact is kept as a log entry", () => {
  expect(
    composeMemoryWriteVerdictV1(
      { fact: "x", tier: "profile", candidates: [] },
      { secret: { noul: 0 }, lasting: { noul: 0.1 } },
    ),
  ).toEqual({ action: "write", tier: "log" });
});
