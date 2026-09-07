import { expect, test } from "bun:test";
import type { ViewNode } from "@frockbot/core/protocol-schemas";
import {
  routineMomentV1,
  routinesDocumentV1,
  routinesRevisionV1,
  type RoutinesFrameV1,
} from "./routines-document.js";
import type { RoutineInboxEntryViewV1, RoutineViewV1 } from "./shared.js";

function walk(node: ViewNode): ViewNode[] {
  return node.type === "group"
    ? [node, ...node.children.flatMap((child) => walk(child))]
    : [node];
}

const morning: RoutineViewV1 = {
  schemaVersion: 1,
  routineId: "r1",
  name: "Morning brief",
  prompt: "Summarise overnight email.",
  schedule: "0 9 * * *",
  timezone: "Australia/Sydney",
  enabled: true,
  createdBy: { kind: "user" },
  updatedBy: { kind: "user" },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastRunAt: "2026-09-02T23:00:00.000Z",
  nextRunAt: "2026-09-03T23:00:00.000Z",
};

const completion: RoutineInboxEntryViewV1 = {
  schemaVersion: 1,
  entryId: "e1",
  runId: "run-1",
  routineId: "r1",
  text: "Nine unread, two need you.",
  attribution: "Morning brief",
  createdAt: "2026-09-02T23:00:10.000Z",
  acknowledged: false,
};

function frame(over: Partial<RoutinesFrameV1> = {}): RoutinesFrameV1 {
  return {
    schemaVersion: 1,
    botId: "bot-1",
    routines: [morning],
    inbox: [completion],
    unacknowledged: 1,
    ...over,
  };
}

test("a Routine says what it fires on and when it last did and next will", () => {
  const document = routinesDocumentV1(frame());
  const facts = walk(document.root).find(
    (node) =>
      node.type === "text" &&
      node.style === "status" &&
      node.text.includes("0 9 * * *"),
  );
  expect(facts?.type === "text" && facts.text).toBe(
    "0 9 * * * · Australia/Sydney · Last 3 Sep 2026, 9:00am · Next 4 Sep 2026, 9:00am",
  );
  expect(document.surfaceId).toBe("routines");
});

test("every control names the command it means", () => {
  const document = routinesDocumentV1(frame());
  const actions = walk(document.root).filter((node) => node.type === "action");
  expect(
    actions.map((node) => (node.type === "action" ? node.input?.kind : "")),
  ).toEqual([
    "set-routine-enabled",
    "run-routine",
    "open-runs",
    "delete-routine",
    "acknowledge-inbox",
    "acknowledge-inbox",
  ]);
  expect(document.actions.map((action) => action.id).sort()).toEqual([
    "acknowledge-inbox",
    "delete-routine",
    "open-runs",
    "run-routine",
    "set-routine-enabled",
  ]);
});

test("a paused Routine offers Resume and promises no next firing", () => {
  const document = routinesDocumentV1(
    frame({
      routines: [{ ...morning, enabled: false, nextRunAt: undefined }],
    }),
  );
  const nodes = walk(document.root);
  const toggle = nodes.find(
    (node) => node.type === "action" && node.actionId === "set-routine-enabled",
  );
  expect(toggle?.type === "action" && toggle.label).toBe("Resume");
  expect(toggle?.type === "action" && toggle.input?.enabled).toBe(true);
  expect(
    nodes.some((node) => node.type === "text" && node.text.endsWith("Paused")),
  ).toBe(true);
});

test("Mark all read carries no entry, and an acknowledged entry offers nothing", () => {
  const document = routinesDocumentV1(
    frame({
      inbox: [completion, { ...completion, entryId: "e2", acknowledged: true }],
    }),
  );
  const acknowledgements = walk(document.root).filter(
    (node) => node.type === "action" && node.actionId === "acknowledge-inbox",
  );
  expect(
    acknowledgements.map((node) =>
      node.type === "action" ? node.input?.entryId : "",
    ),
  ).toEqual(["e1", undefined]);
  // The "all" action declares no entry, so the host acknowledges what it read.
  expect(
    document.actions.find((action) => action.id === "acknowledge-inbox")?.schema
      .required,
  ).toEqual(["kind"]);
});

test("an empty Bot says so on both halves rather than drawing nothing", () => {
  const document = routinesDocumentV1(
    frame({ routines: [], inbox: [], unacknowledged: 0 }),
  );
  const text = walk(document.root)
    .filter((node) => node.type === "text")
    .map((node) => (node.type === "text" ? node.text : ""));
  expect(text[0]).toBe("0 Routines");
  expect(text.some((line) => line.startsWith("No Routines yet."))).toBe(true);
  expect(text.some((line) => line.startsWith("Nothing here yet."))).toBe(true);
});

test("the revision moves only when what the document says changes", () => {
  expect(routinesRevisionV1(frame())).toBe(routinesRevisionV1(frame()));
  expect(routinesRevisionV1(frame())).not.toBe(
    routinesRevisionV1(frame({ routines: [{ ...morning, enabled: false }] })),
  );
});

test("a moment is read in the Routine's own zone, and an unknown zone is UTC", () => {
  expect(routineMomentV1("2026-09-03T23:00:00.000Z", "Australia/Sydney")).toBe(
    "4 Sep 2026, 9:00am",
  );
  expect(routineMomentV1("2026-09-03T23:00:00.000Z", "Mars/Olympus")).toBe(
    "3 Sep 2026, 11:00pm",
  );
});

test("more Routines than the renderer's budget stop, and the document says so", () => {
  const many = Array.from({ length: 200 }, (_, index) => ({
    ...morning,
    routineId: `r${index}`,
    name: `Routine ${index}`,
  }));
  const document = routinesDocumentV1(
    frame({ routines: many, inbox: [], unacknowledged: 0 }),
  );
  expect(walk(document.root).length).toBeLessThanOrEqual(512);
  expect(
    walk(document.root).some(
      (node) => node.type === "text" && node.text.includes("need a newer app"),
    ),
  ).toBe(true);
});
