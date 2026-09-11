import { expect, test } from "bun:test";
import {
  decodeProtocol,
  type ConnectionsFrame,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import { connectionsDocumentV1 } from "./connections-document.js";

function modelDocument(frame: ConnectionsFrame) {
  return connectionsDocumentV1(frame, "model");
}

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
  const document = modelDocument(frame({ providers: [ollama] }));
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
  const document = modelDocument(
    frame({
      providers: [{ ...ollama, connected: 1, mayConnect: false }],
      accounts: [
        {
          id: "conn-1",
          label: "Local Ollama",
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
  const document = modelDocument(
    frame({
      accounts: [
        {
          id: "flock-ai-ambient",
          label: "Frock AI",
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
  const withModel = modelDocument(frame({ modelInUse: "Auto · Frock AI" }));
  expect(
    walk(withModel.root).some(
      (node) => node.type === "text" && node.text === "Auto · Frock AI",
    ),
  ).toBe(true);
  expect(
    walk(withModel.root).some(
      (node) =>
        node.type === "text" && node.text.startsWith("Connect a provider"),
    ),
  ).toBe(true);
  expect(withModel.surfaceId).toBe("model-accounts");
  expect(withModel.revision).toBe(7);
});

test("providers past the action budget are dropped whole, and said so", () => {
  const document = modelDocument(
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

test("the Marketplace excludes model providers, holds its providers at the root, and account setup targets only the chosen provider", () => {
  const mixed = frame({
    providers: [
      ollama,
      { ...ollama, packageId: "second", displayName: "Second" },
      {
        ...ollama,
        packageId: "notes",
        displayName: "Notes",
        kind: "connector",
      },
    ],
  });
  const marketplace = connectionsDocumentV1(mixed);
  const apps = walk(marketplace.root);
  expect(
    apps.some((node) => node.type === "group" && node.title === "Ollama Cloud"),
  ).toBe(false);
  expect(
    apps.some((node) => node.type === "group" && node.title === "Notes"),
  ).toBe(true);
  // A provider is a top-level group of the root, not a row under a heading:
  // that is what lets a wide host draw the Marketplace as a grid of cards.
  expect(
    marketplace.root.type === "group" &&
      marketplace.root.children.map((node) =>
        node.type === "group" ? node.title : node.type,
      ),
  ).toEqual(["Notes"]);
  expect(marketplace.surfaceId).toBe("connections");
  const model = walk(
    connectionsDocumentV1(mixed, "model", ollama.packageId).root,
  );
  expect(
    model.some((node) => node.type === "group" && node.title === "Second"),
  ).toBe(false);
  const connect = model.find(
    (node) => node.type === "group" && node.title === "Connect account",
  );
  expect(connect?.type === "group" && connect.collapsed).toBe(true);
});
