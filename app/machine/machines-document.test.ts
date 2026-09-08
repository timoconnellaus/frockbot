import { expect, test } from "bun:test";
import type { ViewNode } from "@frockbot/core/protocol-schemas";
import type { MachineListViewV1 } from "@frockbot/core/machine-protocol";
import {
  machinesDocumentV1,
  machinesRevisionV1,
  MACHINE_LABEL_FIELD_V1,
} from "./machines-document.js";

function walk(node: ViewNode): ViewNode[] {
  return node.type === "group"
    ? [node, ...node.children.flatMap((child) => walk(child))]
    : [node];
}

const laptop = {
  machineId: "m-1",
  label: "Studio laptop",
  platform: "macos" as const,
  capabilities: ["exec" as const, "files" as const],
  connected: true,
  lastSeenAt: "2026-09-06T01:00:00.000Z",
  registeredAt: "2026-09-01T00:00:00.000Z",
};

function view(over: Partial<MachineListViewV1> = {}): MachineListViewV1 {
  return {
    schemaVersion: 1,
    machines: [laptop],
    serverTime: "2026-09-06T01:00:30.000Z",
    ...over,
  };
}

function facts(over: Partial<MachineListViewV1> = {}): string {
  const node = walk(machinesDocumentV1(view(over)).root).find(
    (node) => node.type === "text" && node.text.startsWith("macos"),
  );
  return node?.type === "text" ? node.text : "";
}

test("a machine says what it can be asked to do, in words", () => {
  // A connected machine was seen a moment ago by definition, so when is only
  // worth saying about one that is not there — and it is said as a distance,
  // because a projection has no zone to write an instant in.
  expect(facts()).toBe(
    "macos · run commands, read and write files · Connected",
  );
  expect(
    facts({
      machines: [
        { ...laptop, connected: false, lastSeenAt: "2026-09-06T00:20:30.000Z" },
      ],
    }),
  ).toBe(
    "macos · run commands, read and write files · Offline · last seen 40 minutes ago",
  );
});

test("a revoked machine says so rather than that it is connected, and offers no revoke", () => {
  const document = machinesDocumentV1(
    view({
      machines: [
        { ...laptop, connected: true, revokedAt: "2026-09-06T02:00:00.000Z" },
      ],
    }),
  );
  const nodes = walk(document.root);
  expect(
    nodes.some((node) => node.type === "text" && node.text.includes("Revoked")),
  ).toBe(true);
  expect(
    nodes.some(
      (node) => node.type === "action" && node.actionId === "revoke-machine",
    ),
  ).toBe(false);
  // A revoked machine is not one of the registered ones the count promises.
  expect(
    nodes.some(
      (node) =>
        node.type === "text" && node.text === "0 registered · 0 connected",
    ),
  ).toBe(true);
});

test("every control names the command it means, and none of them a code", () => {
  const document = machinesDocumentV1(view());
  expect(
    walk(document.root)
      .filter((node) => node.type === "action")
      .map((node) => (node.type === "action" ? node.input?.kind : "")),
  ).toEqual(["pair-machine", "revoke-machine"]);
  expect(document.actions.map((action) => action.id).sort()).toEqual([
    "pair-machine",
    "revoke-machine",
  ]);
  // The register form asks for a name and nothing else: the code the command
  // mints is on the receipt, and a document can be read twice.
  const fields = walk(document.root).filter((node) => node.type === "field");
  expect(
    fields.map((node) => (node.type === "field" ? node.field.id : "")),
  ).toEqual([MACHINE_LABEL_FIELD_V1]);
  expect(JSON.stringify(document)).not.toContain(`"code"`);
});

test("a registry that has not changed keeps its revision", () => {
  expect(machinesRevisionV1(view())).toBe(
    machinesRevisionV1(view({ serverTime: "2026-09-06T09:99:00.000Z" })),
  );
  expect(machinesRevisionV1(view())).not.toBe(
    machinesRevisionV1(view({ machines: [{ ...laptop, connected: false }] })),
  );
});

test("an empty registry says so once, and does not summarise nothing", () => {
  const nodes = walk(machinesDocumentV1(view({ machines: [] })).root).filter(
    (node) => node.type === "text",
  );
  expect(
    nodes.filter((node) => node.type === "text" && /machines/u.test(node.text))
      .length,
  ).toBe(1);
  expect(
    nodes.some(
      (node) =>
        node.type === "text" && node.text === "No machines are registered yet.",
    ),
  ).toBe(true);
});
