import { describe, expect, test } from "bun:test";
import { secretsDocumentV1 } from "./document.js";

describe("the saved secrets Settings page", () => {
  test("lists each secret's name and terms with a delete, and nothing else", () => {
    const document = secretsDocumentV1(
      {
        schemaVersion: 1,
        secrets: [
          {
            secretId: `secret-${"a".repeat(32)}`,
            label: "Visa",
            payment: true,
            origin: "https://shop.example",
            botId: "bot-1",
            createdAt: "2026-09-23T00:00:00.000Z",
          },
        ],
      },
      "2026-09-24T00:00:00.000Z",
    );
    const text = JSON.stringify(document);
    expect(document.surfaceId).toBe("secrets");
    expect(text).toContain("Visa");
    expect(text).toContain("Payment detail · Used on https://shop.example");
    expect(text).toContain('"kind":"delete-secret"');
    expect(document.actions.map((action) => action.id)).toEqual([
      "delete-secret",
    ]);
  });

  test("says so when there are none", () => {
    const text = JSON.stringify(
      secretsDocumentV1({ schemaVersion: 1, secrets: [] }),
    );
    expect(text).toContain("You have no saved secrets.");
  });
});
