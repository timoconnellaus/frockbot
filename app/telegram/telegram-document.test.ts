import { describe, expect, test } from "bun:test";
import type { ViewNode } from "@frockbot/core/protocol-schemas";
import {
  TELEGRAM_BOT_FIELD_V1,
  telegramDocumentV1,
} from "./telegram-document.js";

const NOW = "2026-09-24T01:00:00.000Z";
const bots = [
  { botId: "general-1", name: "General" },
  { botId: "research", name: "Research" },
];

function nodes(node: ViewNode): ViewNode[] {
  return [node, ...(node.type === "group" ? node.children.flatMap(nodes) : [])];
}

describe("the Telegram surface", () => {
  test("unlinked, it offers one thing: a link", () => {
    const document = telegramDocumentV1(
      { schemaVersion: 1, bots },
      { available: true, now: NOW },
    );
    expect(document.actions.map((action) => action.id)).toEqual([
      "telegram-link",
    ]);
  });

  test("linked, it says to whom and lets the person choose the Bot", () => {
    const document = telegramDocumentV1(
      {
        schemaVersion: 1,
        link: {
          username: "tim_o",
          name: "Tim",
          linkedAt: "2026-09-24T00:59:50.000Z",
          botId: "research",
        },
        bots,
      },
      { available: true, now: NOW },
    );
    const all = nodes(document.root);
    expect(all).toContainEqual({
      type: "text",
      text: "Linked to @tim_o · Tim · just now",
      style: "status",
    });
    const field = all.find((node) => node.type === "field");
    expect(field).toMatchObject({
      field: { id: TELEGRAM_BOT_FIELD_V1, kind: "select", value: "research" },
    });
    expect(document.actions.map((action) => action.id).sort()).toEqual([
      "telegram-bot",
      "telegram-unlink",
    ]);
  });

  test("the revision moves with what the page says", () => {
    const view = { schemaVersion: 1 as const, bots };
    const before = telegramDocumentV1(view, { available: true, now: NOW });
    const after = telegramDocumentV1(
      { ...view, link: { linkedAt: NOW, botId: "general-1" } },
      { available: true, now: NOW },
    );
    expect(after.revision).not.toBe(before.revision);
  });
});
