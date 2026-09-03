// The Applets Package's isolate module, against the `ctx` the wrapper hands it.
//
// The fake is the narrow context and nothing else: `execute` is the production
// module, and what is asserted is what a model would read back, because the
// answer text *is* the tool's interface. A tool that returns JSON and a tool
// that returns a sentence naming the next command are different products, and
// only the second one is testable this way.
import { describe, expect, test } from "bun:test";
import type {
  BotPackageContextV1,
  IsolateAppletsOutcomeV1,
  IsolateWorkspaceWriteRequestV1,
} from "@frockbot/kernel-contracts";
import { execute, tools } from "./package.js";

const APPLET_ID = "u1abc.todo";

interface Recorded {
  applets: unknown[];
  writes: IsolateWorkspaceWriteRequestV1[];
}

function fakeContext(
  answers: Partial<Record<string, unknown>> = {},
  options: { workspace?: "available" | "unavailable" } = {},
): { ctx: BotPackageContextV1; recorded: Recorded } {
  const recorded: Recorded = { applets: [], writes: [] };
  const answer = (op: string): IsolateAppletsOutcomeV1 => {
    recorded.applets.push(op);
    if (!(op in answers)) {
      return { status: "unavailable", reason: `no fake answer for "${op}"` };
    }
    return { status: "available", value: answers[op] };
  };
  const ctx = {
    applets: {
      list: () => Promise.resolve(answer("list")),
      create: (input: { displayName: string }) => {
        recorded.applets.push(input.displayName);
        return Promise.resolve(answer("create"));
      },
      publish: () => Promise.resolve(answer("publish")),
      revert: () => Promise.resolve(answer("revert")),
      delete: () => Promise.resolve(answer("delete")),
      focus: (input: { appletId: string | null }) => {
        recorded.applets.push(input.appletId);
        return Promise.resolve(answer("focus"));
      },
      generations: () => Promise.resolve(answer("generations")),
    },
    workspace: {
      write: (request: IsolateWorkspaceWriteRequestV1) => {
        recorded.writes.push(request);
        return Promise.resolve(
          options.workspace === "unavailable"
            ? ({
                status: "unavailable",
                reason: "the Workspace is unavailable",
              } as const)
            : ({ status: "available", value: { generationId: "g1" } } as const),
        );
      },
    },
  } as unknown as BotPackageContextV1;
  return { ctx, recorded };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    appletId: APPLET_ID,
    displayName: "Todo",
    status: "draft",
    tools: [],
    createdAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("the Applets Package's declared tools", () => {
  test("declares exactly the seven verbs, each with an exact input schema", () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      "applet_list",
      "applet_create",
      "applet_publish",
      "applet_revert",
      "applet_delete",
      "applet_focus",
      "applet_generations",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  test("only the two read verbs are idempotent", () => {
    expect(
      tools.filter((tool) => tool.idempotent).map((tool) => tool.name),
    ).toEqual(["applet_list", "applet_generations"]);
  });
});

describe("applet_list", () => {
  test("names every Applet, its status, and its generation", async () => {
    const { ctx } = fakeContext({
      list: [
        summary({
          status: "published",
          currentGenerationId: "gen-2",
          tools: ["add_todo"],
        }),
      ],
    });

    const answer = await execute("applet_list", {}, ctx);

    expect(answer).toContain("Todo (u1abc.todo)");
    expect(answer).toContain("published");
    expect(answer).toContain("generation gen-2");
    expect(answer).toContain("add_todo");
  });

  test("an empty account is told what to do about it, not shown nothing", async () => {
    const { ctx } = fakeContext({ list: [] });

    expect(await execute("applet_list", {}, ctx)).toContain("applet_create");
  });

  test("an unavailable capability surfaces its reason verbatim", async () => {
    const { ctx } = fakeContext({});

    await expect(execute("applet_list", {}, ctx)).rejects.toThrow(
      /Applets are unavailable: no fake answer for "list"/,
    );
  });
});

describe("applet_create", () => {
  test("scaffolds the SDK template into the Applet's own directory", async () => {
    const { ctx, recorded } = fakeContext({ create: summary() });

    const answer = await execute("applet_create", { displayName: "Todo" }, ctx);

    expect(recorded.writes.map((write) => write.path.path)).toEqual([
      `${APPLET_ID}/applet.json`,
      `${APPLET_ID}/server.ts`,
      `${APPLET_ID}/ui.tsx`,
      `${APPLET_ID}/README.md`,
    ]);
    for (const write of recorded.writes) {
      expect(write.path.root).toEqual({
        kind: "package-declared",
        packageId: "applets",
        rootId: "source",
      });
      expect(write.expectedGenerationId).toBeNull();
    }
    // The template's placeholders are filled in, so the scaffold reads as this
    // Applet rather than as the template.
    const descriptor = new TextDecoder().decode(recorded.writes[0]!.bytes);
    expect(descriptor).toContain('"displayName": "Todo"');
    expect(descriptor).not.toContain("__APPLET_NAME__");
    expect(new TextDecoder().decode(recorded.writes[1]!.bytes)).not.toContain(
      "__APPLET_NAME__",
    );

    expect(answer).toContain(
      "/home/box/agent-data/user-packages/applets/source/u1abc.todo",
    );
    expect(answer).toContain("applet check");
    expect(answer).toContain("applet build");
    expect(answer).toContain("applet_publish");
  });

  test("a Workspace that cannot be written says so instead of implying success", async () => {
    const { ctx } = fakeContext(
      { create: summary() },
      { workspace: "unavailable" },
    );

    await expect(
      execute("applet_create", { displayName: "Todo" }, ctx),
    ).rejects.toThrow(/source could not be written/);
  });

  test("a missing displayName is refused before anything is created", async () => {
    const { ctx, recorded } = fakeContext({ create: summary() });

    await expect(execute("applet_create", {}, ctx)).rejects.toThrow(
      /displayName is required/,
    );
    expect(recorded.applets).toEqual([]);
  });
});

describe("applet_publish and applet_revert", () => {
  test("a publish reports the generation and the tools it now offers", async () => {
    const { ctx } = fakeContext({
      publish: {
        status: "published",
        appletId: APPLET_ID,
        generationId: "gen-3",
        tools: ["add_todo"],
        compositionGenerationId: "composition-9",
      },
    });

    const answer = await execute(
      "applet_publish",
      { appletId: APPLET_ID },
      ctx,
    );

    expect(answer).toContain("gen-3");
    expect(answer).toContain("add_todo");
    expect(answer).toContain("composition-9");
  });

  test("a failure carries its diagnostics verbatim and says nothing changed", async () => {
    const { ctx } = fakeContext({
      publish: {
        status: "failed",
        appletId: APPLET_ID,
        generationId: "unbuilt",
        reason: '"dist/server.js" is missing',
        diagnostics: ["server declared:aaa actual:bbb"],
      },
    });

    const answer = await execute(
      "applet_publish",
      { appletId: APPLET_ID },
      ctx,
    );

    expect(answer).toContain('"dist/server.js" is missing');
    expect(answer).toContain("server declared:aaa actual:bbb");
    expect(answer).toContain("Nothing changed");
  });

  test("a revert says it reverted, not that it published", async () => {
    const { ctx } = fakeContext({
      revert: {
        status: "published",
        appletId: APPLET_ID,
        generationId: "gen-1",
        tools: [],
      },
    });

    const answer = await execute(
      "applet_revert",
      { appletId: APPLET_ID, generationId: "gen-1" },
      ctx,
    );

    expect(answer).toStartWith("Reverted");
    expect(answer).toContain("declares no tools");
  });
});

describe("applet_focus, applet_delete, and applet_generations", () => {
  test("null closes the panel and is a value, not a missing argument", async () => {
    const { ctx, recorded } = fakeContext({ focus: { appletId: null } });

    expect(await execute("applet_focus", { appletId: null }, ctx)).toContain(
      "Closed",
    );
    expect(recorded.applets[0]).toBeNull();
  });

  test("a non-id, non-null focus is refused", async () => {
    const { ctx } = fakeContext({ focus: { appletId: null } });

    await expect(execute("applet_focus", { appletId: 7 }, ctx)).rejects.toThrow(
      /appletId must be an Applet id or null/,
    );
  });

  test("a delete says plainly that it cannot be undone", async () => {
    const { ctx } = fakeContext({ delete: { status: "deleted" } });

    expect(
      await execute("applet_delete", { appletId: APPLET_ID }, ctx),
    ).toContain("cannot be undone");
  });

  test("generations name the current one", async () => {
    const { ctx } = fakeContext({
      generations: [
        {
          generationId: "gen-2",
          origin: "publish",
          status: "active",
          tools: ["add_todo"],
          createdAt: "2026-09-03T00:00:00.000Z",
          isCurrent: true,
        },
        {
          generationId: "gen-1",
          origin: "publish",
          status: "superseded",
          tools: [],
          createdAt: "2026-09-02T00:00:00.000Z",
          isCurrent: false,
        },
      ],
    });

    const answer = await execute(
      "applet_generations",
      { appletId: APPLET_ID },
      ctx,
    );

    expect(answer).toContain("gen-2 — publish, active, current");
    expect(answer).toContain("gen-1 — publish, superseded");
  });

  test("an Applet with no history is told what to do about it", async () => {
    const { ctx } = fakeContext({ generations: [] });

    expect(
      await execute("applet_generations", { appletId: APPLET_ID }, ctx),
    ).toContain("applet_publish");
  });
});

describe("an unknown tool", () => {
  test("is refused by name", async () => {
    const { ctx } = fakeContext({});

    await expect(execute("applet_teleport", {}, ctx)).rejects.toThrow(
      /does not implement "applet_teleport"/,
    );
  });
});
