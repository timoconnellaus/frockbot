import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/agent-core";
import type {
  BotStateBinding,
  GatewayAuth,
  LoadedWorker,
  MemoryBindings,
  StoredRun,
  WorkerCode,
  WorkerLoader,
} from "./contracts.js";
import { applicationDeploymentId, createGateway } from "./gateway.js";
import { createUserApplication } from "./user-application.js";

class MemoryBotState implements BotStateBinding {
  private readonly runs = new Map<string, StoredRun[]>();
  private readonly sessions = new Map<string, SessionEvent[]>();

  async acceptRun(
    botId: string,
    run: Omit<StoredRun, "events">,
  ): Promise<SessionEvent[]> {
    const runs = this.runs.get(botId) ?? [];
    if (runs.some((candidate) => candidate.runId === run.runId)) {
      throw new Error("duplicate run");
    }
    if (runs.some((candidate) => candidate.events.length === 0)) {
      throw new Error("bot already has an active run");
    }
    runs.push({ ...run, events: [] });
    this.runs.set(botId, runs);
    return structuredClone(this.sessions.get(botId) ?? []);
  }

  async completeRun(
    botId: string,
    runId: string,
    events: SessionEvent[],
  ): Promise<void> {
    const run = this.runs
      .get(botId)
      ?.find((candidate) => candidate.runId === runId);
    if (!run) throw new Error("run was not accepted");
    const previousEvents = this.sessions.get(botId) ?? [];
    run.events = structuredClone(events.slice(previousEvents.length));
    this.sessions.set(botId, structuredClone(events));
  }

  async listRuns(botId: string): Promise<StoredRun[]> {
    return structuredClone(this.runs.get(botId) ?? []);
  }
}

class DirectWorkerLoader implements WorkerLoader {
  readonly ids: string[] = [];
  readonly codes: WorkerCode[] = [];
  private readonly fetchApplication = createUserApplication();

  get(id: string, callback: () => Promise<WorkerCode>): LoadedWorker {
    this.ids.push(id);
    return {
      getEntrypoint: () => ({
        fetch: async (request) => {
          const code = await callback();
          this.codes.push(code);
          return this.fetchApplication(request, code.env);
        },
      }),
    };
  }
}

const unauthenticatedAuth: GatewayAuth = {
  handler: () => Promise.resolve(new Response("auth handler")),
  getSession: () => Promise.resolve(null),
};

function testMemoryBindings(): MemoryBindings {
  return {
    MEMORY_FILES: {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve({ objects: [], truncated: false }),
    },
    MEMORY_INDEX: {
      upsert: () => Promise.resolve(),
      query: () => Promise.resolve({ matches: [] }),
      deleteByIds: () => Promise.resolve(),
    },
    AI: {
      run: (_model, input) =>
        Promise.resolve({
          data: input.text.map(() => Array.from({ length: 768 }, () => 0)),
        }),
    },
  };
}

function createTestGateway(
  applicationHashFor: (userId: string) => Promise<string> = () =>
    Promise.resolve("foundation-v1"),
  auth: GatewayAuth = unauthenticatedAuth,
  allowDevelopmentIdentity = true,
) {
  const loader = new DirectWorkerLoader();
  const states = new Map<string, MemoryBotState>();
  const gateway = createGateway({
    loader,
    artifacts: { load: () => Promise.resolve("export default {}") },
    auth,
    applicationHashFor,
    botStateFor: (userId) => {
      const state = states.get(userId) ?? new MemoryBotState();
      states.set(userId, state);
      return state;
    },
    memory: testMemoryBindings(),
    allowDevelopmentIdentity,
  });
  return { gateway, loader, states };
}

function request(path: string, userId: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("x-frockbot-user-id", userId);
  return new Request(`https://frockbot.test${path}`, { ...init, headers });
}

describe("Cloudflare user application gateway", () => {
  test("uses an immutable user and application deployment id", () => {
    expect(
      applicationDeploymentId({
        userId: "alice",
        applicationHash: "sha256-abcd",
      }),
    ).toBe("alice:sha256-abcd");
    expect(() =>
      applicationDeploymentId({ userId: "../alice", applicationHash: "valid" }),
    ).toThrow("invalid user id");
  });

  test("selects each user's active immutable application", async () => {
    const { gateway, loader } = createTestGateway((userId) =>
      Promise.resolve(userId === "alice" ? "application-a" : "application-b"),
    );
    await gateway(request("/", "alice"));
    await gateway(request("/", "bob"));
    expect(loader.ids).toEqual(["alice:application-a", "bob:application-b"]);
  });

  test("serves UI and agent behavior through the same user application", async () => {
    const { gateway, loader } = createTestGateway();

    const page = await gateway(request("/", "alice"));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-frockbot-user-id="alice"');
    expect(html).toContain('data-frockbot-user-application="foundation-v1"');
    const script = await gateway(request("/app.js", "alice"));
    expect(script.headers.get("content-type")).toContain("text/javascript");
    const stylesheet = await gateway(request("/app.css", "alice"));
    expect(stylesheet.headers.get("content-type")).toContain("text/css");

    const turn = await gateway(
      request("/api/bots/primary/turns", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "/echo hello workers" }),
      }),
    );
    expect(turn.status).toBe(200);
    expect(await turn.json()).toMatchObject({ text: "Echo: hello workers" });
    expect(new Set(loader.ids)).toEqual(new Set(["alice:foundation-v1"]));
    expect(loader.codes.every((code) => code.globalOutbound === null)).toBe(
      true,
    );
  });

  test("shares the user deployment while isolating bot state", async () => {
    const { gateway, loader } = createTestGateway();
    for (const botId of ["alpha", "beta"]) {
      const response = await gateway(
        request(`/api/bots/${botId}/turns`, "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: `hello ${botId}` }),
        }),
      );
      expect(response.status).toBe(200);
    }

    const alpha = await gateway(request("/api/bots/alpha/turns", "alice"));
    const beta = await gateway(request("/api/bots/beta/turns", "alice"));
    const alphaRuns = (await alpha.json()) as { runs: StoredRun[] };
    const betaRuns = (await beta.json()) as { runs: StoredRun[] };
    expect(alphaRuns.runs).toHaveLength(1);
    expect(betaRuns.runs).toHaveLength(1);
    expect(alphaRuns.runs[0]?.input).toBe("hello alpha");
    expect(betaRuns.runs[0]?.input).toBe("hello beta");
    expect(new Set(loader.ids)).toEqual(new Set(["alice:foundation-v1"]));
  });

  test("rehydrates one bot session across disposable application runtimes", async () => {
    const { gateway } = createTestGateway();
    const responses: Array<{ events: SessionEvent[] }> = [];
    for (const text of ["first turn", "second turn"]) {
      const response = await gateway(
        request("/api/bots/continuing/turns", "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }),
      );
      expect(response.status).toBe(200);
      responses.push((await response.json()) as { events: SessionEvent[] });
    }
    expect(
      responses[1]?.events
        .filter((event) => event.type === "turn/start")
        .map((event) => event.turn),
    ).toEqual([2]);
    expect(
      responses[1]?.events.some((event) => event.type === "session/created"),
    ).toBe(false);

    const history = await gateway(
      request("/api/bots/continuing/turns", "alice"),
    );
    const { runs } = (await history.json()) as { runs: StoredRun[] };
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.sessionId))).toEqual(
      new Set(["alice:continuing"]),
    );
    const sessionEvents = runs.flatMap((run) => run.events);
    expect(
      sessionEvents
        .filter((event) => event.type === "turn/start")
        .map((event) => event.turn),
    ).toEqual([1, 2]);
    expect(
      sessionEvents
        .filter((event) => event.type === "user/message")
        .map((event) => event.text),
    ).toEqual(["first turn", "second turn"]);
    expect(sessionEvents.every((event, index) => event.seq === index)).toBe(
      true,
    );
  });

  test("separates different users and durably accepts before execution", async () => {
    const { gateway, loader, states } = createTestGateway();
    for (const userId of ["alice", "bob"]) {
      const response = await gateway(
        request("/api/bots/default/turns", userId, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: `hello ${userId}` }),
        }),
      );
      expect(response.status).toBe(200);
    }

    expect(new Set(loader.ids)).toEqual(
      new Set(["alice:foundation-v1", "bob:foundation-v1"]),
    );
    const aliceRuns = await states.get("alice")?.listRuns("default");
    const bobRuns = await states.get("bob")?.listRuns("default");
    expect(aliceRuns?.[0]?.input).toBe("hello alice");
    expect(bobRuns?.[0]?.input).toBe("hello bob");
    expect(aliceRuns?.[0]?.events[0]?.type).toBe("session/created");
    expect(
      aliceRuns?.[0]?.events.findIndex(
        (event) => event.type === "model/request",
      ),
    ).toBeLessThan(
      aliceRuns?.[0]?.events.findIndex(
        (event) => event.type === "assistant/message",
      ) ?? -1,
    );
  });

  test("persists the browser development identity from the query seam", async () => {
    const { gateway } = createTestGateway();
    const page = await gateway(
      new Request("https://frockbot.test/?as_user=alice"),
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toContain("frockbot_dev_user=alice");
    const script = await gateway(
      new Request("https://frockbot.test/app.js", {
        headers: { cookie: "frockbot_dev_user=alice" },
      }),
    );
    expect(script.status).toBe(200);
  });

  test("serves the public shell but rejects unauthenticated application APIs", async () => {
    const { gateway } = createTestGateway();
    const page = await gateway(new Request("https://frockbot.test/"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-frockbot-user-id="anonymous"');

    const response = await gateway(
      new Request("https://frockbot.test/api/bots/default/turns"),
    );
    expect(response.status).toBe(401);
  });

  test("ignores development identity headers unless explicitly enabled", async () => {
    const { gateway } = createTestGateway(
      undefined,
      unauthenticatedAuth,
      false,
    );
    const response = await gateway(request("/api/bots/default/turns", "alice"));
    expect(response.status).toBe(401);
  });

  test("mounts Better Auth routes before application routing", async () => {
    const { gateway, loader } = createTestGateway();
    const response = await gateway(
      new Request("https://frockbot.test/api/auth/get-session"),
    );
    expect(await response.text()).toBe("auth handler");
    expect(loader.ids).toEqual([]);
  });

  test("derives the application identity from the Better Auth session", async () => {
    const auth: GatewayAuth = {
      handler: unauthenticatedAuth.handler,
      getSession: () => Promise.resolve({ user: { id: "signed-in-user" } }),
    };
    const { gateway, loader } = createTestGateway(undefined, auth);
    const response = await gateway(new Request("https://frockbot.test/"));
    expect(response.status).toBe(200);
    expect(loader.ids).toEqual(["signed-in-user:foundation-v1"]);
  });
});
