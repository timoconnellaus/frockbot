import { describe, expect, test } from "bun:test";
import type {
  CompositionCommandReceiptV1,
  CompositionGenerationViewV1,
  RevertCompositionCommandV1,
} from "@frockbot/configuration-core";
import type {
  ConnectionCommandReceiptV1,
  ConnectionCommandV1,
} from "@frockbot/connection-core";
import { createSettingsBackendContribution } from "./backend.js";

const BOOTSTRAP_GENERATION = "2026-08-31T00:00:00.000Z:0123456789abcdef";
const AUTHORED_GENERATION = "2026-09-01T00:00:00.000Z:fedcba9876543210";
const REVERTED_GENERATION = "2026-09-02T00:00:00.000Z:0123456789abcdef";

function generationView(
  generationId: string,
  isCurrent: boolean,
): CompositionGenerationViewV1 {
  return {
    schemaVersion: 1,
    botId: "alpha",
    generationId,
    createdAt: generationId.slice(0, 24),
    status: isCurrent ? "active" : "superseded",
    isCurrent,
    origin:
      generationId === BOOTSTRAP_GENERATION
        ? { kind: "bootstrap" }
        : {
            kind: "bot-authored",
            runId: "run-1",
            sessionId: "alice:alpha",
            turnId: "turn-1",
          },
    members: [
      {
        packageId: "shell",
        version: "0.0.1",
        provenance: { kind: "first-party" },
      },
    ],
  };
}

function host(receiptOverride?: unknown, compositionOverride?: unknown) {
  const executed: ConnectionCommandV1[] = [];
  const reverted: RevertCompositionCommandV1[] = [];
  const receipts = new Map<string, ConnectionCommandReceiptV1>();
  return {
    executed,
    reverted,
    contribution: createSettingsBackendContribution({
      listCompositionGenerations: (_userId, botId, query) =>
        Promise.resolve(
          (compositionOverride ?? {
            schemaVersion: 1,
            botId,
            currentGenerationId: AUTHORED_GENERATION,
            generations: [
              generationView(AUTHORED_GENERATION, true),
              generationView(BOOTSTRAP_GENERATION, false),
            ].slice(0, query.limit),
            ...(query.cursor ? { cursor: query.cursor } : {}),
          }) as never,
        ),
      getCompositionGeneration: (_userId, _botId, generationId) =>
        Promise.resolve(
          generationId === BOOTSTRAP_GENERATION
            ? generationView(BOOTSTRAP_GENERATION, false)
            : undefined,
        ),
      revertComposition: (_userId, _botId, command) => {
        reverted.push(command);
        return Promise.resolve({
          schemaVersion: 1,
          commandId: command.commandId,
          status: "applied",
          generationId: REVERTED_GENERATION,
          currentGenerationId: command.expectedGenerationId,
        } satisfies CompositionCommandReceiptV1);
      },
      executeConnection: (_userId, command) => {
        executed.push(command);
        if (receiptOverride !== undefined) {
          return Promise.resolve(receiptOverride as ConnectionCommandReceiptV1);
        }
        const receipt = {
          schemaVersion: 1,
          commandId: command.commandId,
          connectionId:
            "connectionId" in command
              ? command.connectionId
              : "connection-test",
          status: "applied",
        } satisfies ConnectionCommandReceiptV1;
        receipts.set(command.commandId, receipt);
        return Promise.resolve(receipt);
      },
      lookupConnectionCommand: (_userId, _packageId, commandId) =>
        Promise.resolve(receipts.get(commandId)),
    }),
  };
}

function route(
  contribution: ReturnType<typeof createSettingsBackendContribution>,
  path: string,
  init?: RequestInit & { userId?: string },
) {
  const url = new URL(`https://frockbot.test${path}`);
  return contribution.route(new Request(url, init), url, {
    userId: init?.userId ?? "alice",
    client: "browser",
  });
}

const createCommand = JSON.stringify({
  schemaVersion: 1,
  type: "connection/create-api-key",
  commandId: "ollama-connect-1",
  packageId: "provider-ollama-cloud",
  connectionTypeId: "ollama-cloud-account",
  label: "Work",
  apiKey: "write-only-secret",
});

describe("Settings Connection gateway Contribution", () => {
  test("owns only the provider-neutral Connection routes", async () => {
    const { contribution } = host();
    expect(await route(contribution, "/api/settings")).toBeUndefined();
    expect(await route(contribution, "/api/bots")).toBeUndefined();
    expect(
      await route(contribution, "/api/connections", { userId: "" }),
    ).toBeUndefined();
    expect((await route(contribution, "/api/connections"))?.status).toBe(405);
    expect(
      (
        await route(contribution, "/api/connection-commands", {
          method: "POST",
        })
      )?.status,
    ).toBe(405);
  });

  test("admits a Connection command and its receipt lookup", async () => {
    const { contribution, executed } = host();
    const response = await route(contribution, "/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: createCommand,
    });
    expect(response?.status).toBe(200);
    expect((await response?.json()) as unknown).toEqual({
      schemaVersion: 1,
      commandId: "ollama-connect-1",
      connectionId: "connection-test",
      status: "applied",
    });
    expect(executed).toHaveLength(1);

    const lookup = await route(
      contribution,
      "/api/connection-commands?packageId=provider-ollama-cloud&commandId=ollama-connect-1",
    );
    expect((await lookup?.json()) as unknown).toEqual({
      schemaVersion: 1,
      commandId: "ollama-connect-1",
      connectionId: "connection-test",
      status: "applied",
    });

    const missing = await route(
      contribution,
      "/api/connection-commands?packageId=provider-ollama-cloud&commandId=absent-1",
    );
    expect((await missing?.json()) as unknown).toBeNull();
  });

  test("rejects invalid command IDs and lookup queries", async () => {
    const { contribution, executed } = host();
    expect(
      (
        await route(contribution, "/api/connections", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            type: "connection/refresh-models",
            commandId: "lost response",
            connectionId: "connection-test",
          }),
        })
      )?.status,
    ).toBe(400);
    expect(executed).toHaveLength(0);
    for (const query of [
      "?packageId=provider-ollama-cloud",
      "?packageId=provider-ollama-cloud&commandId=connect-1&extra=true",
      "?packageId=provider-ollama-cloud&packageId=other&commandId=connect-1",
      "?packageId=bad%2Fpackage&commandId=connect-1",
      "?packageId=provider-ollama-cloud&commandId=lost%20response",
    ]) {
      expect(
        (await route(contribution, `/api/connection-commands${query}`))?.status,
      ).toBe(400);
    }
  });

  test("rejects malformed receipts returned by the User authority", async () => {
    const { contribution } = host({
      schemaVersion: 1,
      commandId: "ollama-connect-malformed",
      connectionId: "connection-test",
      status: "applied",
      credential: "must-not-cross-the-seam",
    });

    expect(
      (
        await route(contribution, "/api/connections", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: createCommand,
        })
      )?.status,
    ).toBe(400);
  });
});

const revertCommand = JSON.stringify({
  schemaVersion: 1,
  type: "composition/revert",
  commandId: "composition-revert-1",
  botId: "alpha",
  toGenerationId: BOOTSTRAP_GENERATION,
  expectedGenerationId: AUTHORED_GENERATION,
});

describe("Settings Composition gateway Contribution", () => {
  test("lists a Bot's generations newest first", async () => {
    const { contribution } = host();
    const response = await route(
      contribution,
      "/api/bots/alpha/composition/generations",
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      currentGenerationId: string;
      generations: { generationId: string; isCurrent: boolean }[];
    };
    expect(body.currentGenerationId).toBe(AUTHORED_GENERATION);
    expect(body.generations.map((entry) => entry.generationId)).toEqual([
      AUTHORED_GENERATION,
      BOOTSTRAP_GENERATION,
    ]);
    const paged = await route(
      contribution,
      "/api/bots/alpha/composition/generations?limit=1&cursor=composition%3Aindex%3Ax",
    );
    expect(
      ((await paged?.json()) as { generations: unknown[] }).generations,
    ).toHaveLength(1);
  });

  test("reads one generation and answers 404 for an unknown id", async () => {
    const { contribution } = host();
    const found = await route(
      contribution,
      `/api/bots/alpha/composition/generations/${encodeURIComponent(BOOTSTRAP_GENERATION)}`,
    );
    expect(found?.status).toBe(200);
    expect(
      ((await found?.json()) as { generationId: string }).generationId,
    ).toBe(BOOTSTRAP_GENERATION);

    const missing = await route(
      contribution,
      `/api/bots/alpha/composition/generations/${encodeURIComponent(AUTHORED_GENERATION)}`,
    );
    expect(missing?.status).toBe(404);
  });

  test("admits a revert command and returns its receipt", async () => {
    const { contribution, reverted } = host();
    const response = await route(
      contribution,
      "/api/bots/alpha/composition/revert",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: revertCommand,
      },
    );
    expect(response?.status).toBe(200);
    expect((await response?.json()) as unknown).toEqual({
      schemaVersion: 1,
      commandId: "composition-revert-1",
      status: "applied",
      generationId: REVERTED_GENERATION,
      currentGenerationId: AUTHORED_GENERATION,
    });
    expect(reverted).toHaveLength(1);
    expect(reverted[0]?.toGenerationId).toBe(BOOTSTRAP_GENERATION);
  });

  test("rejects wrong methods, mismatched Bots, and invalid queries", async () => {
    const { contribution, reverted } = host();
    expect(
      (
        await route(contribution, "/api/bots/alpha/composition/generations", {
          method: "POST",
        })
      )?.status,
    ).toBe(405);
    expect(
      (await route(contribution, "/api/bots/alpha/composition/revert"))?.status,
    ).toBe(405);
    expect(
      await route(contribution, "/api/bots/alpha/composition/generations", {
        userId: "",
      }),
    ).toBeUndefined();
    for (const query of ["?limit=0", "?limit=500", "?limit=two", "?page=1"]) {
      expect(
        (
          await route(
            contribution,
            `/api/bots/alpha/composition/generations${query}`,
          )
        )?.status,
      ).toBe(400);
    }
    expect(
      (
        await route(contribution, "/api/bots/alpha/composition/revert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            type: "composition/revert",
            commandId: "composition-revert-2",
            botId: "beta",
            toGenerationId: BOOTSTRAP_GENERATION,
            expectedGenerationId: AUTHORED_GENERATION,
          }),
        })
      )?.status,
    ).toBe(400);
    // The optimistic check is part of the decoder: a no-op revert never lands.
    expect(
      (
        await route(contribution, "/api/bots/alpha/composition/revert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            type: "composition/revert",
            commandId: "composition-revert-3",
            botId: "alpha",
            toGenerationId: AUTHORED_GENERATION,
            expectedGenerationId: AUTHORED_GENERATION,
          }),
        })
      )?.status,
    ).toBe(400);
    expect(reverted).toHaveLength(0);
  });

  test("rejects a generation view the Bot authority returns malformed", async () => {
    const { contribution } = host(undefined, {
      schemaVersion: 1,
      botId: "alpha",
      currentGenerationId: AUTHORED_GENERATION,
      generations: [
        {
          ...generationView(AUTHORED_GENERATION, true),
          members: [
            {
              packageId: "shell",
              version: "0.0.1",
              provenance: { kind: "first-party" },
              artifactBytes: "must-not-cross-the-seam",
            },
          ],
        },
      ],
    });

    expect(
      (await route(contribution, "/api/bots/alpha/composition/generations"))
        ?.status,
    ).toBe(400);
  });
});
