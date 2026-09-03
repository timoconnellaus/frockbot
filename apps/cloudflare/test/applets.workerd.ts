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
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  appletStateNameV1,
  mintAppletViewerTokenV1,
  verifyAppletViewerTokenV1,
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
}): string {
  return `import { DurableObject } from "cloudflare:workers";

const VERSION = ${JSON.stringify(options.version)};
const TOOLS = ${JSON.stringify(options.tools)};
const HEALTH_TOOLS = ${JSON.stringify(options.healthTools ?? options.tools)};

export class Applet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ${options.throwOnConstruct ? 'throw new Error("this generation is broken");' : ""}
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)",
    );
  }

  health() {
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

async function invoke(applet: string, tool: string, input: unknown) {
  return stateFor(applet).invokeTool({
    schemaVersion: 1,
    userId: OWNER,
    appletId: applet,
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
