import { expect, test } from "bun:test";
import type { ViewNode } from "@frockbot/core/protocol-schemas";
import valid from "../../core/protocol-schemas/fixtures/valid.json";
import {
  ROUTINE_DETAIL_FIELDS_V1,
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

const leads: RoutineViewV1 = {
  schemaVersion: 1,
  routineId: "r2",
  name: "Inbound leads",
  prompt: "Triage the lead.",
  trigger: { kind: "webhook" },
  timezone: "Australia/Sydney",
  enabled: true,
  createdBy: { kind: "user" },
  updatedBy: { kind: "user" },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  hookKeyVersion: 2,
};

// The one document the Flutter host reads through its own generated decoder,
// pinned byte for byte: the same fixture is in the shared protocol fixtures,
// which `apps/native/test/protocol_fixtures.dart` validates with the Dart
// evaluator. A projection change that the app's decoder would refuse goes red
// here rather than as "Routines couldn’t load" on a phone. Only the revision
// is left out: it is a hash of the frame, and a number is a number.
test("the projection is the document the shared fixture pins for the app", () => {
  const fixture = valid.find(
    (row) => row.name === "ViewDocument routines projection",
  );
  const document = routinesDocumentV1(
    frame({
      routines: [morning, leads],
      inbox: [
        { ...completion, repeatCount: 3 },
        {
          schemaVersion: 1,
          entryId: "e2",
          runId: "run-2",
          routineId: "r2",
          text: "Lead triaged.",
          attribution: "Inbound leads",
          createdAt: "2026-09-02T23:05:00.000Z",
          acknowledged: true,
          acknowledgedAt: "2026-09-02T23:06:00.000Z",
        },
      ],
      unacknowledged: 1,
    }),
  );
  expect({ ...document, revision: 0 } as unknown).toEqual(
    fixture?.value as unknown,
  );
});

test("a Routine says what it fires on and when it last did and next will", () => {
  const document = routinesDocumentV1(frame());
  const facts = walk(document.root).find(
    (node) =>
      node.type === "text" &&
      node.style === "status" &&
      node.text.includes("Every day at 9:00am"),
  );
  expect(facts?.type === "text" && facts.text).toBe(
    "Every day at 9:00am · Australia/Sydney · Last 3 Sep 2026, 9:00am · Next 4 Sep 2026, 9:00am",
  );
  expect(document.surfaceId).toBe("routines");
});

test("every control names the command it means", () => {
  const document = routinesDocumentV1(frame());
  const actions = walk(document.root).filter((node) => node.type === "action");
  expect(
    actions.map((node) => (node.type === "action" ? node.input?.kind : "")),
  ).toEqual(["open-routine", "set-routine-enabled", "open-run"]);
  expect(document.actions.map((action) => action.id).sort()).toEqual([
    "delete-routine",
    "open-routine",
    "open-run",
    "open-runs",
    "revoke-key",
    "rotate-key",
    "run-routine",
    "set-routine-enabled",
  ]);
  expect(document.actions.some((action) => action.id === "save-routine")).toBe(
    false,
  );
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

test("a completion sits under the Routine that left it, and is not a read status", () => {
  const document = routinesDocumentV1(
    frame({
      inbox: [completion, { ...completion, entryId: "e2", acknowledged: true }],
    }),
  );
  const scheduled =
    document.root.type === "group" ? document.root.children[0] : undefined;
  expect(scheduled?.type === "group" && scheduled.title).toBe("Scheduled");
  const routine =
    scheduled?.type === "group" ? scheduled.children[0] : undefined;
  expect(routine?.type === "group" && routine.title).toBe("Morning brief");
  const runs = walk(routine!).filter(
    (node) => node.type === "action" && node.actionId === "open-run",
  );
  expect(runs).toHaveLength(2);
  expect(runs[0]?.type === "action" && runs[0].input?.entryId).toBe("e1");
  expect(
    walk(document.root).some(
      (node) => node.type === "action" && node.actionId === "acknowledge-inbox",
    ),
  ).toBe(false);
  expect(
    walk(document.root).some(
      (node) => node.type === "group" && node.title === "Completions",
    ),
  ).toBe(false);
});

test("an empty Bot says so on both halves rather than drawing nothing", () => {
  const document = routinesDocumentV1(
    frame({ routines: [], inbox: [], unacknowledged: 0 }),
  );
  const text = walk(document.root)
    .filter((node) => node.type === "text")
    .map((node) => (node.type === "text" ? node.text : ""));
  const titles = walk(document.root)
    .filter((node) => node.type === "group" && node.title !== undefined)
    .map((node) => (node.type === "group" ? node.title : ""));
  // No count line: the sections say what is armed, and a Bot with none says so
  // as a named row rather than as a "0" or a sentence loose on the page.
  expect(text.some((line) => line.startsWith("0 Routines"))).toBe(false);
  expect(titles).toContain("No Routines yet");
  expect(titles).not.toContain("Nothing here yet");
  expect(titles).not.toContain("Completions");
  expect(text).toContain("Ask this Bot to set up a Routine.");
});

test("the revision moves only when what the document says changes", () => {
  expect(routinesRevisionV1(frame())).toBe(routinesRevisionV1(frame()));
  expect(routinesRevisionV1(frame())).not.toBe(
    routinesRevisionV1(frame({ routines: [{ ...morning, enabled: false }] })),
  );
});

test("a moment is read in the Profile zone, and an unknown zone is UTC", () => {
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

test("the list is not a form, and naming a Routine is a read-only detail", () => {
  const list = walk(routinesDocumentV1(frame()).root);
  expect(
    list.some((node) => node.type === "group" && node.title === "New Routine"),
  ).toBe(false);
  expect(list.some((node) => node.type === "field")).toBe(false);

  const open = routinesDocumentV1(frame({ viewing: morning }));
  expect(open.revision).not.toBe(routinesDocumentV1(frame()).revision);
  const fields = walk(open.root).filter((node) => node.type === "field");
  expect(
    fields.map((node) => (node.type === "field" ? node.field.id : "")),
  ).toEqual([
    ROUTINE_DETAIL_FIELDS_V1.name,
    ROUTINE_DETAIL_FIELDS_V1.prompt,
    ROUTINE_DETAIL_FIELDS_V1.timing,
  ]);
  expect(
    fields.every((node) => node.type === "field" && node.field.editable === false),
  ).toBe(true);
  const values = fields.map((node) =>
    node.type === "field" ? node.field.value : null,
  );
  expect(values).toEqual([
    "Morning brief",
    "Summarise overnight email.",
    "Every day at 9:00am · Australia/Sydney",
  ]);
  expect(
    walk(open.root).some(
      (node) => node.type === "group" && node.title === "Scheduled",
    ),
  ).toBe(false);
  expect(
    walk(open.root).some(
      (node) => node.type === "action" && node.actionId === "run-routine",
    ),
  ).toBe(true);
  expect(
    walk(open.root).some(
      (node) => node.type === "action" && node.actionId === "delete-routine",
    ),
  ).toBe(true);
});

test("a connected-app Routine names the event in words and shows config", () => {
  const inbox: RoutineViewV1 = {
    ...morning,
    schedule: undefined,
    trigger: {
      kind: "connection",
      connectionId: "conn-gmail",
      triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
      config: { query: "from:stripe.com" },
    },
    nextRunAt: undefined,
  };
  const fields = walk(routinesDocumentV1(frame({ viewing: inbox })).root)
    .filter((node) => node.type === "field")
    .map((node) =>
      node.type === "field" ? [node.field.id, node.field.value] : [],
    );
  expect(fields).toContainEqual([
    ROUTINE_DETAIL_FIELDS_V1.timing,
    "App event · gmail new gmail message",
  ]);
  expect(fields).toContainEqual([
    ROUTINE_DETAIL_FIELDS_V1.config,
    "query: from:stripe.com",
  ]);
  expect(
    walk(routinesDocumentV1(frame({ viewing: inbox })).root).some(
      (node) => node.type === "action" && node.actionId === "rotate-key",
    ),
  ).toBe(false);
});

test("a webhook Routine offers mint or rotate on the detail", () => {
  const fresh: RoutineViewV1 = {
    ...morning,
    schedule: undefined,
    trigger: { kind: "webhook" },
    nextRunAt: undefined,
  };
  const keyedRoutine = { ...fresh, hookKeyVersion: 2 };
  const actions = (routine: RoutineViewV1) =>
    walk(routinesDocumentV1(frame({ viewing: routine })).root)
      .filter((node) => node.type === "action")
      .map((node) => (node.type === "action" ? node.actionId : ""));
  expect(actions(morning)).not.toContain("rotate-key");
  expect(actions(fresh)).toContain("rotate-key");
  expect(actions(fresh)).not.toContain("revoke-key");
  expect(actions(keyedRoutine)).toEqual(
    expect.arrayContaining(["rotate-key", "revoke-key", "delete-routine"]),
  );
});

test("a minted key is never in the document", () => {
  const document = routinesDocumentV1(
    frame({
      routines: [
        {
          ...morning,
          schedule: undefined,
          trigger: { kind: "webhook" },
          hookKeyVersion: 1,
        },
      ],
    }),
  );
  // The projection is handed a view that has never carried key material; this
  // asserts the shape stays that way as the editor grows.
  expect(JSON.stringify(document)).not.toContain("token");
  expect(JSON.stringify(document)).not.toContain("hookKey");
});

test("a key rotation moves the revision, so the host reads the document again", () => {
  const webhook: RoutineViewV1 = {
    ...morning,
    schedule: undefined,
    trigger: { kind: "webhook" },
    hookKeyVersion: 1,
  };
  expect(routinesRevisionV1(frame({ routines: [webhook] }))).not.toBe(
    routinesRevisionV1(
      frame({ routines: [{ ...webhook, hookKeyVersion: 2 }] }),
    ),
  );
});

test("a Routine is filed under what fires it, and an empty half is not drawn", () => {
  const both = walk(
    routinesDocumentV1(frame({ routines: [morning, leads] })).root,
  );
  const sections = both
    .filter((node) => node.type === "group" && node.title !== undefined)
    .map((node) => (node.type === "group" ? node.title : ""));
  expect(sections).toContain("Scheduled");
  expect(sections).toContain("Webhooks");

  const only = walk(routinesDocumentV1(frame()).root)
    .filter((node) => node.type === "group" && node.title !== undefined)
    .map((node) => (node.type === "group" ? node.title : ""));
  expect(only).toContain("Scheduled");
  expect(only).not.toContain("Webhooks");
});

test("a completion is the same loose row the Bot page draws, under its Routine", () => {
  const document = routinesDocumentV1(frame());
  const scheduled =
    document.root.type === "group" ? document.root.children[0] : undefined;
  const routine =
    scheduled?.type === "group" ? scheduled.children[0] : undefined;
  expect(routine?.type === "group" && routine.title).toBe("Morning brief");
  const entry = walk(routine!).find(
    (node) =>
      node.type === "group" &&
      node.title === "Morning brief" &&
      node !== routine,
  );
  expect(entry).toBeDefined();
  expect(
    walk(entry!).some(
      (node) => node.type === "text" && node.text === completion.createdAt,
    ),
  ).toBe(true);
  expect(
    walk(entry!).some(
      (node) => node.type === "text" && node.text === "finished",
    ),
  ).toBe(true);
  const press = walk(entry!).find(
    (node) => node.type === "action" && node.actionId === "open-run",
  );
  expect(press?.type === "action" && press.input?.entryId).toBe("e1");
  expect(press?.type === "action" && press.input?.routineId).toBe("r1");
});
