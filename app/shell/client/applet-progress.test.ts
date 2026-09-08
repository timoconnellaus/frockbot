import { describe, expect, test } from "bun:test";
import {
  APPLET_PROGRESS_OUTPUT_LINES_V1,
  appletCommandOutputV1,
  appletIsBeingBuiltV1,
  appletProgressV1,
} from "./applet-progress.js";
import type { WebToolActivity } from "../shared.js";

const draft = {
  appletId: "u1abc.todo",
  displayName: "Weekly Todos",
  status: "draft" as const,
  tools: [],
  createdAt: "2026-09-05T00:00:00.000Z",
};
const published = {
  ...draft,
  status: "published" as const,
  currentGenerationId: "generation-2",
};

const sourceOf = (...paths: string[]) => ({
  appletId: draft.appletId,
  truncated: false,
  files: paths.map((path) => ({
    path,
    text: "export default class {}",
    generationId: "w-1",
    changedAt: "2026-09-05T00:01:00.000Z",
  })),
});

function tool(
  name: string,
  status: WebToolActivity["status"],
  extra: Partial<WebToolActivity> = {},
): WebToolActivity {
  return { id: `${name}-${status}`, name, status, ...extra };
}

describe("what the Bot is doing to the focused Applet", () => {
  test("no Applet is no line at all", () => {
    expect(appletProgressV1({})).toBeUndefined();
    expect(appletProgressV1({ applet: null })).toBeUndefined();
  });

  test("a draft nothing has been said about yet reads as still being built", () => {
    // The same words the Applets list uses, so the two surfaces agree.
    expect(appletProgressV1({ applet: draft })).toMatchObject({
      stage: "unknown",
      label: "Still being built",
      working: false,
    });
  });

  test("the create call is the first thing worth saying", () => {
    expect(
      appletProgressV1({
        applet: draft,
        tools: [tool("applets/applet_create", "completed")],
      })?.stage,
    ).toBe("created");
  });

  test("a native tool name counts the same as a namespaced one", () => {
    expect(
      appletProgressV1({
        applet: draft,
        tools: [tool("applet_create", "running")],
      }),
    ).toMatchObject({ stage: "created", working: true });
  });

  test("source on the Workspace means the Bot has been writing", () => {
    expect(
      appletProgressV1({
        applet: draft,
        source: sourceOf("server.ts", "ui.tsx"),
        tools: [tool("applets/applet_create", "completed")],
      })?.label,
    ).toBe("Writing the code");
  });

  test("a check that passed moves the line on and shows what it printed", () => {
    const progress = appletProgressV1({
      applet: draft,
      source: sourceOf("server.ts"),
      tools: [
        tool("computer_exec", "completed", {
          text: "applet check: no problems found",
        }),
      ],
    });
    expect(progress).toMatchObject({
      stage: "checking",
      label: "The code checks out",
      done: true,
    });
    expect(progress?.output).toEqual(["applet check: no problems found"]);
    expect(progress?.failure).toBeUndefined();
  });

  test("a check that found errors is a failure in plain words", () => {
    const progress = appletProgressV1({
      applet: draft,
      tools: [
        tool("computer_exec", "failed", {
          text: "ui.tsx:3:1 Unexpected any\napplet check: 1 error(s)",
        }),
      ],
    });
    expect(progress?.stage).toBe("checking");
    expect(progress?.failure).toBe("The code has problems that need fixing.");
    expect(progress?.output).toEqual([
      "ui.tsx:3:1 Unexpected any",
      "applet check: 1 error(s)",
    ]);
  });

  test("a build is recognised by the files it says it wrote", () => {
    const progress = appletProgressV1({
      applet: draft,
      tools: [
        tool("computer_exec", "completed", {
          text: [
            "dist/server.js 0a1b2c3d4e5f",
            "dist/ui.html f5e4d3c2b1a0",
            "dist/manifest.json 1 tool(s): add_todo",
          ].join("\n"),
        }),
      ],
    });
    expect(progress).toMatchObject({
      stage: "building",
      label: "Built and ready to go live",
      done: true,
    });
    expect(progress?.output).toHaveLength(3);
  });

  test("a shell command that is not the Applet CLI says nothing", () => {
    expect(
      appletCommandOutputV1("total 0\ndrwxr-xr-x  2 box box"),
    ).toBeUndefined();
    expect(appletCommandOutputV1(undefined)).toBeUndefined();
    expect(
      appletProgressV1({
        applet: draft,
        source: sourceOf("server.ts"),
        tools: [tool("computer_exec", "completed", { text: "hello" })],
      })?.stage,
    ).toBe("writing");
  });

  test("a shell command still running is the Bot working, not a new step", () => {
    const progress = appletProgressV1({
      applet: draft,
      source: sourceOf("server.ts"),
      tools: [tool("computer_exec", "running")],
    });
    expect(progress).toMatchObject({ stage: "writing", working: true });
  });

  test("output is bounded, newest lines kept", () => {
    const lines = Array.from(
      { length: 40 },
      (_, index) => `ui.tsx:${index}:1 problem`,
    );
    const progress = appletProgressV1({
      applet: draft,
      tools: [
        tool("computer_exec", "failed", {
          text: [...lines, "applet check: 40 error(s)"].join("\n"),
        }),
      ],
    });
    expect(progress?.output).toHaveLength(APPLET_PROGRESS_OUTPUT_LINES_V1);
    expect(progress?.output?.at(-1)).toBe("applet check: 40 error(s)");
  });

  test("a very long line is cut rather than allowed to run off the panel", () => {
    const progress = appletProgressV1({
      applet: draft,
      tools: [
        tool("computer_exec", "failed", {
          text: `applet check: 1 error(s)\n${"x".repeat(500)}`,
        }),
      ],
    });
    expect(progress?.output?.at(-1)?.length).toBe(200);
    expect(progress?.output?.at(-1)?.endsWith("…")).toBe(true);
  });

  test("a publish in flight is the last step, and clears an earlier complaint", () => {
    const progress = appletProgressV1({
      applet: draft,
      tools: [
        tool("computer_exec", "failed", { text: "applet check: 2 error(s)" }),
        tool("applets/applet_publish", "running", {
          input: { appletId: draft.appletId },
        }),
      ],
    });
    expect(progress).toMatchObject({
      stage: "publishing",
      label: "Getting it ready to open",
      working: true,
    });
    expect(progress?.failure).toBeUndefined();
  });

  test("a publish that was refused says why, in the words it was refused with", () => {
    const progress = appletProgressV1({
      applet: draft,
      tools: [
        tool("applets/applet_publish", "failed", {
          input: { appletId: draft.appletId },
          text: 'Publishing u1abc.todo failed: "add_todo" is already a tool of "Shopping"',
        }),
      ],
    });
    expect(progress?.stage).toBe("publishing");
    expect(progress?.failure).toBe(
      'Publishing u1abc.todo failed: "add_todo" is already a tool of "Shopping"',
    );
  });

  test("a publish of another Applet never moves this one's line", () => {
    expect(
      appletProgressV1({
        applet: draft,
        tools: [
          tool("applets/applet_publish", "running", {
            input: { appletId: "u1abc.other" },
          }),
        ],
      })?.stage,
    ).toBe("unknown");
  });

  test("a live Applet is ready, and the canvas stops showing progress", () => {
    const progress = appletProgressV1({ applet: published });
    expect(progress).toMatchObject({
      stage: "published",
      label: "Ready to use",
      done: true,
    });
    expect(appletIsBeingBuiltV1(progress)).toBe(false);
    expect(appletIsBeingBuiltV1(appletProgressV1({ applet: draft }))).toBe(
      true,
    );
    expect(appletIsBeingBuiltV1(undefined)).toBe(false);
  });

  test("a step still going never claims it finished", () => {
    const progress = appletProgressV1({
      applet: draft,
      tools: [
        tool("computer_exec", "completed", {
          text: "applet check: no problems found",
        }),
        tool("computer_exec", "running"),
      ],
    });
    expect(progress).toMatchObject({ done: false, working: true });
    expect(progress?.label).toBe("Checking the code");
  });

  test("a Turn still running says so even when no Applet tool has been called", () => {
    expect(appletProgressV1({ applet: draft, running: true })?.working).toBe(
      true,
    );
  });

  test("the outcome the Applet authority recorded is used when it has one", () => {
    const progress = appletProgressV1({
      applet: draft,
      build: {
        status: "failed",
        command: "build",
        summary: "dist/manifest.json is invalid",
        diagnostics: ["hashes.server must be a sha-256 hex digest"],
      },
    });
    expect(progress).toMatchObject({
      stage: "building",
      failure: "dist/manifest.json is invalid",
    });
    expect(progress?.output).toEqual([
      "hashes.server must be a sha-256 hex digest",
    ]);
  });

  test("an unknown recorded outcome is not a step that happened", () => {
    expect(
      appletProgressV1({ applet: draft, build: { status: "unknown" } })?.stage,
    ).toBe("unknown");
  });
});
