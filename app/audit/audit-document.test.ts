import { expect, test } from "bun:test";
import type { ViewNode } from "@frockbot/core/protocol-schemas";
import {
  auditDocumentV1,
  auditMomentV1,
  auditRevisionV1,
  auditTargetLabelV1,
  type AuditFrameV1,
} from "./audit-document.js";
import type { AuditEntryV1 } from "./shared.js";

function walk(node: ViewNode): ViewNode[] {
  return node.type === "group"
    ? [node, ...node.children.flatMap((child) => walk(child))]
    : [node];
}

const shell: AuditEntryV1 = {
  schemaVersion: 1,
  botId: "bot-1",
  runId: "run-1",
  occurrenceId: "tool:1:0:0",
  turn: 1,
  step: 0,
  ordinal: 0,
  effectId: "tool:1:0:0",
  at: "2026-09-03T23:00:00.000Z",
  kind: "shell",
  target: "computer",
  toolName: "shell_exec",
  argumentDigest: "a".repeat(64),
  preview: "ls -la /workspace",
  outcome: "ok",
  durationMs: 42,
};

function frame(over: Partial<AuditFrameV1> = {}): AuditFrameV1 {
  return {
    schemaVersion: 1,
    botId: "bot-1",
    entries: [shell],
    total: 1,
    indexState: "ready",
    ...over,
  };
}

test("an entry says what happened, where and when, and opens its Turn", () => {
  const document = auditDocumentV1(frame());
  const nodes = walk(document.root);
  const facts = nodes.find(
    (node) => node.type === "text" && node.text.startsWith("Completed"),
  );
  expect(facts?.type === "text" && facts.text).toBe(
    "Completed · shell_exec · This Computer · 3 Sep 2026, 11:00pm UTC · 42 ms",
  );
  const open = nodes.find(
    (node) => node.type === "action" && node.actionId === "open-run",
  );
  expect(open?.type === "action" && open.input).toEqual({
    kind: "open-run",
    runId: "run-1",
  });
  expect(document.surfaceId).toBe("audit");
});

test("an outcome the log cannot explain is named, never quietly classified", () => {
  const document = auditDocumentV1(
    frame({
      entries: [{ ...shell, outcome: "unknown", durationMs: undefined }],
    }),
  );
  const text = walk(document.root)
    .filter((node) => node.type === "text")
    .map((node) => (node.type === "text" ? node.text : ""));
  expect(text.some((line) => line.startsWith("Outcome unknown · "))).toBe(true);
  expect(
    text.some((line) => line.startsWith("Its outcome is uncertain.")),
  ).toBe(true);
});

test("the kind in force is the primary filter, and every kind is offered", () => {
  const document = auditDocumentV1(frame({ kind: "browser" }));
  const filters = walk(document.root).filter(
    (node) => node.type === "action" && node.actionId === "filter-kind",
  );
  expect(
    filters.map((node) => (node.type === "action" ? node.label : "")),
  ).toEqual(["All", "shell", "browser", "mcp", "file", "process"]);
  const primary = filters.filter(
    (node) => node.type === "action" && node.style === "primary",
  );
  expect(primary).toHaveLength(1);
  expect(primary[0]?.type === "action" && primary[0].input?.auditKind).toBe(
    "browser",
  );
});

test("a truncated index says so, and a rebuilding one says something else", () => {
  const truncated = walk(
    auditDocumentV1(frame({ indexState: "truncated" })).root,
  )
    .filter((node) => node.type === "text")
    .map((node) => (node.type === "text" ? node.text : ""));
  expect(truncated.some((line) => line.startsWith("Older activity"))).toBe(
    true,
  );
  const rebuilding = walk(
    auditDocumentV1(frame({ indexState: "rebuilding" })).root,
  )
    .filter((node) => node.type === "text")
    .map((node) => (node.type === "text" ? node.text : ""));
  expect(rebuilding.some((line) => line.startsWith("Rebuilding."))).toBe(true);
});

test("a further page is offered by its own cursor and nothing else", () => {
  const document = auditDocumentV1(frame({ nextCursor: "cursor-1" }));
  const more = walk(document.root).find(
    (node) => node.type === "action" && node.actionId === "load-more",
  );
  expect(more?.type === "action" && more.input).toEqual({
    kind: "load-more",
    cursor: "cursor-1",
  });
  expect(
    walk(auditDocumentV1(frame()).root).some(
      (node) => node.type === "action" && node.actionId === "load-more",
    ),
  ).toBe(false);
});

test("an empty log says so", () => {
  const text = walk(auditDocumentV1(frame({ entries: [], total: 0 })).root)
    .filter((node) => node.type === "text")
    .map((node) => (node.type === "text" ? node.text : ""));
  expect(text[0]).toBe("0 audited effects");
  expect(text.some((line) => line.startsWith("No recorded effects yet."))).toBe(
    true,
  );
});

test("a target reads as a place, not as the wire", () => {
  expect(auditTargetLabelV1("computer")).toBe("This Computer");
  expect(auditTargetLabelV1("workspace")).toBe("Workspace");
  expect(auditTargetLabelV1("machine:laptop")).toBe("Machine laptop");
  expect(auditTargetLabelV1("remote:example.com")).toBe("example.com");
  expect(auditMomentV1("not a moment")).toBe("not a moment");
});

test("the revision moves only when what the document says changes", () => {
  expect(auditRevisionV1(frame())).toBe(auditRevisionV1(frame()));
  expect(auditRevisionV1(frame())).not.toBe(
    auditRevisionV1(frame({ kind: "shell" })),
  );
});

test("more entries than the renderer's budget stop, and the document says so", () => {
  const many = Array.from({ length: 300 }, (_, index) => ({
    ...shell,
    runId: `run-${index}`,
    occurrenceId: `tool:${index}:0:0`,
  }));
  const document = auditDocumentV1(frame({ entries: many, total: 300 }));
  expect(walk(document.root).length).toBeLessThanOrEqual(512);
  expect(
    walk(document.root).some(
      (node) => node.type === "text" && node.text.includes("needs a newer app"),
    ),
  ).toBe(true);
});
