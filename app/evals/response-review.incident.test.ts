import { expect, test } from "bun:test";
import { responseReviewIncidentFixturesV1 } from "./response-review.incident.fixtures.js";

test("the incident and clipping cases hold work to allow and a control to refuse", () => {
  const labels = new Set(
    responseReviewIncidentFixturesV1.map((fixture) => fixture.expected),
  );
  expect([...labels].sort()).toEqual(["on_task", "wrong_objective"]);
});
