// The Cards Skill teaches JSON. This checks the JSON it teaches is JSON the
// seam accepts and the client can draw.
//
// The tables cannot disagree with the catalogs — they are generated from them
// — but the hand-written prose around them carries whole `send_to_user`
// payloads, and a card the Skill spells wrongly is a refusal the Bot has no
// way to diagnose. So every fenced `json` block in the Skill and its
// references is parsed, and the ones that are cards are decoded at the real
// seam, with the real budgets.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
// By path, not by specifier: this test runs from the repository root, where
// the workspace's package names are not resolvable — the same reason
// `scripts/build-applets-assets.ts` imports that way.
import { decodeSendToUserPayloadV1 } from "../core/contracts/send-to-user.ts";
import type { A2uiComponentV1 } from "../core/contracts/a2ui.ts";

const root = resolve(import.meta.dirname, "..");
const skill = resolve(root, "app/cards/skills/a2ui");
const references = resolve(skill, "references");

function jsonBlocks(text: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of text.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const body = match[1]!;
    // A block is a whole value — one send, or the array of them a `batch` call
    // carries — or a property fragment shown in place, like a `checks` list.
    // Both are parsed, so a typo in either fails this test rather than a Turn.
    try {
      blocks.push(JSON.parse(body) as unknown);
    } catch {
      blocks.push(JSON.parse(`{${body}}`) as unknown);
    }
  }
  return blocks;
}

function documents(): { name: string; text: string }[] {
  return [
    {
      name: "SKILL.md",
      text: readFileSync(resolve(skill, "SKILL.md"), "utf8"),
    },
    ...readdirSync(references)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => ({
        name,
        text: readFileSync(resolve(references, name), "utf8"),
      })),
  ];
}

/** Every `{"type":"card", …}` a document shows, however deep it is nested. */
function cardPayloads(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(cardPayloads);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  if (record.type === "card") return [record];
  return Object.values(record).flatMap(cardPayloads);
}

const catalogComponentNames = new Set(
  [
    "core/protocol-schemas/schema/a2ui-basic-catalog.json",
    "core/protocol-schemas/schema/frock-catalog.json",
  ].flatMap((path) =>
    Object.keys(
      (
        JSON.parse(readFileSync(resolve(root, path), "utf8")) as {
          components: Record<string, unknown>;
        }
      ).components,
    ),
  ),
);

describe("the Cards Skill", () => {
  test("shows only cards the seam accepts", () => {
    let checked = 0;
    for (const document of documents()) {
      for (const block of jsonBlocks(document.text)) {
        for (const payload of cardPayloads(block)) {
          expect(() =>
            decodeSendToUserPayloadV1(payload, `${document.name} card`),
          ).not.toThrow();
          checked++;
        }
      }
    }
    // The `SKILL.md` send, the draft, its settled form and the choice form.
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  test("names only components the client can draw", () => {
    for (const document of documents()) {
      for (const block of jsonBlocks(document.text)) {
        for (const payload of cardPayloads(block)) {
          const messages = (payload as { messages: Record<string, unknown>[] })
            .messages;
          for (const message of messages) {
            const body = (message.createSurface ?? message.updateComponents) as
              { components?: A2uiComponentV1[] } | undefined;
            for (const component of body?.components ?? []) {
              expect(catalogComponentNames).toContain(component.component);
            }
          }
        }
      }
    }
  });

  test("every surface it draws has a root, and names only ids it declares", () => {
    for (const document of documents()) {
      for (const block of jsonBlocks(document.text)) {
        for (const payload of cardPayloads(block)) {
          const messages = (payload as { messages: Record<string, unknown>[] })
            .messages;
          for (const message of messages) {
            const body = (message.createSurface ?? message.updateComponents) as
              { components?: A2uiComponentV1[] } | undefined;
            const components = body?.components;
            if (!components) continue;
            const ids = new Set(components.map((component) => component.id));
            expect(ids).toContain("root");
            for (const component of components) {
              const named = [
                ...((component.children as string[] | undefined) ?? []),
                ...(typeof component.child === "string"
                  ? [component.child]
                  : []),
              ];
              for (const child of named) expect(ids).toContain(child);
            }
          }
        }
      }
    }
  });

  test("each reference is inside the loader's bounds", () => {
    const names = readdirSync(references).filter((name) =>
      name.endsWith(".md"),
    );
    expect(names.length).toBeLessThanOrEqual(32);
    for (const name of names) {
      const bytes = readFileSync(resolve(references, name)).byteLength;
      expect(bytes).toBeLessThanOrEqual(65_536);
    }
    expect(
      readFileSync(resolve(skill, "SKILL.md")).byteLength,
    ).toBeLessThanOrEqual(65_536);
  });
});
