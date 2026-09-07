import { expect, test } from "bun:test";
import {
  decodeProtocol,
  type ConnectionsFrame,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import { connectionsDocumentV1 } from "./connections-document.js";

function frame(input: Partial<ConnectionsFrame>): ConnectionsFrame {
  return decodeProtocol("ConnectionsFrame", {
    schemaVersion: 1,
    ownerId: "tim",
    revision: 7,
    accounts: [],
    providers: [],
    ...input,
  });
}

const ollama: ConnectionsFrame["providers"][number] = {
  packageId: "provider-ollama-cloud",
  connectionTypeId: "ollama-cloud-account",
  displayName: "Ollama Cloud",
  kind: "model",
  authorization: "api-key",
  connected: 0,
  mayConnect: true,
  settings: [
    {
      id: "api-base-url",
      label: "API base URL",
      kind: "text",
      value: null,
      editable: true,
    },
  ],
};

function walk(node: ViewNode): ViewNode[] {
  if (node.type === "group")
    return [node, ...node.children.flatMap((child) => walk(child))];
  if (node.type === "list")
    return [node, ...node.rows.flatMap((row) => walk(row.node))];
  return [node];
}

test("a provider that takes a key asks for one as a secret field", () => {
  const document = connectionsDocumentV1(frame({ providers: [ollama] }));
  const nodes = walk(document.root);
  const key = nodes.find(
    (node) => node.type === "field" && node.field.kind === "secret",
  );
  expect(key).toBeDefined();
  // Seeded null, so a required key refuses by name before the action goes.
  expect(key?.type === "field" && key.field.value).toBeNull();
  expect(key?.type === "field" && key.field.id).toBe("c0.key");

  const connect = document.actions.find((action) => action.id === "connect-0");
  expect(connect?.schema.required).toContain("c0.key");
  expect(Object.keys(connect?.schema.properties ?? {})).toContain(
    "c0.s.api-base-url",
  );
});

test("every action names the Connection command it means", () => {
  const document = connectionsDocumentV1(
    frame({
      providers: [{ ...ollama, connected: 1, mayConnect: false }],
      accounts: [
        {
          id: "conn-1",
          label: "Local Ollama",
          service: "Ollama Cloud",
          state: "ready",
          packageId: "provider-ollama-cloud",
          kind: "model",
          authorization: "api-key",
          detail: "Ready · model list up to date",
        },
      ],
    }),
  );
  const kinds = walk(document.root)
    .filter((node) => node.type === "action")
    .map((node) => (node.type === "action" ? node.input?.kind : undefined));
  expect(kinds).toEqual(["refresh-models", "set-enabled", "disconnect"]);
  for (const action of document.actions) {
    expect(action.schema.required).toContain("kind");
  }
});

test("the platform's own account offers nothing to press", () => {
  const document = connectionsDocumentV1(
    frame({
      accounts: [
        {
          id: "flock-ai-ambient",
          label: "Frock AI",
          service: "Frock AI",
          state: "ready",
          packageId: "provider-flock-ai",
          kind: "model",
          authorization: "ambient-native",
          detail: "Ready",
        },
      ],
      providers: [
        {
          packageId: "provider-flock-ai",
          connectionTypeId: "flock-ai-account",
          displayName: "Frock AI",
          kind: "model",
          authorization: "ambient-native",
          connected: 1,
          mayConnect: false,
        },
      ],
    }),
  );
  expect(walk(document.root).some((node) => node.type === "action")).toBe(
    false,
  );
});

test("a Connection Type with no credential is turned on rather than connected", () => {
  const document = connectionsDocumentV1(
    frame({
      providers: [
        {
          packageId: "connector-notes",
          connectionTypeId: "notes",
          displayName: "Notes",
          kind: "connector",
          authorization: "none",
          connected: 0,
          mayConnect: true,
        },
      ],
    }),
  );
  const action = walk(document.root).find((node) => node.type === "action");
  expect(action?.type === "action" && action.input?.kind).toBe(
    "enable-connection",
  );
});

test("the model in use is its own card, and an empty deployment says so", () => {
  const withModel = connectionsDocumentV1(
    frame({ modelInUse: "Auto · Frock AI" }),
  );
  expect(
    walk(withModel.root).some(
      (node) => node.type === "text" && node.text === "Auto · Frock AI",
    ),
  ).toBe(true);
  expect(
    walk(withModel.root).some(
      (node) => node.type === "text" && node.text.startsWith("Your connectors"),
    ),
  ).toBe(true);
  expect(withModel.surfaceId).toBe("connections");
  expect(withModel.revision).toBe(7);
});

test("providers past the action budget are dropped whole, and said so", () => {
  const document = connectionsDocumentV1(
    frame({
      providers: Array.from({ length: 40 }, (_unused, index) => ({
        ...ollama,
        packageId: `provider-${index}`,
        displayName: `Provider ${index}`,
      })),
    }),
  );
  expect(document.actions.length).toBeLessThanOrEqual(32);
  expect(
    walk(document.root).some(
      (node) =>
        node.type === "text" && node.text.startsWith("The rest of these"),
    ),
  ).toBe(true);
});
