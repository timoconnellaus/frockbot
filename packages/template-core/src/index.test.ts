import { describe, expect, it } from "bun:test";
import {
  assertTemplateDocumentSizeV1,
  canonicalBotTemplateDocumentV1,
  decodeBotTemplateDocumentV1,
  decodeBotTemplateV1,
  decodeTemplateShareRecordV1,
  isTemplateShareReadableV1,
  MAX_TEMPLATE_BYTES_V1,
  MAX_TEMPLATE_SKILLS_V1,
  parseBotTemplateDocumentV1,
  parseTemplateShareIdV1,
  templateContentHashV1,
  templateObjectKeyV1,
  templateShareIdV1,
  TemplateDecodeError,
  type BotTemplateV1,
} from "./index.ts";

const sheep = {
  schemaVersion: 1 as const,
  background: "meadow",
  upper: "wool",
  middle: "scarf",
  lower: "boots",
};

function template(overrides: Partial<BotTemplateV1> = {}): BotTemplateV1 {
  return {
    schemaVersion: 1,
    profile: {
      name: "Budget",
      title: "Money minder",
      avatar: { kind: "sheep", recipe: sheep },
    },
    skills: [
      { slug: "reconcile", name: "Reconcile", body: "# Reconcile\nSteps." },
    ],
    routines: [
      {
        slug: "daily",
        name: "Daily",
        prompt: "Check the ledger.",
        schedule: "0 9 * * *",
        timezone: "Australia/Sydney",
        triggerKind: "cron",
      },
    ],
    packages: [
      {
        packageId: "mcp",
        catalogId: "example-connector",
        version: "0.0.1",
        displayName: "Example",
      },
    ],
    mcpServers: [
      {
        kind: "public",
        name: "Example",
        url: "https://mcp.example.test/mcp",
        transport: "streamable-http",
      },
    ],
    sourceCatalogGeneration: "gen-1",
    ...overrides,
  };
}

describe("decodeBotTemplateV1", () => {
  it("round-trips a full template", () => {
    expect(decodeBotTemplateV1(template())).toEqual(template());
  });

  it("refuses an unknown key", () => {
    expect(() => decodeBotTemplateV1({ ...template(), memory: [] })).toThrow(
      TemplateDecodeError,
    );
  });

  it("refuses an unknown key inside a skill", () => {
    expect(() =>
      decodeBotTemplateV1(
        template({
          skills: [
            {
              slug: "a",
              name: "A",
              body: "b",
              // @ts-expect-error a template skill carries no writer
              writer: { kind: "user" },
            },
          ],
        }),
      ),
    ).toThrow(TemplateDecodeError);
  });

  it("refuses an avatar that is not a sheep recipe", () => {
    expect(() =>
      decodeBotTemplateV1({
        ...template(),
        profile: {
          name: "Budget",
          avatar: { kind: "image", recipe: sheep },
        },
      }),
    ).toThrow(/sheep recipe/);
  });

  it("refuses an avatar carrying uploaded image bytes", () => {
    expect(() =>
      decodeBotTemplateV1({
        ...template(),
        profile: {
          name: "Budget",
          avatar: { kind: "image", digest: "a".repeat(64) },
        },
      }),
    ).toThrow(TemplateDecodeError);
  });

  it("refuses a repeated skill slug", () => {
    expect(() =>
      decodeBotTemplateV1(
        template({
          skills: [
            { slug: "a", name: "A", body: "one" },
            { slug: "a", name: "A2", body: "two" },
          ],
        }),
      ),
    ).toThrow(/repeats a skill slug/);
  });

  it("refuses more skills than the bound", () => {
    expect(() =>
      decodeBotTemplateV1(
        template({
          skills: Array.from(
            { length: MAX_TEMPLATE_SKILLS_V1 + 1 },
            (_value, index) => ({
              slug: `skill-${index}`,
              name: "S",
              body: "b",
            }),
          ),
        }),
      ),
    ).toThrow(/bounded array/);
  });

  it("refuses a webhook routine that also carries a schedule", () => {
    expect(() =>
      decodeBotTemplateV1(
        template({
          routines: [
            {
              slug: "hook",
              name: "Hook",
              prompt: "go",
              schedule: "0 9 * * *",
              timezone: "UTC",
              triggerKind: "webhook",
            },
          ],
        }),
      ),
    ).toThrow(/carries no schedule/);
  });

  it("refuses a non-https MCP server url", () => {
    expect(() =>
      decodeBotTemplateV1(
        template({
          mcpServers: [
            {
              kind: "public",
              name: "Example",
              url: "http://mcp.example.test/mcp",
              transport: "sse",
            },
          ],
        }),
      ),
    ).toThrow(/https/);
  });

  it("accepts a needs-connection placeholder with no url at all", () => {
    const decoded = decodeBotTemplateV1(
      template({
        mcpServers: [
          {
            kind: "needs-connection",
            name: "Beeper",
            connectionTypeId: "mcp-remote-key",
            hint: "Add your own key.",
          },
        ],
      }),
    );
    expect(decoded.mcpServers[0]).toEqual({
      kind: "needs-connection",
      name: "Beeper",
      connectionTypeId: "mcp-remote-key",
      hint: "Add your own key.",
    });
  });
});

describe("canonical bytes and the content hash", () => {
  it("is stable across key order", async () => {
    const one = canonicalBotTemplateDocumentV1(template());
    const shuffled = JSON.parse(
      JSON.stringify({
        mcpServers: template().mcpServers,
        packages: template().packages,
        routines: template().routines,
        skills: template().skills,
        profile: template().profile,
        sourceCatalogGeneration: template().sourceCatalogGeneration,
        schemaVersion: 1,
      }),
    ) as BotTemplateV1;
    const two = canonicalBotTemplateDocumentV1(shuffled);
    expect(two).toBe(one);
    expect(await templateContentHashV1(two)).toBe(
      await templateContentHashV1(one),
    );
  });

  it("verifies the hash before it parses", async () => {
    const document = canonicalBotTemplateDocumentV1(template());
    const hash = await templateContentHashV1(document);
    expect(
      (await decodeBotTemplateDocumentV1(document, hash)).profile.name,
    ).toBe("Budget");
    await expect(
      decodeBotTemplateDocumentV1(document, "0".repeat(64)),
    ).rejects.toThrow(/content hash/);
  });

  it("keys a blob by its hash", async () => {
    const hash = await templateContentHashV1("{}");
    expect(templateObjectKeyV1(hash)).toBe(`templates/${hash}.json`);
    expect(() => templateObjectKeyV1("not-a-hash")).toThrow(
      TemplateDecodeError,
    );
  });

  it("refuses an oversize document in bytes, not characters", () => {
    const padded = "é".repeat(MAX_TEMPLATE_BYTES_V1 - 10);
    expect(padded.length).toBeLessThan(MAX_TEMPLATE_BYTES_V1);
    expect(() => assertTemplateDocumentSizeV1(padded)).toThrow(/bound is/);
  });

  it("refuses an oversize blob before it parses it", () => {
    expect(() =>
      parseBotTemplateDocumentV1(" ".repeat(MAX_TEMPLATE_BYTES_V1 + 1)),
    ).toThrow(/bound is/);
  });
});

describe("share identity and visibility", () => {
  it("round-trips a share id", () => {
    const shareId = templateShareIdV1("user-42", "a".repeat(32));
    expect(shareId).toBe(`user-42.${"a".repeat(32)}`);
    expect(parseTemplateShareIdV1(shareId)).toEqual({
      ownerId: "user-42",
      secret: "a".repeat(32),
    });
  });

  it("splits on the last dot so a dotted owner id survives", () => {
    const shareId = `first.last.${"b".repeat(32)}`;
    expect(() => parseTemplateShareIdV1(shareId)).toThrow(TemplateDecodeError);
  });

  it("refuses a share id with no secret", () => {
    expect(() => parseTemplateShareIdV1("user-42.short")).toThrow(
      TemplateDecodeError,
    );
    expect(() => parseTemplateShareIdV1(".aaaa")).toThrow(TemplateDecodeError);
  });

  it("reads only a link or public share that is not revoked", () => {
    const base = decodeTemplateShareRecordV1({
      schemaVersion: 1,
      shareId: templateShareIdV1("user-42", "c".repeat(32)),
      hash: "d".repeat(64),
      botId: "budget",
      visibility: "link",
      createdAt: "2026-08-31T00:00:00.000Z",
    });
    expect(isTemplateShareReadableV1(base)).toBe(true);
    expect(isTemplateShareReadableV1({ ...base, visibility: "public" })).toBe(
      true,
    );
    expect(isTemplateShareReadableV1({ ...base, visibility: "private" })).toBe(
      false,
    );
    expect(
      isTemplateShareReadableV1({
        ...base,
        revokedAt: "2026-08-31T01:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("refuses a share record with an unknown key", () => {
    expect(() =>
      decodeTemplateShareRecordV1({
        schemaVersion: 1,
        shareId: templateShareIdV1("user-42", "c".repeat(32)),
        hash: "d".repeat(64),
        botId: "budget",
        visibility: "link",
        createdAt: "2026-08-31T00:00:00.000Z",
        apiKey: "secret",
      }),
    ).toThrow(TemplateDecodeError);
  });
});
