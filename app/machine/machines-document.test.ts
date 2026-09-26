import { expect, test } from "bun:test";
import type { ViewNode } from "@frockbot/core/protocol-schemas";
import type { MachineListViewV1 } from "@frockbot/core/machine-protocol";
import { machinesDocumentV1, machinesRevisionV1 } from "./machines-document.js";

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

test("revoking is the one command, and nothing on the page adds a machine", () => {
  // A computer enrols itself from the signed-in desktop app, so there is no
  // form, no field and no code here — only a way to cut one off.
  const document = machinesDocumentV1(view());
  expect(
    walk(document.root)
      .filter((node) => node.type === "action")
      .map((node) => (node.type === "action" ? node.input?.kind : "")),
  ).toEqual(["revoke-machine"]);
  expect(document.actions.map((action) => action.id)).toEqual([
    "revoke-machine",
  ]);
  expect(walk(document.root).some((node) => node.type === "field")).toBe(false);
  expect(JSON.stringify(document)).not.toMatch(/pairing code|"code"/u);
});

test("a computer that reports no abilities says what it is for", () => {
  // The desktop's module host enrols with none: it runs device modules.
  expect(facts({ machines: [{ ...laptop, capabilities: [] }] })).toBe(
    "macos · runs device modules · Connected",
  );
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
    nodes.filter(
      (node) => node.type === "text" && /No computers/u.test(node.text),
    ).length,
  ).toBe(1);
  expect(
    nodes.some(
      (node) =>
        node.type === "text" && node.text === "No computers are connected yet.",
    ),
  ).toBe(true);
});
