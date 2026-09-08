import { expect, test } from "bun:test";
import type { ViewNode } from "@frockbot/core/protocol-schemas";
import {
  TEMPLATE_LINK_FIELD_V1,
  templateImportsDocumentV1,
  templateSharesDocumentV1,
  templateVisibilityFieldV1,
} from "./templates-document.js";
import type {
  TemplateImportListViewV1,
  TemplateShareListViewV1,
} from "./shared.js";

function walk(node: ViewNode): ViewNode[] {
  return node.type === "group"
    ? [node, ...node.children.flatMap((child) => walk(child))]
    : [node];
}

const share = {
  schemaVersion: 1 as const,
  shareId: "user-1.abcdef",
  hash: "0123456789abcdef0123456789abcdef",
  botId: "researcher",
  visibility: "link" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const shares = (
  over: Partial<TemplateShareListViewV1> = {},
): TemplateShareListViewV1 => ({
  schemaVersion: 1,
  shares: [share],
  ...over,
});

const planned = {
  schemaVersion: 1 as const,
  importId: "import-1",
  shareId: share.shareId,
  hash: share.hash,
  botId: "researcher-copy",
  status: "planned" as const,
  botName: "Researcher",
  packages: [
    {
      packageId: "custom-models",
      displayName: "Custom models",
      version: "1.0.0",
      status: "will-install" as const,
    },
    {
      packageId: "gone",
      displayName: "Gone",
      version: "1.0.0",
      status: "missing" as const,
    },
  ],
  skills: ["briefing"],
  routines: [{ slug: "morning", disabled: true }],
  steps: [],
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

const imports = (
  over: Partial<TemplateImportListViewV1> = {},
): TemplateImportListViewV1 => ({
  schemaVersion: 1,
  imports: [planned],
  ...over,
});

test("a share names who can read it, and a private one shows no link", () => {
  const document = templateSharesDocumentV1(shares());
  const select = walk(document.root).find((node) => node.type === "field");
  expect(select?.type === "field" && select.field.id).toBe(
    templateVisibilityFieldV1(0),
  );
  expect(select?.type === "field" && select.field.value).toBe("link");
  expect(
    walk(document.root).some(
      (node) => node.type === "text" && node.text.includes(share.shareId),
    ),
  ).toBe(true);

  const private_ = templateSharesDocumentV1(
    shares({ shares: [{ ...share, visibility: "private" }] }),
  );
  expect(
    walk(private_.root).some(
      (node) => node.type === "text" && node.text.includes(share.shareId),
    ),
  ).toBe(false);
});

test("a save carries which of the declared selects is its own share's answer", () => {
  const document = templateSharesDocumentV1(shares());
  const save = walk(document.root).find(
    (node) => node.type === "action" && node.actionId === "set-visibility",
  );
  expect(save?.type === "action" && save.input).toEqual({
    kind: "set-visibility",
    shareId: share.shareId,
    field: templateVisibilityFieldV1(0),
  });
  const schema = document.actions.find(
    (action) => action.id === "set-visibility",
  )!.schema;
  expect(Object.keys(schema.properties).sort()).toEqual([
    "field",
    "kind",
    "shareId",
    templateVisibilityFieldV1(0),
  ]);
});

test("packing names no Bot: the host is showing one and a document is not", () => {
  const document = templateSharesDocumentV1(shares());
  const pack = document.actions.find(
    (action) => action.id === "pack-template",
  )!;
  expect(Object.keys(pack.schema.properties)).toEqual(["kind"]);
});

test("a revoked share offers nothing to change", () => {
  const document = templateSharesDocumentV1(
    shares({
      shares: [{ ...share, revokedAt: "2026-09-03T00:00:00.000Z" }],
    }),
  );
  const nodes = walk(document.root);
  expect(nodes.some((node) => node.type === "field")).toBe(false);
  expect(
    nodes
      .filter((node) => node.type === "action")
      .map((node) => (node.type === "action" ? node.actionId : "")),
  ).toEqual(["pack-template"]);
});

test("a plan says what it would create and what this deployment will skip", () => {
  const document = templateImportsDocumentV1(imports());
  const preview = walk(document.root).find(
    (node) => node.type === "text" && node.text.startsWith("Will create"),
  );
  const text = preview?.type === "text" ? preview.text : "";
  expect(text).toContain("Will create the Bot “Researcher”.");
  expect(text).toContain("1 Skill: briefing");
  expect(text).toContain("morning — created paused, with no webhook key");
  expect(text).toContain("Will install: Custom models (1.0.0)");
  expect(text).toContain("Not available here, so skipped: Gone");
  const link = walk(document.root).find((node) => node.type === "field");
  expect(link?.type === "field" && link.field.id).toBe(TEMPLATE_LINK_FIELD_V1);
});

test("an applied import has nothing left to press, and a failed one retries", () => {
  const applied = walk(
    templateImportsDocumentV1(
      imports({ imports: [{ ...planned, status: "applied" }] }),
    ).root,
  );
  expect(
    applied.some(
      (node) => node.type === "action" && node.actionId === "apply-import",
    ),
  ).toBe(false);

  const failed = walk(
    templateImportsDocumentV1(
      imports({
        imports: [
          { ...planned, status: "failed", failure: "skill/write: refused." },
        ],
      }),
    ).root,
  );
  const retry = failed.find(
    (node) => node.type === "action" && node.actionId === "apply-import",
  );
  expect(retry?.type === "action" && retry.label).toBe("Retry the import");
  expect(
    failed.some(
      (node) =>
        node.type === "text" &&
        node.text.includes("confirming again retries from there"),
    ),
  ).toBe(true);
});
