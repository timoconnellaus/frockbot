import { describe, expect, it } from "bun:test";
import {
  createBotTemplateBackendContribution,
  type BotTemplateGatewayHostV1,
  type PublishedTemplateV1,
} from "./backend.ts";
import type {
  TemplateCommandV1,
  TemplateImportRecordV1,
  TemplateShareListViewV1,
  TemplateShareReceiptV1,
} from "./shared.ts";

const SHARE_ID = `user-1.${"a".repeat(32)}`;
const HASH = "b".repeat(64);
const DOCUMENT = '{"schemaVersion":1}';

function share(visibility: "private" | "link" | "public" = "link") {
  return {
    schemaVersion: 1 as const,
    shareId: SHARE_ID,
    hash: HASH,
    botId: "budget",
    visibility,
    createdAt: "2026-08-31T00:00:00.000Z",
  };
}

function host(
  overrides: Partial<BotTemplateGatewayHostV1> = {},
): BotTemplateGatewayHostV1 & { commands: TemplateCommandV1[] } {
  const commands: TemplateCommandV1[] = [];
  return {
    commands,
    listTemplateShares: (): Promise<TemplateShareListViewV1> =>
      Promise.resolve({ schemaVersion: 1, shares: [share()] }),
    executeTemplateCommand: (
      _userId: string,
      command: TemplateCommandV1,
    ): Promise<TemplateShareReceiptV1> => {
      commands.push(command);
      return Promise.resolve({
        schemaVersion: 1,
        commandId: command.commandId,
        status: "applied",
        share: share(),
      });
    },
    readPublishedTemplate: (): Promise<PublishedTemplateV1 | undefined> =>
      Promise.resolve({
        hash: HASH,
        visibility: "link",
        document: DOCUMENT,
      }),
    listTemplateImports: () =>
      Promise.resolve({ schemaVersion: 1 as const, imports: [] }),
    executeTemplateImport: (
      _userId: string,
      command: TemplateCommandV1,
    ): Promise<TemplateImportRecordV1> => {
      commands.push(command);
      return Promise.resolve({
        schemaVersion: 1,
        importId: "import-1",
        shareId: SHARE_ID,
        hash: HASH,
        botId: "budget-abc123456789",
        status: "planned",
        botName: "Budget",
        packages: [],
        connections: [],
        skills: [],
        routines: [],
        steps: [{ key: "bot/create", kind: "bot/create", status: "pending" }],
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
    },
    ...overrides,
  };
}

function get(
  path: string,
  headers: Record<string, string> = {},
): [Request, URL] {
  const url = new URL(`https://bot.frockbot.com${path}`);
  return [new Request(url, { headers }), url];
}

describe("the public template route", () => {
  it("serves a published blob with its content hash as the etag", async () => {
    const contribution = createBotTemplateBackendContribution(host());
    const [request, url] = get(`/templates/v1/${SHARE_ID}`);
    const response = await contribution.publicRoute(request, url, {
      client: "browser",
    });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("etag")).toBe(`"${HASH}"`);
    expect(response?.headers.get("cache-control")).toContain("private");
    expect(await response?.text()).toBe(DOCUMENT);
  });

  it("answers 304 to a matching etag", async () => {
    const contribution = createBotTemplateBackendContribution(host());
    const [request, url] = get(`/templates/v1/${SHARE_ID}`, {
      "if-none-match": `"${HASH}"`,
    });
    const response = await contribution.publicRoute(request, url, {
      client: "browser",
    });
    expect(response?.status).toBe(304);
  });

  it("answers 404 for a private, revoked or missing share alike", async () => {
    const contribution = createBotTemplateBackendContribution(
      host({ readPublishedTemplate: () => Promise.resolve(undefined) }),
    );
    const [request, url] = get(`/templates/v1/${SHARE_ID}`);
    const response = await contribution.publicRoute(request, url, {
      client: "browser",
    });
    expect(response?.status).toBe(404);
    expect(await response?.text()).not.toContain("private");
  });

  it("answers 404 for a malformed share id rather than 400", async () => {
    const contribution = createBotTemplateBackendContribution(host());
    const [request, url] = get("/templates/v1/not-a-share");
    const response = await contribution.publicRoute(request, url, {
      client: "browser",
    });
    expect(response?.status).toBe(404);
  });

  it("ignores a path it does not own", async () => {
    const contribution = createBotTemplateBackendContribution(host());
    const [request, url] = get("/api/settings");
    expect(
      await contribution.publicRoute(request, url, { client: "browser" }),
    ).toBeUndefined();
  });

  it("refuses a write on the public route", async () => {
    const contribution = createBotTemplateBackendContribution(host());
    const url = new URL(`https://bot.frockbot.com/templates/v1/${SHARE_ID}`);
    const response = await contribution.publicRoute(
      new Request(url, { method: "POST" }),
      url,
      { client: "browser" },
    );
    expect(response?.status).toBe(405);
  });
});

describe("the authenticated share route", () => {
  it("lists this User's shares", async () => {
    const contribution = createBotTemplateBackendContribution(host());
    const [request, url] = get("/api/bot-templates");
    const response = await contribution.route(request, url, {
      userId: "user-1",
      client: "browser",
    });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      schemaVersion: 1,
      shares: [share()],
    });
  });

  it("refuses an anonymous caller", async () => {
    const contribution = createBotTemplateBackendContribution(host());
    const [request, url] = get("/api/bot-templates");
    const response = await contribution.route(request, url, {
      client: "browser",
    });
    expect(response?.status).toBe(401);
  });

  it("carries a decoded command to the authority", async () => {
    const dependencies = host();
    const contribution = createBotTemplateBackendContribution(dependencies);
    const url = new URL("https://bot.frockbot.com/api/bot-templates");
    const response = await contribution.route(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "template/set-visibility",
          commandId: "visibility-1",
          shareId: SHARE_ID,
          visibility: "link",
        }),
      }),
      url,
      { userId: "user-1", client: "browser" },
    );
    expect(response?.status).toBe(200);
    expect(dependencies.commands).toEqual([
      {
        schemaVersion: 1,
        type: "template/set-visibility",
        commandId: "visibility-1",
        shareId: SHARE_ID,
        visibility: "link",
      },
    ]);
  });

  it("refuses a command with an unknown field", async () => {
    const contribution = createBotTemplateBackendContribution(host());
    const url = new URL("https://bot.frockbot.com/api/bot-templates");
    const response = await contribution.route(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "template/stage",
          commandId: "stage-1",
          botId: "budget",
          visibility: "public",
        }),
      }),
      url,
      { userId: "user-1", client: "browser" },
    );
    expect(response?.status).toBe(400);
  });

  it("answers 404 when the authority does not know the share", async () => {
    const contribution = createBotTemplateBackendContribution(
      host({
        executeTemplateCommand: () => {
          const error = new Error("template share was not found");
          error.name = "TemplateShareNotFoundError";
          return Promise.reject(error);
        },
      }),
    );
    const url = new URL("https://bot.frockbot.com/api/bot-templates");
    const response = await contribution.route(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "template/revoke",
          commandId: "revoke-1",
          shareId: SHARE_ID,
        }),
      }),
      url,
      { userId: "user-1", client: "browser" },
    );
    expect(response?.status).toBe(404);
  });
});

describe("the import route", () => {
  it("plans an import and returns the review card", async () => {
    const dependencies = host();
    const contribution = createBotTemplateBackendContribution(dependencies);
    const url = new URL("https://bot.frockbot.com/api/bot-template-imports");
    const response = await contribution.route(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "template/plan-import",
          commandId: "import-1",
          shareId: SHARE_ID,
        }),
      }),
      url,
      { userId: "user-b", client: "browser" },
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ status: "planned" });
    expect(dependencies.commands[0]).toMatchObject({
      type: "template/plan-import",
    });
  });

  it("refuses a share command on the import route", async () => {
    const contribution = createBotTemplateBackendContribution(host());
    const url = new URL("https://bot.frockbot.com/api/bot-template-imports");
    const response = await contribution.route(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "template/revoke",
          commandId: "revoke-1",
          shareId: SHARE_ID,
        }),
      }),
      url,
      { userId: "user-b", client: "browser" },
    );
    expect(response?.status).toBe(400);
  });

  it("refuses an import command on the share route", async () => {
    const contribution = createBotTemplateBackendContribution(host());
    const url = new URL("https://bot.frockbot.com/api/bot-templates");
    const response = await contribution.route(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "template/apply-import",
          commandId: "apply-1",
          importId: "import-1",
        }),
      }),
      url,
      { userId: "user-b", client: "browser" },
    );
    expect(response?.status).toBe(400);
  });
});
