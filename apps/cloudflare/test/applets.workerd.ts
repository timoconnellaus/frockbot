// Lane K3's proof, in workerd, against the real `AppletState` Durable Object.
//
// Every claim ADR 0022 and `AGENTS.md` make about an Applet is exercised here
// on the production class, not a probe: an Applet's facet storage survives a
// code generation change and a revert; a generation whose health check fails
// leaves the prior facet resident and records a durable failure; deleting an
// Applet deletes its storage, versions, and directory entry; a facet cannot see
// a host binding or the kernel's own storage; a tool call routes through this
// object into the facet; and a viewer token is scoped to one User, one Applet,
// and one generation.
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { createGateway } from "../src/gateway.js";
import {
  appletStateNameV1,
  mintAppletViewerTokenV1,
  verifyAppletViewerTokenV1,
  APPLET_FACET_NAME_V1,
  APPLET_ROLLBACK_FACET_NAME_V1,
  APPLET_TRIAL_KEY,
  APPLET_VIEWER_TOKEN_TTL_MS,
} from "@frockbot/kernel-do";

const OWNER = "user-applets";

function appletId(suffix: string): string {
  return `${OWNER}.${suffix.padEnd(32, "0").slice(0, 32)}`;
}

function stateFor(applet: string) {
  return env.APPLET_STATES.get(
    env.APPLET_STATES.idFromName(appletStateNameV1(OWNER, applet)),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The Applet server module a Bot would publish, in the shape the SDK's `Applet`
 * base class takes: a `DurableObject` subclass named `Applet` with `health()`,
 * `invokeTool`, and an `onAlarm` hook. `version` and `tools` are substituted so
 * two generations differ observably over the same storage.
 */
function appletModule(options: {
  version: string;
  tools: string[];
  healthTools?: string[];
  throwOnConstruct?: boolean;
  /**
   * Where this generation wipes the todos it inherited before it fails. Each
   * value is a real place an Applet's code runs against live storage before
   * the kernel has admitted it: the constructor, the SDK's migration step
   * inside `ready()`, and `health()` itself.
   */
  wipeIn?: "construct" | "migrate" | "health";
  /** `health()` never resolves: the activation deadline is the only way out. */
  hangOnHealth?: boolean;
  /** The migration throws after it has already written. */
  throwOnMigrate?: boolean;
}): string {
  const wipe = `this.ctx.storage.sql.exec("DELETE FROM todos");`;
  return `import { DurableObject } from "cloudflare:workers";

const VERSION = ${JSON.stringify(options.version)};
const TOOLS = ${JSON.stringify(options.tools)};
const HEALTH_TOOLS = ${JSON.stringify(options.healthTools ?? options.tools)};

export class Applet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)",
    );
    ${options.wipeIn === "construct" ? wipe : ""}
    ${options.throwOnConstruct ? 'throw new Error("this generation is broken");' : ""}
  }

  // What the SDK's \`ready()\` does before it answers health: schema work, then
  // the Applet's own migration. Both run against live storage.
  async migrate() {
    ${options.wipeIn === "migrate" ? wipe : ""}
    ${options.throwOnMigrate ? 'throw new Error("this migration is broken");' : ""}
  }

  async health() {
    await this.migrate();
    ${options.wipeIn === "health" ? wipe : ""}
    ${options.hangOnHealth ? "await new Promise(() => {});" : ""}
    return { contract: 1, tools: HEALTH_TOOLS, schemaRevision: 1 };
  }

  async invokeTool(name, input) {
    if (name === "add_todo") {
      this.ctx.storage.sql.exec("INSERT INTO todos (title) VALUES (?)", input.title);
      return VERSION + ":added:" + input.title;
    }
    if (name === "list_todos") {
      return VERSION + ":" + this.listTitles().join(",");
    }
    if (name === "leak_probe") {
      return JSON.stringify({
        envKeys: Object.keys(this.env).sort(),
        parentOnly: (await this.ctx.storage.get("applet:current")) ?? null,
        secretToken: typeof this.env.SECRET_TOKEN,
        loader: typeof this.env.APPLETS,
        namespace: typeof this.env.APPLET_STATES,
        identity: this.env.IDENTITY,
      });
    }
    throw new Error("unknown tool " + name);
  }

  listTitles() {
    return [
      ...this.ctx.storage.sql.exec("SELECT title FROM todos ORDER BY id"),
    ].map((row) => row.title);
  }

  // The viewer socket, as the SDK's base class answers it: a hibernatable
  // WebSocket the kernel object forwarded through its own fetch door.
  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket, message) {
    socket.send(VERSION + ":echo:" + message);
  }

  async onAlarm() {
    const count = ((await this.ctx.storage.get("alarm-count")) ?? 0) + 1;
    await this.ctx.storage.put("alarm-count", count);
  }
}
`;
}

const TOOL_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
} as const;

function declaration(name: string) {
  return {
    name,
    description: `The ${name} tool`,
    inputSchema: TOOL_SCHEMA as unknown as Record<string, unknown>,
  };
}

async function publishGeneration(
  applet: string,
  options: {
    version: string;
    tools: string[];
    healthTools?: string[];
    throwOnConstruct?: boolean;
    wipeIn?: "construct" | "migrate" | "health";
    hangOnHealth?: boolean;
    throwOnMigrate?: boolean;
    origin?: "publish" | "revert";
    generationId?: string;
  },
) {
  const source = appletModule(options);
  const serverHash = await sha256Hex(source);
  const ui = `<!doctype html><h1>${options.version}</h1>`;
  const uiHash = await sha256Hex(ui);
  await env.APPLICATION_ARTIFACTS.put(`packages/${serverHash}.mjs`, source);
  await env.APPLICATION_ARTIFACTS.put(`packages/${uiHash}.html`, ui);
  const createdAt = new Date().toISOString();
  const generation = {
    schemaVersion: 1 as const,
    generationId: options.generationId ?? `${createdAt}:${options.version}`,
    server: {
      contentHash: serverHash,
      size: source.length,
      mediaType: "application/javascript" as const,
      bundlerVersion: "test",
    },
    ui: {
      contentHash: uiHash,
      size: ui.length,
      mediaType: "text/html" as const,
      bundlerVersion: "test",
    },
    tools: options.tools.map(declaration),
    contract: 1 as const,
    origin: options.origin ?? ("publish" as const),
    provenance: {
      botId: "bot-1",
      sessionId: `${OWNER}:bot-1`,
      turnId: "turn-1",
      runId: "run-1",
    },
    createdAt,
    status: "pending" as const,
  };
  const outcome = await stateFor(applet)[
    options.origin === "revert" ? "revert" : "publish"
  ]({
    schemaVersion: 1,
    userId: OWNER,
    appletId: applet,
    generation,
  });
  return { outcome, generation, serverHash, uiHash };
}

/** The generation the object says is current, as a Turn's Composition pins it. */
async function currentGenerationId(applet: string): Promise<string> {
  const view = await stateFor(applet).read({
    schemaVersion: 1,
    userId: OWNER,
    appletId: applet,
  });
  return view.current?.generationId ?? "none";
}

/**
 * One Applet tool call. `generationId` is the pin the caller's Turn carries;
 * it defaults to whatever is current, which is what an uneventful Turn does.
 */
async function invoke(
  applet: string,
  tool: string,
  input: unknown,
  generationId?: string,
) {
  return stateFor(applet).invokeTool({
    schemaVersion: 1,
    userId: OWNER,
    appletId: applet,
    generationId: generationId ?? (await currentGenerationId(applet)),
    tool,
    toolInput: input,
  });
}

describe("Applet authority", () => {
  test("a published generation mounts, health-checks, and becomes current", async () => {
    const applet = appletId("mount");
    const { outcome, generation } = await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos", "leak_probe"],
    });
    expect(outcome).toMatchObject({ status: "active" });
    expect(outcome.status === "active" && outcome.tools.toSorted()).toEqual([
      "add_todo",
      "leak_probe",
      "list_todos",
    ]);

    const view = await stateFor(applet).read({
      schemaVersion: 1,
      userId: OWNER,
      appletId: applet,
    });
    expect(view.current?.generationId).toBe(generation.generationId);
    // Last known good is set only by a successful mount.
    expect(view.lastKnownGood?.generationId).toBe(generation.generationId);
    expect(view.failures).toEqual([]);
    expect(
      view.generations.find(
        (candidate) => candidate.generationId === generation.generationId,
      )?.status,
    ).toBe("active");
  });

  test("facet storage survives a code generation change", async () => {
    const applet = appletId("remount");
    await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos"],
    });
    expect(await invoke(applet, "add_todo", { title: "milk" })).toMatchObject({
      status: "ok",
      content: "A:added:milk",
    });

    // Different code, same storage — the whole point of ADR 0022.
    const second = await publishGeneration(applet, {
      version: "B",
      tools: ["add_todo", "list_todos"],
    });
    expect(second.outcome).toMatchObject({ status: "active" });
    expect(await invoke(applet, "list_todos", {})).toMatchObject({
      status: "ok",
      content: "B:milk",
    });
    expect(await invoke(applet, "add_todo", { title: "eggs" })).toMatchObject({
      content: "B:added:eggs",
    });
    expect(await invoke(applet, "list_todos", {})).toMatchObject({
      content: "B:milk,eggs",
    });
  });

  test("a revert remounts older code over the same storage and never sets last-known-good", async () => {
    const applet = appletId("revert");
    const first = await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos"],
    });
    await invoke(applet, "add_todo", { title: "milk" });
    const second = await publishGeneration(applet, {
      version: "B",
      tools: ["add_todo", "list_todos"],
    });
    expect(second.outcome).toMatchObject({ status: "active" });

    const reverted = await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos"],
      origin: "revert",
      generationId: `${new Date().toISOString()}:revert-to-A`,
    });
    expect(reverted.outcome).toMatchObject({ status: "active" });
    // Old code, and the todos are still there.
    expect(await invoke(applet, "list_todos", {})).toMatchObject({
      content: "A:milk",
    });
    const view = await stateFor(applet).read({
      schemaVersion: 1,
      userId: OWNER,
      appletId: applet,
    });
    expect(view.current?.generationId).toBe(reverted.generation.generationId);
    // A revert is a pointer move, not evidence anything newly works.
    expect(view.lastKnownGood?.generationId).toBe(
      second.generation.generationId,
    );
    expect(first.generation.generationId).not.toBe(
      second.generation.generationId,
    );
  });

  test("a failed health check leaves the prior facet resident and records a failure", async () => {
    const applet = appletId("healthfail");
    const good = await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos"],
    });
    await invoke(applet, "add_todo", { title: "milk" });

    // Declared tools and reported tools disagree: the mount must fail.
    const broken = await publishGeneration(applet, {
      version: "B",
      tools: ["add_todo", "list_todos"],
      healthTools: ["add_todo"],
    });
    expect(broken.outcome.status).toBe("failed");
    expect(broken.outcome).toMatchObject({
      residentGenerationId: good.generation.generationId,
    });

    // The prior facet is still resident, still on version A, still holding the
    // same rows.
    expect(await invoke(applet, "list_todos", {})).toMatchObject({
      content: "A:milk",
    });
    const view = await stateFor(applet).read({
      schemaVersion: 1,
      userId: OWNER,
      appletId: applet,
    });
    expect(view.current?.generationId).toBe(good.generation.generationId);
    expect(view.lastKnownGood?.generationId).toBe(good.generation.generationId);
    expect(view.failures).toHaveLength(1);
    expect(view.failures[0]).toMatchObject({
      appletId: applet,
      generationId: broken.generation.generationId,
      attempt: 1,
      phase: "health",
    });
    expect(
      view.generations.find(
        (candidate) =>
          candidate.generationId === broken.generation.generationId,
      )?.status,
    ).toBe("failed");
  });

  test("a generation whose code throws on construct fails the mount, not the Applet", async () => {
    const applet = appletId("mountfail");
    const good = await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos"],
    });
    await invoke(applet, "add_todo", { title: "milk" });
    const broken = await publishGeneration(applet, {
      version: "B",
      tools: ["add_todo", "list_todos"],
      throwOnConstruct: true,
    });
    expect(broken.outcome.status).toBe("failed");
    expect(await invoke(applet, "list_todos", {})).toMatchObject({
      content: "A:milk",
    });
    const view = await stateFor(applet).read({
      schemaVersion: 1,
      userId: OWNER,
      appletId: applet,
    });
    expect(view.current?.generationId).toBe(good.generation.generationId);
    expect(view.failures).toHaveLength(1);
    expect(view.failures[0]?.phase).toBe("mount");
  });

  test("a facet sees exactly IDENTITY and CAPABILITIES, and no host binding", async () => {
    const applet = appletId("leak");
    await publishGeneration(applet, { version: "A", tools: ["leak_probe"] });
    const answer = await invoke(applet, "leak_probe", {});
    expect(answer.status).toBe("ok");
    const probe = JSON.parse(answer.content) as {
      envKeys: string[];
      parentOnly: unknown;
      secretToken: string;
      loader: string;
      namespace: string;
      identity: { userId: string; appletId: string; generationId: string };
    };
    expect(probe.envKeys).toEqual(["CAPABILITIES", "IDENTITY"]);
    expect(probe.secretToken).toBe("undefined");
    expect(probe.loader).toBe("undefined");
    expect(probe.namespace).toBe("undefined");
    // The kernel's own records are invisible from inside the facet.
    expect(probe.parentOnly).toBeNull();
    expect(probe.identity.userId).toBe(OWNER);
    expect(probe.identity.appletId).toBe(applet);
  });

  test("a tool call on an Applet with no active generation is a visible error", async () => {
    const applet = appletId("empty");
    expect(await invoke(applet, "add_todo", { title: "x" })).toMatchObject({
      status: "error",
    });
  });

  test("delete removes the facet storage, the versions, and the pointers", async () => {
    const applet = appletId("delete");
    await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos"],
    });
    await invoke(applet, "add_todo", { title: "milk" });
    expect(await invoke(applet, "list_todos", {})).toMatchObject({
      content: "A:milk",
    });

    expect(
      await stateFor(applet).delete({
        schemaVersion: 1,
        userId: OWNER,
        appletId: applet,
      }),
    ).toEqual({ status: "deleted" });

    const view = await stateFor(applet).read({
      schemaVersion: 1,
      userId: OWNER,
      appletId: applet,
    });
    expect(view.current).toBeUndefined();
    expect(view.lastKnownGood).toBeUndefined();
    expect(view.generations).toEqual([]);
    expect(view.failures).toEqual([]);

    // And the facet's own rows are gone: a fresh publish of the same code
    // starts over rather than finding the old todos.
    await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos"],
    });
    expect(await invoke(applet, "list_todos", {})).toMatchObject({
      content: "A:",
    });
  });

  test("an Applet object refuses to answer for a different Applet", async () => {
    const applet = appletId("identity");
    await publishGeneration(applet, { version: "A", tools: ["list_todos"] });
    // Awaited in place rather than through `rejects`: a rejected Durable Object
    // RPC promise that is only inspected leaves an unhandled rejection behind.
    let refusal: unknown;
    try {
      await stateFor(applet).read({
        schemaVersion: 1,
        userId: OWNER,
        appletId: appletId("someoneelse"),
      });
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(/different Applet/);
  });
});

// The counterexample the 2026-09-05 review reproduced, and its three siblings.
//
// Before ADR 0041 the kernel mounted a candidate generation against the live
// facet and treated a health failure as a rollback. It was not one: the
// candidate's constructor, the SDK's migration step, and `health()` itself all
// run against the Applet's real rows first, so a generation could delete the
// previous generation's data and *then* fail, leaving the host reporting the
// previous generation resident over storage it no longer recognised.
//
// Each test here fails at a different place in that window and asserts the same
// thing: the previous generation's data *and* behaviour are usable afterwards,
// not merely its generation id resident.
describe("an activation trial cannot change the previous generation's data", () => {
  async function seededApplet(suffix: string) {
    const applet = appletId(suffix);
    const { generation } = await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos"],
    });
    expect(
      await invoke(applet, "add_todo", { title: "keep-me" }),
    ).toMatchObject({ status: "ok" });
    return { applet, generation };
  }

  /** The previous generation still answers, on its own code, with its own rows. */
  async function expectIntact(applet: string, generationId: string) {
    expect(await invoke(applet, "list_todos", {})).toMatchObject({
      status: "ok",
      content: "A:keep-me",
    });
    // And it can still be written to: a restored facet is a working facet.
    expect(await invoke(applet, "add_todo", { title: "after" })).toMatchObject({
      status: "ok",
      content: "A:added:after",
    });
    expect(await invoke(applet, "list_todos", {})).toMatchObject({
      content: "A:keep-me,after",
    });
    const view = await stateFor(applet).read({
      schemaVersion: 1,
      userId: OWNER,
      appletId: applet,
    });
    expect(view.current?.generationId).toBe(generationId);
    expect(view.lastKnownGood?.generationId).toBe(generationId);
  }

  test("a failed health check cannot change the previous generation's data", async () => {
    const { applet, generation } = await seededApplet("trial-health");
    const broken = await publishGeneration(applet, {
      version: "B",
      tools: ["add_todo", "list_todos"],
      wipeIn: "health",
      healthTools: ["add_todo"],
    });
    expect(broken.outcome).toMatchObject({
      status: "failed",
      residentGenerationId: generation.generationId,
    });
    await expectIntact(applet, generation.generationId);
  });

  test("a failed constructor cannot change the previous generation's data", async () => {
    const { applet, generation } = await seededApplet("trial-construct");
    const broken = await publishGeneration(applet, {
      version: "B",
      tools: ["add_todo", "list_todos"],
      wipeIn: "construct",
      throwOnConstruct: true,
    });
    expect(broken.outcome.status).toBe("failed");
    await expectIntact(applet, generation.generationId);
  });

  test("a failed migration cannot change the previous generation's data", async () => {
    const { applet, generation } = await seededApplet("trial-migrate");
    const broken = await publishGeneration(applet, {
      version: "B",
      tools: ["add_todo", "list_todos"],
      wipeIn: "migrate",
      throwOnMigrate: true,
    });
    expect(broken.outcome.status).toBe("failed");
    await expectIntact(applet, generation.generationId);
  });

  test("a timed-out activation cannot change the previous generation's data", async () => {
    const { applet, generation } = await seededApplet("trial-deadline");
    const broken = await publishGeneration(applet, {
      version: "B",
      tools: ["add_todo", "list_todos"],
      wipeIn: "health",
      hangOnHealth: true,
    });
    expect(broken.outcome.status).toBe("failed");
    expect(broken.outcome.status === "failed" && broken.outcome.reason).toMatch(
      /exceeded/,
    );
    await expectIntact(applet, generation.generationId);
  });

  test("a first generation that fails leaves no storage behind for the next one", async () => {
    const applet = appletId("trial-first");
    const broken = await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos"],
      healthTools: ["add_todo"],
    });
    expect(broken.outcome.status).toBe("failed");
    // Nothing to restore and nothing to keep: the next generation starts on
    // empty storage rather than on whatever the refused one wrote.
    await publishGeneration(applet, {
      version: "B",
      tools: ["add_todo", "list_todos"],
    });
    expect(await invoke(applet, "list_todos", {})).toMatchObject({
      content: "B:",
    });
  });
});

// ADR 0041's second half. A Turn's Composition advertises one Applet generation
// to the model — its tools, their schemas, and its provenance — and the call it
// makes names that generation. The instance runs it or refuses.
describe("Applet tool calls execute the generation the Turn pinned", () => {
  test("a call pinned to a superseded generation is refused, and nothing runs", async () => {
    const applet = appletId("pinned");
    const first = await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos"],
    });
    await invoke(
      applet,
      "add_todo",
      { title: "milk" },
      first.generation.generationId,
    );

    // A publish lands while the Turn pinned to A is still running.
    const second = await publishGeneration(applet, {
      version: "B",
      tools: ["add_todo", "list_todos"],
    });
    expect(second.outcome).toMatchObject({ status: "active" });

    const refused = await invoke(
      applet,
      "add_todo",
      { title: "written-by-the-wrong-version" },
      first.generation.generationId,
    );
    expect(refused.status).toBe("error");
    expect(refused.content).toContain(first.generation.generationId);
    expect(refused.content).toContain(second.generation.generationId);

    // The refusal really is a refusal: B never ran the tool.
    expect(
      await invoke(applet, "list_todos", {}, second.generation.generationId),
    ).toMatchObject({ status: "ok", content: "B:milk" });
  });

  test("the next Turn, pinned to the new generation, runs it", async () => {
    const applet = appletId("pinned-next");
    await publishGeneration(applet, {
      version: "A",
      tools: ["add_todo", "list_todos"],
    });
    const second = await publishGeneration(applet, {
      version: "B",
      tools: ["add_todo", "list_todos"],
    });
    expect(
      await invoke(
        applet,
        "add_todo",
        { title: "eggs" },
        second.generation.generationId,
      ),
    ).toMatchObject({ status: "ok", content: "B:added:eggs" });
  });
});

describe("Applet directory", () => {
  function directoryFor(userId: string) {
    return env.USER_CONFIGURATIONS.get(
      env.USER_CONFIGURATIONS.idFromName(userId),
    );
  }

  test("create mints an id in the share shape and lists it", async () => {
    const userId = "user-directory-create";
    const directory = directoryFor(userId);
    const created = await directory.createApplet({
      schemaVersion: 1,
      userId,
      displayName: "Todo",
      provenance: {
        kind: "bot",
        botId: "bot-1",
        sessionId: `${userId}:bot-1`,
        turnId: "turn-1",
      },
    });
    expect(created.appletId.startsWith(`${userId}.`)).toBe(true);
    expect(created.status).toBe("draft");
    expect(created.tools).toEqual([]);

    const listed = await directory.listApplets({ schemaVersion: 1, userId });
    expect(listed.applets.map((applet) => applet.appletId)).toEqual([
      created.appletId,
    ]);
    // A draft has no generation, so it contributes no Composition member.
    const composition = await directory.readAppletCompositionInput({
      schemaVersion: 1,
      userId,
    });
    expect(composition.applets).toEqual([]);
    expect(composition.revision).toBe(listed.revision);
  });

  test("recording a generation publishes the entry and bumps the revision", async () => {
    const userId = "user-directory-publish";
    const directory = directoryFor(userId);
    const created = await directory.createApplet({
      schemaVersion: 1,
      userId,
      displayName: "Todo",
      provenance: { kind: "user" },
    });
    const before = (await directory.listApplets({ schemaVersion: 1, userId }))
      .revision;
    const published = await directory.recordAppletGeneration({
      schemaVersion: 1,
      userId,
      appletId: created.appletId,
      generationId: "g1",
      tools: [declaration("add_todo")],
    });
    expect(published).toMatchObject({
      status: "published",
      currentGenerationId: "g1",
      tools: ["add_todo"],
    });
    const after = await directory.listApplets({ schemaVersion: 1, userId });
    expect(after.revision).toBeGreaterThan(before);

    const composition = await directory.readAppletCompositionInput({
      schemaVersion: 1,
      userId,
    });
    expect(composition.applets).toHaveLength(1);
    expect(composition.applets[0]).toMatchObject({
      appletId: created.appletId,
      generationId: "g1",
    });
    expect(composition.applets[0]?.tools[0]?.name).toBe("add_todo");
  });

  test("delete drops the entry from the directory and from every resolution", async () => {
    const userId = "user-directory-delete";
    const directory = directoryFor(userId);
    const created = await directory.createApplet({
      schemaVersion: 1,
      userId,
      displayName: "Todo",
      provenance: { kind: "user" },
    });
    await directory.recordAppletGeneration({
      schemaVersion: 1,
      userId,
      appletId: created.appletId,
      generationId: "g1",
      tools: [declaration("add_todo")],
    });
    const before = (await directory.listApplets({ schemaVersion: 1, userId }))
      .revision;

    expect(
      await directory.deleteApplet({
        schemaVersion: 1,
        userId,
        appletId: created.appletId,
      }),
    ).toMatchObject({ status: "deleted", tools: [] });

    const after = await directory.listApplets({ schemaVersion: 1, userId });
    expect(after.applets).toEqual([]);
    expect(after.revision).toBeGreaterThan(before);
    expect(
      (
        await directory.readAppletCompositionInput({
          schemaVersion: 1,
          userId,
        })
      ).applets,
    ).toEqual([]);
  });

  test("one User's directory is not another's", async () => {
    const userId = "user-directory-scope";
    const directory = directoryFor(userId);
    await directory.createApplet({
      schemaVersion: 1,
      userId,
      displayName: "Todo",
      provenance: { kind: "user" },
    });
    let refusal: unknown;
    try {
      await directory.listApplets({
        schemaVersion: 1,
        userId: "user-somebody-else",
      });
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(/different User/);
  });
});

describe("Applet viewer tokens", () => {
  test.each(["query", "subprotocol"])(
    "the %s viewer handshake crosses the gateway and real facet without forwarding credentials",
    async (transport) => {
      const applet = appletId(`gateway-${transport}`);
      const { generation } = await publishGeneration(applet, {
        version: "A",
        tools: ["list_todos"],
      });
      const secret = "gateway-viewer-proof-secret-0123456789abcdef";
      const token = await mintAppletViewerTokenV1(secret, {
        u: OWNER,
        a: applet,
        g: generation.generationId,
        exp: Math.floor((Date.now() + 120_000) / 1_000),
      });
      const unused = (): never => {
        throw new Error("A viewer must not enter an app-session path");
      };
      const gateway = createGateway({
        loader: { get: unused },
        artifacts: { load: unused },
        auth: { getSession: unused, handler: unused },
        userExists: unused,
        readDeploymentPolicy: unused,
        applicationHashFor: unused,
        botStateFor: unused,
        userConfigurationFor: unused,
        botConfigurationFor: unused,
        appletViewerSecret: secret,
        appletStateFor: (userId, appletId) => {
          expect([userId, appletId]).toEqual([OWNER, applet]);
          return {
            fetch: async (request) => {
              expect(request.url).not.toContain(token);
              for (const header of [
                "sec-websocket-protocol",
                "authorization",
                "cookie",
                "referer",
              ])
                expect(request.headers.get(header)).toBeNull();
              return stateFor(applet).fetch(request);
            },
          };
        },
      });
      const url = new URL(`https://bot.example/api/applets/${applet}/socket`);
      const headers = new Headers({
        upgrade: "websocket",
        authorization: "Bearer synthetic-app-session",
        cookie: "synthetic=app-cookie",
        referer: "https://bot.example/",
      });
      if (transport === "subprotocol")
        headers.set(
          "sec-websocket-protocol",
          `frockbot.applet.v1, frockbot.viewer.${token}`,
        );
      else url.searchParams.set("token", token);
      const response = await gateway(new Request(url, { headers }));
      expect(response.status).toBe(101);
      expect(response.headers.get("sec-websocket-protocol")).toBe(
        transport === "subprotocol" ? "frockbot.applet.v1" : null,
      );
      expect(JSON.stringify([...response.headers])).not.toContain(token);
      const socket = response.webSocket!;
      expect(socket).not.toBeNull();
      socket.accept();
      const echoed = new Promise<string>((resolve) => {
        socket.addEventListener("message", (event) =>
          resolve(String(event.data)),
        );
      });
      socket.send("gateway-ping");
      expect(await echoed).toBe("A:echo:gateway-ping");
      socket.close(1000, "done");
    },
  );
  const secret = env.APPLET_VIEWER_SECRET;

  test("a scoped token verifies, and one for another Applet or User does not", async () => {
    const applet = appletId("token");
    const other = appletId("tokenother");
    const claims = {
      u: OWNER,
      a: applet,
      g: "gen-1",
      exp: Math.floor((Date.now() + APPLET_VIEWER_TOKEN_TTL_MS) / 1_000),
    };
    const token = await mintAppletViewerTokenV1(secret, claims);
    expect(await verifyAppletViewerTokenV1(secret, token)).toEqual(claims);

    // Wrong Applet: the token verifies, but its claims name another Applet, and
    // the socket route compares them.
    const otherToken = await mintAppletViewerTokenV1(secret, {
      ...claims,
      a: other,
    });
    expect((await verifyAppletViewerTokenV1(secret, otherToken)).a).toBe(other);

    // Wrong User: the same comparison, on the other claim.
    const otherUser = await mintAppletViewerTokenV1(secret, {
      ...claims,
      u: "user-someone-else",
    });
    expect((await verifyAppletViewerTokenV1(secret, otherUser)).u).toBe(
      "user-someone-else",
    );

    // Wrong secret and expiry are both refused outright.
    await expect(
      verifyAppletViewerTokenV1(`${secret}-forged`, token),
    ).rejects.toThrow(/invalid/);
    const expired = await mintAppletViewerTokenV1(secret, {
      ...claims,
      exp: Math.floor(Date.now() / 1_000) - 1,
    });
    await expect(verifyAppletViewerTokenV1(secret, expired)).rejects.toThrow(
      /invalid/,
    );
  });

  test("a socket forwarded with the wrong applet or generation is refused", async () => {
    const applet = appletId("socket");
    const { generation } = await publishGeneration(applet, {
      version: "A",
      tools: ["list_todos"],
    });
    // The generation the token names has moved on: the page reloads rather than
    // talking to new code under an old claim.
    const stale = await stateFor(applet).connectViewer(
      new Request(
        `https://bot.example/api/applets/${applet}/socket?u=${OWNER}&a=${applet}&g=stale`,
      ),
    );
    expect(stale.status).toBe(409);

    // A claim naming another Applet never reaches this object's facet.
    const wrong = await stateFor(applet).connectViewer(
      new Request(
        `https://bot.example/api/applets/${applet}/socket?u=${OWNER}&a=${appletId("elsewhere")}&g=${encodeURIComponent(generation.generationId)}`,
      ),
    );
    expect(wrong.status).toBe(403);
  });

  test("a socket forwarded on the object's fetch door reaches the facet and upgrades", async () => {
    const applet = appletId("socket-open");
    const { generation } = await publishGeneration(applet, {
      version: "A",
      tools: ["list_todos"],
    });
    const response = await stateFor(applet).fetch(
      new Request(
        `https://bot.example/api/applets/${applet}/socket?u=${OWNER}&a=${applet}&g=${encodeURIComponent(generation.generationId)}`,
        { headers: { Upgrade: "websocket" } },
      ),
    );
    expect(
      response.status,
      response.status === 101 ? "" : await response.text(),
    ).toBe(101);
    expect(response.webSocket).not.toBeNull();
    const socket = response.webSocket!;
    socket.accept();
    const echoed = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) =>
        resolve(String(event.data)),
      );
    });
    socket.send("ping");
    expect(await echoed).toBe("A:echo:ping");
    socket.close(1000, "done");
  });
});

const TODO_TOOLS = ["add_todo", "list_todos"];

/**
 * Cut one publish short at a chosen durable write.
 *
 * A Durable Object can be shut down between any two of its storage calls, and
 * an individual call can fail on its own. Every write the object makes after
 * the candidate's health check passes is a place a publish can stop without
 * ever answering its caller, so this patches the object's durable surfaces —
 * both key/value APIs, the synchronous transaction, and the facet copy — and
 * throws at the nth of them. `evictDurableObject` supplies the other half of an
 * interruption: nothing in memory, patches included, survives it.
 */
function instrumentDurableWrites(
  state: DurableObjectState,
  options: { cutAt?: number; breakInsideCommit?: boolean },
): void {
  type AnyFn = (...args: never[]) => unknown;
  const storage = state.storage as unknown as Record<string, AnyFn> & {
    kv: Record<string, AnyFn>;
  };
  const facets = state.facets as unknown as Record<string, AnyFn>;
  const counter = { writes: 0 };
  const instrumented = state as unknown as {
    durableWrites: { writes: number };
    restoreDurableWrites: () => void;
  };
  instrumented.durableWrites = counter;
  const originalPut = Object.getOwnPropertyDescriptor(storage, "put");
  const originalDelete = Object.getOwnPropertyDescriptor(storage, "delete");
  const originalTransaction = Object.getOwnPropertyDescriptor(
    storage,
    "transactionSync",
  );
  const originalKv = Object.getOwnPropertyDescriptor(storage, "kv");
  const originalFacets = Object.getOwnPropertyDescriptor(state, "facets");
  const restore = (
    target: object,
    key: string,
    descriptor: PropertyDescriptor | undefined,
  ): void => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete (target as Record<string, unknown>)[key];
  };
  instrumented.restoreDurableWrites = () => {
    restore(storage, "put", originalPut);
    restore(storage, "delete", originalDelete);
    restore(storage, "transactionSync", originalTransaction);
    restore(storage, "kv", originalKv);
    restore(state, "facets", originalFacets);
  };
  const wrap =
    (label: string, original: AnyFn) =>
    (...args: never[]): unknown => {
      counter.writes += 1;
      if (counter.writes === options.cutAt) {
        throw new Error(
          `the Durable Object was interrupted before durable write ${counter.writes} (${label})`,
        );
      }
      return original(...args);
    };

  const kv = storage.kv;
  const patchedKv = {
    ...kv,
    get: kv.get.bind(kv),
    list: kv.list?.bind(kv),
    put: wrap("kv.put", kv.put.bind(kv)),
    delete: wrap("kv.delete", kv.delete.bind(kv)),
  };
  Object.defineProperty(storage, "kv", {
    configurable: true,
    get: () => patchedKv,
  });
  const transactionSync = storage.transactionSync.bind(storage) as (
    callback: () => unknown,
  ) => unknown;
  const guardTransaction = wrap(
    "storage.transactionSync",
    (() => undefined) as AnyFn,
  ) as () => void;
  storage.put = wrap("storage.put", storage.put.bind(storage)) as AnyFn;
  storage.delete = wrap(
    "storage.delete",
    storage.delete.bind(storage),
  ) as AnyFn;
  storage.transactionSync = ((callback: () => unknown): unknown => {
    guardTransaction();
    return transactionSync(() => {
      const result = callback();
      if (options.breakInsideCommit) {
        throw new Error("the Durable Object was interrupted inside the commit");
      }
      return result;
    });
  }) as AnyFn;
  const patchedFacets = {
    ...facets,
    get: facets.get.bind(facets),
    abort: facets.abort.bind(facets),
    clone: wrap("facets.clone", facets.clone.bind(facets)),
    delete: wrap("facets.delete", facets.delete.bind(facets)),
  };
  Object.defineProperty(state, "facets", {
    configurable: true,
    get: () => patchedFacets,
  });
}

/**
 * End an interruption: drop the instrumentation and, where the runtime lets go
 * of the object, evict it so the next caller starts from durable state alone.
 */
async function endInterruption(
  stub: ReturnType<typeof stateFor>,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    (
      state as unknown as { restoreDurableWrites?: () => void }
    ).restoreDurableWrites?.();
  });
  // An Applet that was cut mid-mount can still hold a facet reference, which
  // keeps the object resident. The durable state is what this test is about, so
  // a refused eviction is not a failure, and it is not worth waiting out.
  await Promise.race([
    evictDurableObject(stub).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
}

function generationIdFor(version: string): string {
  const second = version === "A" ? "01" : version === "B" ? "02" : "03";
  return `2026-09-05T00:00:${second}.000Z:${version}`;
}

/** How many durable writes an uninterrupted second publish makes. */
async function countPublishWrites(): Promise<number> {
  const applet = appletId("cutcount");
  await publishGeneration(applet, {
    version: "A",
    tools: TODO_TOOLS,
    generationId: generationIdFor("A"),
  });
  await invoke(applet, "add_todo", { title: "milk" });
  const stub = stateFor(applet);
  await runInDurableObject(stub, (_instance, state) => {
    instrumentDurableWrites(state, {});
  });
  const published = await publishGeneration(applet, {
    version: "B",
    tools: TODO_TOOLS,
    generationId: generationIdFor("B"),
  });
  expect(published.outcome).toMatchObject({ status: "active" });
  const writes = await runInDurableObject(stub, (_instance, state) =>
    Number(
      (state as unknown as { durableWrites?: { writes: number } }).durableWrites
        ?.writes ?? 0,
    ),
  );
  await endInterruption(stub);
  return writes;
}

describe("an interrupted Applet activation", () => {
  test("leaves the Applet coherent however the publish is cut short", async () => {
    const writes = await countPublishWrites();
    expect(writes).toBeGreaterThan(2);
    const cuts = [
      ...Array.from({ length: writes }, (_value, index) => ({
        label: `interrupted before durable write ${index + 1} of ${writes}`,
        options: { cutAt: index + 1 },
      })),
      {
        label: "interrupted inside the promotion commit",
        options: { breakInsideCommit: true },
      },
    ];

    for (const [index, cut] of cuts.entries()) {
      // The suffix ends in a non-zero character: `appletId` pads with zeroes,
      // and `cut1` and `cut10` would otherwise be the same Applet.
      const applet = appletId(`cut${index}x`);
      const previousId = generationIdFor("A");
      const candidateId = generationIdFor("B");
      expect(
        (
          await publishGeneration(applet, {
            version: "A",
            tools: TODO_TOOLS,
            generationId: previousId,
          })
        ).outcome,
      ).toMatchObject({ status: "active" });
      expect(await invoke(applet, "add_todo", { title: "milk" })).toMatchObject(
        {
          status: "ok",
        },
      );

      const stub = stateFor(applet);
      await runInDurableObject(stub, (_instance, state) => {
        instrumentDurableWrites(state, cut.options);
      });
      await publishGeneration(applet, {
        version: "B",
        tools: TODO_TOOLS,
        generationId: candidateId,
      }).catch(() => undefined);
      await endInterruption(stub);

      const view = await stateFor(applet).read({
        schemaVersion: 1,
        userId: OWNER,
        appletId: applet,
      });
      const current = view.current?.generationId;
      // Either generation is a correct answer; a pointer naming neither, or
      // naming one whose code is not the resident code, is not.
      expect([previousId, candidateId], cut.label).toContain(current);
      expect(
        view.generations.find(
          (generation) => generation.generationId === current,
        )?.status,
        `${cut.label}: the current generation is not recorded active`,
      ).toBe("active");
      // The pinned call is the proof: the code that answers it is the code the
      // pointer names, over the data the Applet held before the publish.
      expect(
        await invoke(applet, "list_todos", {}, current),
        `${cut.label}: the resident generation does not match the pointer`,
      ).toMatchObject({
        status: "ok",
        content: `${current === previousId ? "A" : "B"}:milk`,
      });

      // And the Applet is publishable again rather than stuck until some later
      // publish happens to repair it.
      expect(
        (
          await publishGeneration(applet, {
            version: "C",
            tools: TODO_TOOLS,
            generationId: generationIdFor("C"),
          })
        ).outcome,
        cut.label,
      ).toMatchObject({ status: "active" });
      expect(await invoke(applet, "list_todos", {}), cut.label).toMatchObject({
        status: "ok",
        content: "C:milk",
      });
    }
  });

  test("an unreadable trial marker restores the rollback copy instead of deleting the evidence", async () => {
    const applet = appletId("corrupttrial");
    const previousId = generationIdFor("A");
    expect(
      (
        await publishGeneration(applet, {
          version: "A",
          tools: TODO_TOOLS,
          generationId: previousId,
        })
      ).outcome,
    ).toMatchObject({ status: "active" });
    expect(await invoke(applet, "add_todo", { title: "milk" })).toMatchObject({
      status: "ok",
    });

    const stub = stateFor(applet);
    // The durable shape an activation leaves behind: a snapshot of the live
    // facet parked in the rollback facet, and a trial marker over it.
    await runInDurableObject(stub, (_instance, state) => {
      state.facets.abort(APPLET_FACET_NAME_V1, new Error("taking a snapshot"));
      state.facets.clone(APPLET_FACET_NAME_V1, APPLET_ROLLBACK_FACET_NAME_V1);
    });
    // What a candidate generation writes to live storage before it is admitted.
    expect(await invoke(applet, "add_todo", { title: "eggs" })).toMatchObject({
      status: "ok",
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put(APPLET_TRIAL_KEY, "this is not a trial record");
    });
    await endInterruption(stub);

    const view = await stateFor(applet).read({
      schemaVersion: 1,
      userId: OWNER,
      appletId: applet,
    });
    expect(view.current?.generationId).toBe(previousId);
    // The marker could not be read, so the snapshot is the only trusted state —
    // and it is restored, rather than deleted along with the marker.
    expect(await invoke(applet, "list_todos", {}, previousId)).toMatchObject({
      status: "ok",
      content: "A:milk",
    });
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.kv.get(APPLET_TRIAL_KEY),
      ),
    ).toBeUndefined();
  });
});
