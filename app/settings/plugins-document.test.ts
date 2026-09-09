import { expect, test } from "bun:test";
import {
  decodeProtocol,
  type PluginsFrame,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import { pluginsDocumentV1 } from "./plugins-document.js";

function frame(plugins: PluginsFrame["plugins"]): PluginsFrame {
  return decodeProtocol("PluginsFrame", {
    schemaVersion: 1,
    ownerId: "tim",
    revision: 2,
    plugins,
  });
}

function walk(node: ViewNode): ViewNode[] {
  return node.type === "group"
    ? [node, ...node.children.flatMap((child) => walk(child))]
    : [node];
}

const ollama: PluginsFrame["plugins"][number] = {
  packageId: "provider-ollama-cloud",
  version: "1.0.0",
  displayName: "Ollama Cloud",
  summary: "Models",
  state: "installed",
  home: "models",
};

test("an installed plugin offers the way off and the surface that sets it up", () => {
  const document = pluginsDocumentV1(frame([ollama]));
  const actions = walk(document.root).filter((node) => node.type === "action");
  expect(
    actions.map((node) => (node.type === "action" ? node.label : "")),
  ).toEqual(["Set up in Models", "Turn off"]);
  expect(
    actions.map((node) => (node.type === "action" ? node.input?.kind : "")),
  ).toEqual(["open-home", "set-package-enabled"]);
  expect(document.surfaceId).toBe("plugins");
});

test("a plugin that is not installed is added rather than turned on", () => {
  const document = pluginsDocumentV1(
    frame([{ ...ollama, state: "not-installed" }]),
  );
  const action = walk(document.root).find((node) => node.type === "action");
  expect(action?.type === "action" && action.input).toEqual({
    kind: "install-package",
    packageId: "provider-ollama-cloud",
    version: "1.0.0",
  });
  // Nothing is installed, so the strip counts none and no home is offered.
  expect(
    walk(document.root).some(
      (node) => node.type === "text" && node.text === "0 installed",
    ),
  ).toBe(true);
});

test("a failed installation carries its reason on its own row", () => {
  const document = pluginsDocumentV1(
    frame([{ ...ollama, state: "failed", failure: "Its dependency is off." }]),
  );
  expect(
    walk(document.root).some(
      (node) => node.type === "text" && node.text === "Its dependency is off.",
    ),
  ).toBe(true);
  expect(
    walk(document.root).some(
      (node) => node.type === "group" && node.title === "Ollama Cloud · Failed",
    ),
  ).toBe(true);
});

test("a deployment that ships no plugins says so", () => {
  const document = pluginsDocumentV1(frame([]));
  expect(
    walk(document.root).some(
      (node) =>
        node.type === "text" &&
        node.text.startsWith("No extensions are available yet."),
    ),
  ).toBe(true);
});

test("Mac Messages availability is not presented as permission to use it", () => {
  const document = pluginsDocumentV1(
    frame([
      {
        ...ollama,
        packageId: "machine-messages",
        displayName: "Messages on your Mac",
        home: "user-settings",
      },
    ]),
    true,
  );
  expect(
    walk(document.root).some(
      (node) =>
        node.type === "group" &&
        node.title === "Messages on your Mac · Available — needs Mac setup",
    ),
  ).toBe(true);
});
