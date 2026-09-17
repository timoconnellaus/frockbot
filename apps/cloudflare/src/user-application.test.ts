import { describe, expect, test } from "bun:test";
import type {
  BotStateBinding,
  BotTurnResult,
  UserApplicationEnv,
  UserBotStateBinding,
} from "./contracts.js";
import {
  createUserApplication,
  HOSTED_EMBEDDED_BODY_ATTRIBUTES_V1,
} from "./user-application.js";
import {
  APPLETS_UNAVAILABLE_MESSAGE_V1,
  BotTurnRefusedError,
} from "@frockbot/core/durable";
import { COMPUTER_HOST_CAPABILITIES_V1 } from "./computer-host.js";
import { AppletUnavailableError } from "./applet-directory.js";

function rpcBindingFor(state: BotStateBinding): UserBotStateBinding {
  return {
    assertRegistered: () => Promise.resolve(),
    deleteApplet: () => Promise.resolve({ status: "deleted" }),
    listApplets: () =>
      Promise.resolve({ schemaVersion: 1, revision: 0, applets: [] }),
    readBotAppletImpact: ({ botId }) =>
      Promise.resolve({
        schemaVersion: 1,
        botId,
        fingerprint: "0123456789abcdef",
        applets: [],
      }),
    mintAppletViewerToken: () =>
      Promise.reject(new Error("Applet is unavailable")),
    readAppletUi: () => Promise.reject(new Error("Applet is unavailable")),
    openFocusedApplet: () =>
      Promise.resolve({ schemaVersion: 1 as const, applets: [] }),
    readFocusedApplet: () =>
      Promise.resolve({
        schemaVersion: 1,
        appletId: null,
        changedAt: new Date(0).toISOString(),
      }),
    setFocusedApplet: ({ appletId }) =>
      Promise.resolve({
        schemaVersion: 1,
        appletId,
        changedAt: new Date(0).toISOString(),
      }),
    listSkills: () =>
      Promise.resolve({ schemaVersion: 1 as const, skills: [] }),
    listPackageUi: ({ botId }) =>
      Promise.resolve({
        schemaVersion: 1 as const,
        botId,
        generationId: "foundation-v1",
        contributions: [],
      }),
    runPackageUiTool: ({ botId, command }) =>
      state.run(botId, {
        runId: command.commandId,
        sessionId: `session:${botId}`,
        acceptedAt: new Date().toISOString(),
        text: command.name,
      }),
    readWorkspaceFileV1: () =>
      Promise.resolve({
        schemaVersion: 1 as const,
        status: "not-found" as const,
        reason: "no workspace in this test",
      }),
    readAppletSourceV1: ({ appletId }) =>
      Promise.resolve({ appletId, files: [], truncated: false }),
    readAppletBuildV1: () => Promise.resolve({ status: "unknown" as const }),
    run: ({ botId, command }) => state.run(botId, command),
    listRuns: ({ botId, query }) => state.listRuns(botId, query),
    lookupRun: ({ botId, query }) => state.lookupRun(botId, query),
    fenceRunAdmission: ({ botId, query }) =>
      state.fenceRunAdmission(botId, query),
    listNotifications: ({ botId }) => state.listNotifications(botId),
    listApprovals: ({ botId }) => state.listApprovals(botId),
    decideApproval: ({ botId, approvalId, command }) =>
      state.decideApproval(botId, approvalId, command),
    listCards: ({ botId }) => state.listCards(botId),
    readCard: ({ botId, surfaceId }) => state.readCard(botId, surfaceId),
    cardAction: ({ botId, command }) => state.cardAction(botId, command),
    acknowledgeNotification: ({ botId, notificationId }) =>
      state.acknowledgeNotification(botId, notificationId),
    stopRun: ({ botId, command }) => state.stopRun(botId, command),
  };
}

function parseContentSecurityPolicy(
  header: string | null,
): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of (header ?? "").split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

const securityEnv = {
  DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
} as unknown as UserApplicationEnv;

/** The projection the gateway stamps on a signed-in development session. */
const developmentSession = {
  "x-frockbot-auth-session-v1": "development",
  "x-frockbot-is-admin-v1": "false",
};

describe("user application security headers", () => {
  test("strictly projects the gateway-owned auth mode into the hosted shell", async () => {
    const fetchUserApplication = createUserApplication();
    const response = await fetchUserApplication(
      new Request("https://app.example/", {
        headers: {
          "x-frockbot-auth-session-v1": "development",
          "x-frockbot-is-admin-v1": "true",
        },
      }),
      securityEnv,
    );
    const html = await response.text();
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    );
    expect(html).toContain('data-frockbot-auth-mode="development"');
    expect(html).toContain('data-frockbot-is-admin="true"');
    for (const attribute of HOSTED_EMBEDDED_BODY_ATTRIBUTES_V1) {
      expect(html).toContain(`${attribute}="`);
    }

    for (const mode of [undefined, "desktop", "development,better-auth"]) {
      const headers = mode ? { "x-frockbot-auth-session-v1": mode } : undefined;
      // Fail closed, and stay alive doing it. The refusal used to escape the
      // Worker's own `fetch`, which is an entry point with no caller: the
      // isolate died rather than answering. What matters is that no shell is
      // ever built from a projection the gateway did not write, and the
      // refusal now says so with its own reason instead of taking the
      // isolate down.
      const refused = await fetchUserApplication(
        new Request("https://app.example/", { headers }),
        securityEnv,
      );
      expect(refused.status).toBe(500);
      expect(await refused.json()).toMatchObject({
        error: expect.stringContaining("hosted auth session projection"),
      });
    }
  });

  test("serves the document with the policy the Flutter engine needs", async () => {
    const fetchUserApplication = createUserApplication();

    const response = await fetchUserApplication(
      new Request("https://app.example/", { headers: developmentSession }),
      securityEnv,
    );

    expect(response.status).toBe(200);
    const policy = parseContentSecurityPolicy(
      response.headers.get("content-security-policy"),
    );
    // The client bundles Manrope and Archivo Black, and CanvasKit paints
    // images through blob URLs.
    expect(policy.get("font-src")).toEqual(["'self'", "data:"]);
    expect(policy.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    // Two deliberate relaxations, and neither is optional: CanvasKit
    // instantiates WebAssembly, and the engine injects a `<style>` element to
    // measure text. The artifact origin's own policy is untouched.
    expect(policy.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    // The zone injects the Cloudflare Insights beacon above this Worker, so a
    // policy that refused it logged a console error on every page load.
    expect(policy.get("script-src")).toEqual([
      "'self'",
      "'wasm-unsafe-eval'",
      "https://static.cloudflareinsights.com",
    ]);
    expect(policy.get("connect-src")).toEqual([
      "'self'",
      "https://cloudflareinsights.com",
      "wss://app.example",
    ]);
    // The document sets a `<base href>` of its own to the content-addressed
    // directory the engine's URLs are relative to.
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    // Package pages use the anonymous UI origin; the expanded Computer viewer
    // frames a page the Computer host serves, and the policy names whatever
    // origins that host declared rather than a literal of its own.
    expect(policy.get("frame-src")).toEqual([
      "https://ui.app.example",
      ...COMPUTER_HOST_CAPABILITIES_V1.viewerFrameOrigins,
    ]);
    expect(
      COMPUTER_HOST_CAPABILITIES_V1.viewerFrameOrigins.length,
    ).toBeGreaterThan(0);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
  });

  test("permits the same-origin development WebSocket explicitly", async () => {
    const response = await createUserApplication()(
      new Request("http://localhost:8787/", { headers: developmentSession }),
      securityEnv,
    );
    const policy = parseContentSecurityPolicy(
      response.headers.get("content-security-policy"),
    );
    expect(policy.get("connect-src")).toEqual([
      "'self'",
      "https://cloudflareinsights.com",
      "ws://localhost:8787",
    ]);
  });

  test("boots the Flutter client from one content-addressed directory", async () => {
    const response = await createUserApplication()(
      new Request("https://app.example/", { headers: developmentSession }),
      securityEnv,
    );
    const html = await response.text();
    const base = html.match(/<base href="([^"]+)">/)?.[1];
    expect(base).toMatch(/^\/_flutter\/[a-z0-9]+\/$/);
    // One script, under the same prefix, so the document is the only thing
    // that changes when the client does.
    expect(html).toContain(`<script src="${base}flutter_bootstrap.js" async>`);
    expect(html).not.toContain("/app.js");
    expect(html).not.toContain("/app.css");
  });

  test("serves the site icon the hosted shell links", async () => {
    const fetchUserApplication = createUserApplication();

    const shell = await fetchUserApplication(
      new Request("https://app.example/", {
        headers: {
          "x-frockbot-auth-session-v1": "development",
          "x-frockbot-is-admin-v1": "false",
        },
      }),
      securityEnv,
    );
    const html = await shell.text();
    expect(html).toContain(
      '<link rel="icon" type="image/png" href="/favicon.ico">',
    );

    const icon = await fetchUserApplication(
      new Request("https://app.example/favicon.ico"),
      securityEnv,
    );

    expect(icon.status).toBe(200);
    // The icon rides the artifact as a PNG, so the declared type must stay PNG
    // under the `nosniff` header the security wrapper always sets.
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("user application Bot seam", () => {
  test("projects Package UI and forwards exact direct-tool commands", async () => {
    const toolCommands: unknown[] = [];
    const result: BotTurnResult = {
      schemaVersion: 1,
      runId: "command-1",
      text: "Sydney Weather",
      events: [],
    };
    const binding = rpcBindingFor({} as BotStateBinding);
    binding.listPackageUi = ({ botId }) =>
      Promise.resolve({
        schemaVersion: 1,
        botId,
        contributions: [],
      });
    binding.runPackageUiTool = (request) => {
      toolCommands.push(request);
      return Promise.resolve(result);
    };
    const env: UserApplicationEnv = {
      BOT_STATE: binding,
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const fetchUserApplication = createUserApplication();

    const catalogResponse = await fetchUserApplication(
      new Request("https://app.example/api/bots/primary/package-ui"),
      env,
    );
    expect(catalogResponse.status).toBe(200);
    expect((await catalogResponse.json()) as Record<string, unknown>).toEqual({
      schemaVersion: 1,
      botId: "primary",
      artifactOrigin: "https://ui.app.example",
      contributions: [],
    });

    const command = {
      schemaVersion: 1 as const,
      commandId: "command-1",
      packageId: "weather-page",
      name: "weather_lookup",
      input: { city: "Sydney" },
    };
    const toolResponse = await fetchUserApplication(
      new Request("https://app.example/api/bots/primary/package-ui/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
      env,
    );
    expect(toolResponse.status).toBe(200);
    expect((await toolResponse.json()) as BotTurnResult).toEqual(result);
    expect(toolCommands).toEqual([
      { schemaVersion: 1, botId: "primary", command },
    ]);
  });

  test("delegates an admitted turn to the Bot owner", async () => {
    const calls: Array<{ botId: string; text: string }> = [];
    const result: BotTurnResult = {
      schemaVersion: 1,
      runId: "run-1",
      text: "owned by bot",
      events: [],
    };
    const botState: BotStateBinding = {
      run: (botId, command) => {
        calls.push({ botId, text: command.text });
        return Promise.resolve(result);
      },
      listRuns: () =>
        Promise.resolve({
          schemaVersion: 1,
          runs: [],
          page: { truncated: false },
        }),
      lookupRun: () =>
        Promise.resolve({ schemaVersion: 1, state: "not-admitted" }),
      fenceRunAdmission: () =>
        Promise.resolve({ schemaVersion: 1, state: "not-admitted" }),
      listNotifications: () => Promise.resolve([]),
      listApprovals: (botId) =>
        Promise.resolve({
          schemaVersion: 1 as const,
          botId,
          approvals: [],
          pending: 0,
        }),
      decideApproval: () => Promise.reject(new Error("unexpected")),
      listCards: (botId) =>
        Promise.resolve({ schemaVersion: 1 as const, botId, cards: [] }),
      readCard: () => Promise.reject(new Error("unexpected")),
      cardAction: () => Promise.reject(new Error("unexpected")),
      acknowledgeNotification: () => Promise.resolve(),
      stopRun: () => Promise.reject(new Error("must not stop")),
    };
    const env: UserApplicationEnv = {
      BOT_STATE: rpcBindingFor(botState),
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };

    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/turns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          text: "hello",
          commandId: "command-1",
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as BotTurnResult).toEqual(result);
    expect(calls).toEqual([{ botId: "primary", text: "hello" }]);
  });

  test("answers a refused admission 409, and a real fault 500", async () => {
    const refusals = [
      { thrown: "bot already has an active run", reason: "busy" },
      { thrown: 'run "run-1" admission was fenced', reason: "fenced" },
      { thrown: 'run "run-1" already exists', reason: "duplicate" },
    ] as const;
    const post = async (thrown: string | Error): Promise<Response> => {
      const botState = {
        run: () =>
          Promise.reject(
            typeof thrown === "string" ? new Error(thrown) : thrown,
          ),
        assertRegistered: () => Promise.resolve(),
      } as unknown as BotStateBinding;
      return createUserApplication()(
        new Request("https://frockbot.test/api/bots/primary/turns", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            text: "hello",
            commandId: "command-1",
            supersedes: {},
          }),
        }),
        {
          BOT_STATE: rpcBindingFor(botState),
          DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
        } satisfies UserApplicationEnv,
      );
    };

    for (const refusal of refusals) {
      const response = await post(refusal.thrown);
      // A refused admission is the Bot's current state answering, not a
      // server fault. 500 made the client log a console error for something it
      // should simply show the person.
      expect(response.status).toBe(409);
      expect(await response.json<unknown>()).toEqual({
        schemaVersion: 1,
        status: "refused",
        reason: refusal.reason,
        error: refusal.thrown,
      });
    }

    // A refusal the authority typed is classified by what it says it is, so
    // rewording the sentence can never turn a 409 into a 500 again.
    const typed = await post(
      new BotTurnRefusedError(
        "busy",
        'run "run-1" is queued: the Bot owes an answer first',
      ),
    );
    expect(typed.status).toBe(409);
    expect(await typed.json<unknown>()).toMatchObject({
      status: "refused",
      reason: "busy",
    });

    // Anything the Bot did not refuse on purpose is still a fault.
    const broken = await post("the Composition could not mount");
    expect(broken.status).toBe(500);
    expect(await broken.json<unknown>()).toEqual({
      error: "the Composition could not mount",
    });
  });

  test("rejects every unregistered Bot route before dispatch", async () => {
    let dispatches = 0;
    const unexpected = () => {
      dispatches += 1;
      return Promise.reject(new Error("must not dispatch"));
    };
    const missing = new Error('Bot "missing" is not registered');
    missing.name = "BotNotFoundError";
    const env = {
      BOT_STATE: {
        assertRegistered: () => Promise.reject(missing),
        run: unexpected,
        listRuns: unexpected,
        lookupRun: unexpected,
        fenceRunAdmission: unexpected,
        listNotifications: unexpected,
        acknowledgeNotification: unexpected,
        stopRun: unexpected,
      } as unknown as UserBotStateBinding,
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    } satisfies UserApplicationEnv;
    const fetchUserApplication = createUserApplication();
    const requests = [
      new Request("https://frockbot.test/api/bots/missing/turns"),
      new Request("https://frockbot.test/api/bots/missing/turns", {
        method: "POST",
        body: "{}",
      }),
      new Request("https://frockbot.test/api/bots/missing/turns/run-1"),
      new Request("https://frockbot.test/api/bots/missing/turns/run-1/fence", {
        method: "POST",
        body: "{}",
      }),
      new Request("https://frockbot.test/api/bots/missing/turns/run-1/stop", {
        method: "POST",
        body: "{}",
      }),
      new Request("https://frockbot.test/api/bots/missing/notifications"),
      new Request("https://frockbot.test/api/bots/missing/notifications", {
        method: "POST",
        body: "{}",
      }),
    ];
    for (const request of requests) {
      expect((await fetchUserApplication(request, env)).status).toBe(404);
    }
    expect(dispatches).toBe(0);
  });

  test("archived Bots allow history reads but reject commands before dispatch", async () => {
    let dispatches = 0;
    const reads: string[] = [];
    const unexpected = () => {
      dispatches += 1;
      return Promise.reject(new Error("must not dispatch"));
    };
    const archived = new Error('Bot "primary" is archived');
    archived.name = "BotArchivedError";
    const env = {
      BOT_STATE: {
        assertRegistered: () => Promise.reject(archived),
        listRuns: ({ botId }: { botId: string }) => {
          reads.push(`list:${botId}`);
          return Promise.resolve({
            schemaVersion: 1,
            runs: [],
            nextCursor: null,
          });
        },
        lookupRun: ({ botId }: { botId: string }) => {
          reads.push(`lookup:${botId}`);
          return Promise.resolve({ schemaVersion: 1, state: "not-admitted" });
        },
        run: unexpected,
        fenceRunAdmission: unexpected,
        stopRun: unexpected,
        listNotifications: unexpected,
        acknowledgeNotification: unexpected,
      } as unknown as UserBotStateBinding,
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    } satisfies UserApplicationEnv;
    const fetchUserApplication = createUserApplication();
    const base = "https://frockbot.test/api/bots/primary";
    for (const path of ["/turns", "/turns/run-1"]) {
      expect(
        (await fetchUserApplication(new Request(base + path), env)).status,
      ).toBe(200);
    }
    expect(reads).toEqual(["list:primary", "lookup:primary"]);
    for (const path of [
      "/turns",
      "/turns/run-1/fence",
      "/turns/run-1/stop",
      "/notifications",
    ]) {
      const response = await fetchUserApplication(
        new Request(base + path, { method: "POST", body: "{}" }),
        env,
      );
      expect(response.status).toBe(409);
      expect(await response.json<unknown>()).toEqual({
        error: 'Bot "primary" is archived',
      });
    }
    expect(
      (await fetchUserApplication(new Request(base + "/notifications"), env))
        .status,
    ).toBe(409);
    expect(dispatches).toBe(0);
  });

  test("keeps registration infrastructure failures retryable", async () => {
    const env = {
      BOT_STATE: {
        assertRegistered: () =>
          Promise.reject(new Error("User directory unavailable")),
      } as unknown as UserBotStateBinding,
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    } satisfies UserApplicationEnv;
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/turns"),
      env,
    );
    expect(response.status).toBe(503);
    expect((await response.json()) as { error: string }).toEqual({
      error: "User directory unavailable",
    });
  });

  test("rejects noncanonical Bot path identifiers before authority lookup", async () => {
    let authorityChecks = 0;
    const env = {
      BOT_STATE: {
        assertRegistered: () => {
          authorityChecks += 1;
          return Promise.resolve();
        },
      } as unknown as UserBotStateBinding,
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    } satisfies UserApplicationEnv;
    const fetchUserApplication = createUserApplication();
    for (const botId of ["bad:bot", "bad@bot", "b".repeat(129)]) {
      const response = await fetchUserApplication(
        new Request(`https://frockbot.test/api/bots/${botId}/turns`),
        env,
      );
      expect(response.status).toBe(400);
    }
    expect(authorityChecks).toBe(0);
  });

  test("admits every hosted Turn as chat and forwards no client turn type", async () => {
    const forwarded: Record<string, unknown>[] = [];
    const result: BotTurnResult = {
      schemaVersion: 1,
      runId: "run-1",
      text: "ok",
      events: [],
    };
    const botState = {
      run: (_botId: string, command: Record<string, unknown>) => {
        forwarded.push(command);
        return Promise.resolve(result);
      },
    } as unknown as BotStateBinding;
    const env: UserApplicationEnv = {
      BOT_STATE: rpcBindingFor(botState),
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const fetchUserApplication = createUserApplication();

    // A client naming a turn type or an origin is refused outright.
    for (const body of [
      {
        schemaVersion: 1,
        commandId: "run-1",
        text: "hi",
        turnType: "automation",
      },
      { schemaVersion: 1, commandId: "run-1", text: "hi", turnType: "chat" },
      {
        schemaVersion: 1,
        commandId: "run-1",
        text: "hi",
        origin: {
          kind: "routine",
          routineId: "r",
          fireId: "f",
          trigger: "cron",
        },
      },
    ]) {
      const rejected = await fetchUserApplication(
        new Request("https://frockbot.test/api/bots/primary/turns", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      );
      expect(rejected.status).toBe(400);
    }
    expect(forwarded).toEqual([]);

    const response = await fetchUserApplication(
      new Request("https://frockbot.test/api/bots/primary/turns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "run-1",
          text: "hi",
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    // Absent means chat: the HTTP path never carries the field at all.
    expect(forwarded).toHaveLength(1);
    expect(Object.hasOwn(forwarded[0]!, "turnType")).toBe(false);
    expect(Object.hasOwn(forwarded[0]!, "origin")).toBe(false);
  });

  test("rejects unversioned, future, and inexact hosted Turn commands", async () => {
    let calls = 0;
    const botState = {
      run: () => {
        calls += 1;
        return Promise.reject(new Error("must not run"));
      },
    } as unknown as BotStateBinding;
    const env: UserApplicationEnv = {
      BOT_STATE: rpcBindingFor(botState),
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const fetchUserApplication = createUserApplication();

    for (const body of [
      { commandId: "run-1", text: "hi" },
      { schemaVersion: 2, commandId: "run-1", text: "hi" },
      {
        schemaVersion: 1,
        commandId: "run-1",
        text: "hi",
        action: "cancel",
      },
    ]) {
      const response = await fetchUserApplication(
        new Request("https://frockbot.test/api/bots/primary/turns", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        env,
      );
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  test("rejects inexact notification commands", async () => {
    let acknowledgements = 0;
    const botState = {
      acknowledgeNotification: () => {
        acknowledgements += 1;
        return Promise.resolve();
      },
    } as unknown as BotStateBinding;
    const env: UserApplicationEnv = {
      BOT_STATE: rpcBindingFor(botState),
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const fetchUserApplication = createUserApplication();

    const invalidRequests = [
      new Request("https://frockbot.test/api/bots/primary/notifications", {
        method: "POST",
        body: JSON.stringify({ notificationId: "notification-1" }),
      }),
      new Request("https://frockbot.test/api/bots/primary/notifications", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          action: "acknowledge",
          notificationId: "notification-1",
          extra: true,
        }),
      }),
    ];
    for (const request of invalidRequests) {
      expect((await fetchUserApplication(request, env)).status).toBe(400);
    }
    expect(acknowledgements).toBe(0);
  });

  test("strictly decodes run-list pagination queries", async () => {
    const botState = {
      listRuns: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          runs: [],
          page: { truncated: false },
        }),
    } as unknown as BotStateBinding;
    const env: UserApplicationEnv = {
      BOT_STATE: rpcBindingFor(botState),
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const fetchUserApplication = createUserApplication();

    for (const suffix of ["?before=", "?before=a&before=b", "?cursor=a"]) {
      const response = await fetchUserApplication(
        new Request(`https://frockbot.test/api/bots/primary/turns${suffix}`),
        env,
      );
      expect(response.status).toBe(400);
    }
  });

  test("delegates an exact Stop command to the Bot owner", async () => {
    const calls: {
      botId: string;
      schemaVersion: 1;
      action: "stop";
      commandId: string;
      runId: string;
    }[] = [];
    const botState = {
      stopRun: (
        botId: string,
        command: {
          schemaVersion: 1;
          action: "stop";
          commandId: string;
          runId: string;
        },
      ) => {
        calls.push({ botId, ...command });
        return Promise.resolve({
          schemaVersion: 1 as const,
          status: "accepted" as const,
          commandId: command.commandId,
          runId: command.runId,
          run: {
            schemaVersion: 1 as const,
            runId: command.runId,
            admittedAt: "2026-08-30T00:00:00.000Z",
            input: "hello",
            status: "running" as const,
            events: [],
            stopRequestedAt: "2026-08-30T00:00:01.000Z",
          },
        });
      },
    } as unknown as BotStateBinding;
    const env: UserApplicationEnv = {
      BOT_STATE: rpcBindingFor(botState),
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const fetchUserApplication = createUserApplication();
    const stopRequest = (body: unknown, method = "POST") =>
      new Request("https://frockbot.test/api/bots/primary/turns/run-1/stop", {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      });

    const accepted = await fetchUserApplication(
      stopRequest({
        schemaVersion: 1,
        action: "stop",
        commandId: "stop-1",
        runId: "run-1",
      }),
      env,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      schemaVersion: 1,
      status: "accepted",
      commandId: "stop-1",
      runId: "run-1",
    });
    expect(calls).toEqual([
      {
        botId: "primary",
        schemaVersion: 1,
        action: "stop",
        commandId: "stop-1",
        runId: "run-1",
      },
    ]);

    const rejected = await fetchUserApplication(
      stopRequest(undefined, "GET"),
      env,
    );
    expect(rejected.status).toBe(405);
    for (const invalid of [
      {
        schemaVersion: 1,
        action: "resume",
        commandId: "stop-2",
        runId: "run-1",
      },
      {
        schemaVersion: 1,
        action: "stop",
        commandId: "stop-2",
        runId: "run-1",
        extra: true,
      },
      { schemaVersion: 1, action: "stop", commandId: "stop-2", runId: "run-2" },
    ]) {
      const response = await fetchUserApplication(stopRequest(invalid), env);
      expect(response.status).toBe(400);
    }
    expect(calls).toHaveLength(1);
  });

  test("delegates an authoritative admission fence", async () => {
    const calls: Array<{ botId: string; runId: string }> = [];
    const botState = {
      fenceRunAdmission: (
        botId: string,
        query: { schemaVersion: 1; runId: string },
      ) => {
        calls.push({ botId, runId: query.runId });
        return Promise.resolve({
          schemaVersion: 1 as const,
          state: "not-admitted" as const,
        });
      },
    } as unknown as BotStateBinding;
    const env: UserApplicationEnv = {
      BOT_STATE: rpcBindingFor(botState),
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };

    const response = await createUserApplication()(
      new Request(
        "https://frockbot.test/api/bots/primary/turns/command-1/fence",
        {
          method: "POST",
          body: JSON.stringify({
            schemaVersion: 1,
            action: "fence-admission",
          }),
        },
      ),
      env,
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      schemaVersion: 1,
      state: "not-admitted",
    });
    expect(calls).toEqual([{ botId: "primary", runId: "command-1" }]);
  });

  test("delegates a strict read-only command lookup", async () => {
    const calls: Array<{ botId: string; runId: string }> = [];
    const botState = {
      lookupRun: (
        botId: string,
        query: { schemaVersion: 1; runId: string },
      ) => {
        calls.push({ botId, runId: query.runId });
        return Promise.resolve({
          schemaVersion: 1 as const,
          state: "not-admitted" as const,
        });
      },
    } as unknown as BotStateBinding;
    const env: UserApplicationEnv = {
      BOT_STATE: rpcBindingFor(botState),
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const fetchUserApplication = createUserApplication();

    const response = await fetchUserApplication(
      new Request("https://frockbot.test/api/bots/primary/turns/command-1"),
      env,
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      schemaVersion: 1,
      state: "not-admitted",
    });
    expect(calls).toEqual([{ botId: "primary", runId: "command-1" }]);

    for (const suffix of ["?extra=true", "%2Fbad", "%"]) {
      const invalid = await fetchUserApplication(
        new Request(
          `https://frockbot.test/api/bots/primary/turns/command-1${suffix}`,
        ),
        env,
      );
      expect(invalid.status).toBe(400);
    }
    expect(calls).toHaveLength(1);
  });
});

describe("the cards route", () => {
  function namedError(name: string, message: string): Error {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  const card = {
    schemaVersion: 1 as const,
    surfaceId: "draft-email",
    revision: 2,
    components: [],
    dataModel: {},
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
  };

  function envFor(overrides: Partial<BotStateBinding>): UserApplicationEnv {
    const botState = {
      run: () => Promise.reject(new Error("unexpected")),
      listRuns: () => Promise.reject(new Error("unexpected")),
      lookupRun: () => Promise.reject(new Error("unexpected")),
      fenceRunAdmission: () => Promise.reject(new Error("unexpected")),
      listNotifications: () => Promise.resolve([]),
      listApprovals: (botId: string) =>
        Promise.resolve({
          schemaVersion: 1 as const,
          botId,
          approvals: [],
          pending: 0,
        }),
      decideApproval: () => Promise.reject(new Error("unexpected")),
      listCards: (botId: string) =>
        Promise.resolve({ schemaVersion: 1 as const, botId, cards: [card] }),
      cardAction: () => Promise.reject(new Error("unexpected")),
      acknowledgeNotification: () => Promise.resolve(),
      stopRun: () => Promise.reject(new Error("unexpected")),
      ...overrides,
    } as unknown as BotStateBinding;
    return {
      BOT_STATE: rpcBindingFor(botState),
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
  }

  test("a GET answers the Bot's surfaces as they stand", async () => {
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/cards"),
      envFor({}),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { cards: unknown[] }).toMatchObject({
      botId: "primary",
      cards: [{ surfaceId: "draft-email", revision: 2 }],
    });
  });

  test("a GET of one id answers the card the listing may have cut", async () => {
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/cards/draft-email"),
      envFor({
        readCard: (_botId: string, surfaceId: string) =>
          Promise.resolve({ ...card, surfaceId }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      surfaceId: "draft-email",
      revision: 2,
    });
  });

  test("a surface this Bot never drew is a 404", async () => {
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/cards/never-drawn"),
      envFor({
        readCard: () =>
          Promise.reject(
            namedError("CardNotFoundError", 'card "never-drawn" was not found'),
          ),
      }),
    );
    expect(response.status).toBe(404);
  });

  test("a surface id that could never have been stored never reaches the Durable Object", async () => {
    let reached = 0;
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/cards/run%3Afoo"),
      envFor({
        readCard: () => {
          reached += 1;
          return Promise.reject(new Error("unexpected"));
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(reached).toBe(0);
  });

  test("a malformed action never reaches the Durable Object", async () => {
    let reached = 0;
    const env = envFor({
      cardAction: () => {
        reached += 1;
        return Promise.reject(new Error("unexpected"));
      },
    });
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/cards", {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, surfaceId: "draft-email" }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(reached).toBe(0);
  });

  test("a surface that has moved under the person is 409, not a fault", async () => {
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/cards", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          surfaceId: "draft-email",
          revision: 1,
          event: { name: "send" },
        }),
      }),
      envFor({
        cardAction: () =>
          Promise.reject(
            namedError("CardStaleError", 'card "draft-email" has moved on'),
          ),
      }),
    );
    expect(response.status).toBe(409);
  });

  test("a surface this Bot never drew is 404", async () => {
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/cards", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          surfaceId: "draft-email",
          revision: 2,
          event: { name: "send" },
        }),
      }),
      envFor({
        cardAction: () =>
          Promise.reject(
            namedError("CardNotFoundError", 'card "draft-email" was not found'),
          ),
      }),
    );
    expect(response.status).toBe(404);
  });

  test("an action the kernel refuses is the client's fault, not a 500", async () => {
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/cards", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          surfaceId: "draft-email",
          revision: 2,
          event: { name: "approval/ap-1" },
        }),
      }),
      envFor({
        cardAction: () =>
          Promise.reject(
            namedError(
              "CardDecodeError",
              "an approval action must carry a decision of approved or denied",
            ),
          ),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "an approval action must carry a decision of approved or denied",
    });
  });

  test("an approval the kernel no longer holds is 404, as on the approvals route", async () => {
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/cards", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          surfaceId: "draft-email",
          revision: 2,
          event: { name: "approval/ap-1", context: { decision: "approved" } },
        }),
      }),
      envFor({
        cardAction: () =>
          Promise.reject(
            namedError(
              "ApprovalNotFoundError",
              'approval "ap-1" was not found',
            ),
          ),
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: 'approval "ap-1" was not found',
    });
  });

  test("no other method is served", async () => {
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/cards", {
        method: "DELETE",
      }),
      envFor({}),
    );
    expect(response.status).toBe(405);
  });
});

describe("run list failures", () => {
  test("a stored run the codec refuses is a JSON failure with its reason, not a crash", async () => {
    const botState: BotStateBinding = {
      run: () => Promise.reject(new Error("unexpected")),
      listRuns: () =>
        Promise.reject(
          new Error('run "run-1" has no valid Composition generation'),
        ),
      lookupRun: () => Promise.reject(new Error("unexpected")),
      fenceRunAdmission: () => Promise.reject(new Error("unexpected")),
      listNotifications: () => Promise.resolve([]),
      listApprovals: (botId) =>
        Promise.resolve({
          schemaVersion: 1 as const,
          botId,
          approvals: [],
          pending: 0,
        }),
      decideApproval: () => Promise.reject(new Error("unexpected")),
      listCards: (botId) =>
        Promise.resolve({ schemaVersion: 1 as const, botId, cards: [] }),
      readCard: () => Promise.reject(new Error("unexpected")),
      cardAction: () => Promise.reject(new Error("unexpected")),
      acknowledgeNotification: () => Promise.resolve(),
      stopRun: () => Promise.reject(new Error("unexpected")),
    };
    const env: UserApplicationEnv = {
      BOT_STATE: rpcBindingFor(botState),
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };

    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/turns"),
      env,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()) as { error: string }).toEqual({
      error: 'run "run-1" has no valid Composition generation',
    });
  });
});

const TODO_SUMMARY = {
  appletId: "alice.todo",
  displayName: "Todo",
  status: "published",
  currentGenerationId: "g1",
  tools: ["add_todo"],
  createdAt: "2026-09-03T00:00:00.000Z",
  ownerBotId: "bot-1",
  access: "owner",
  sharedWithBotIds: ["bot-2"],
};

describe("the Applet open route", () => {
  const applet = TODO_SUMMARY;

  test("answers the directory and the focused viewer with the URLs of this origin", async () => {
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        openFocusedApplet: ({ botId }) => {
          expect(botId).toBe("bot-1");
          return Promise.resolve({
            schemaVersion: 1 as const,
            applets: [applet],
            focused: {
              appletId: "alice.todo",
              generationId: "g1",
              uiHash: "a".repeat(64),
              token: "viewer-token",
              expiresAt: "2026-09-03T00:15:00.000Z",
            },
          });
        },
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/bot-1/applets/open"),
      env,
    );
    expect(response.status).toBe(200);
    expect<unknown>(await response.json()).toEqual({
      schemaVersion: 1,
      applets: [applet],
      focused: {
        appletId: "alice.todo",
        generationId: "g1",
        // The anonymous artifact origin, as the `/ui` route names it.
        uiUrl: `https://ui.frockbot.test/packages/${"a".repeat(64)}.html`,
        token: "viewer-token",
        // The address only; the token never rides in it.
        socketUrl: "wss://frockbot.test/api/applets/alice.todo/socket",
        expiresAt: "2026-09-03T00:15:00.000Z",
      },
    });
  });

  test("an unpublished focus is the building state, and no focus is the directory alone", async () => {
    const answers = [
      {
        schemaVersion: 1 as const,
        applets: [applet],
        focused: { appletId: "alice.todo" },
      },
      { schemaVersion: 1 as const, applets: [applet] },
    ];
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        openFocusedApplet: () => Promise.resolve(answers.shift()!),
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const fetchUserApplication = createUserApplication();
    const building = await fetchUserApplication(
      new Request("https://frockbot.test/api/bots/bot-1/applets/open"),
      env,
    );
    expect<unknown>(await building.json()).toEqual({
      schemaVersion: 1,
      applets: [applet],
      focused: { appletId: "alice.todo" },
    });
    const closed = await fetchUserApplication(
      new Request("https://frockbot.test/api/bots/bot-1/applets/open"),
      env,
    );
    expect<unknown>(await closed.json()).toEqual({
      schemaVersion: 1,
      applets: [applet],
    });
  });

  test("a deployment that cannot sign tokens says so, once and finally", async () => {
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        openFocusedApplet: () =>
          Promise.reject(new Error(APPLETS_UNAVAILABLE_MESSAGE_V1)),
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/bot-1/applets/open"),
      env,
    );
    expect(response.status).toBe(503);
    expect<unknown>(await response.json()).toEqual({
      error: "Applets are unavailable right now.",
      definitive: true,
    });
  });
});

describe("the Applet viewer token route", () => {
  test("a deployment that cannot sign tokens says so, once and finally", async () => {
    // Production ran for weeks with no `APPLET_VIEWER_SECRET`: the route threw
    // "Applet viewer sessions are not configured", the body carried that
    // sentence to the browser, and the panel — which never shows a 5xx body —
    // drew "Couldn't reach FrockBot." and retried forever (2026-09-05).
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        mintAppletViewerToken: () =>
          Promise.reject(new Error(APPLETS_UNAVAILABLE_MESSAGE_V1)),
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const response = await createUserApplication()(
      new Request(
        "https://frockbot.test/api/bots/bot-1/applets/alice.todo/token",
      ),
      env,
    );
    expect(response.status).toBe(503);
    // The sentence is the User's; `definitive` is the panel's instruction to
    // stop retrying. Neither carries the secret's name — that is in the log.
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: "Applets are unavailable right now.",
      definitive: true,
    });
  });

  test("the socket address carries no token of its own", async () => {
    // It used to. The page then offered the same token as a subprotocol — the
    // browser carrier — and the gateway, which refuses a token presented
    // twice, answered every Applet's socket 401 (2026-09-08).
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        mintAppletViewerToken: (input) => {
          // The token is minted for the Bot the route names.
          expect(input).toEqual({
            schemaVersion: 1,
            botId: "bot-1",
            appletId: "alice.todo",
          });
          return Promise.resolve({
            token: "viewer-token",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            appletId: "alice.todo",
            generationId: "g1",
          });
        },
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const response = await createUserApplication()(
      new Request(
        "https://frockbot.test/api/bots/bot-1/applets/alice.todo/token",
      ),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      socketUrl: string;
    };
    expect(body.token).toBe("viewer-token");
    expect(body.socketUrl).toBe(
      "wss://frockbot.test/api/applets/alice.todo/socket",
    );
  });

  test("an Applet the Bot cannot reach is a settled 404", async () => {
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        mintAppletViewerToken: () =>
          Promise.reject(new AppletUnavailableError("alice.todo")),
        readAppletUi: () =>
          Promise.reject(new AppletUnavailableError("alice.todo")),
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const app = createUserApplication();
    for (const read of ["token", "ui"]) {
      const response = await app(
        new Request(
          `https://frockbot.test/api/bots/bot-2/applets/alice.todo/${read}`,
        ),
        env,
      );
      expect(response.status).toBe(404);
    }
    // The account-wide routes are gone: nothing answers for "the User".
    expect(
      (
        await app(
          new Request("https://frockbot.test/api/applets/alice.todo/token"),
          env,
        )
      ).status,
    ).toBe(404);
  });
});

describe("a Bot's Applets", () => {
  test("the list and the impact are the Bot's the route names", async () => {
    const asked: unknown[] = [];
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        listApplets: (input) => {
          asked.push(input);
          return Promise.resolve({
            schemaVersion: 1,
            revision: 4,
            applets: [TODO_SUMMARY],
          });
        },
        readBotAppletImpact: (input) => {
          asked.push(input);
          return Promise.resolve({
            schemaVersion: 1,
            botId: "bot-1",
            fingerprint: "0123456789abcdef",
            applets: [
              {
                appletId: "alice.todo",
                displayName: "Todo",
                status: "published",
                sharedWithBotIds: ["bot-2"],
              },
            ],
          });
        },
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const app = createUserApplication();
    const listed = await app(
      new Request("https://frockbot.test/api/bots/bot-1/applets"),
      env,
    );
    expect(listed.status).toBe(200);
    // The durable revision is not part of the client's view.
    expect<unknown>(await listed.json()).toEqual({
      schemaVersion: 1,
      applets: [TODO_SUMMARY],
    });
    const impact = await app(
      new Request("https://frockbot.test/api/bots/bot-1/applets/impact"),
      env,
    );
    expect(impact.status).toBe(200);
    expect<unknown>(await impact.json()).toMatchObject({
      botId: "bot-1",
      fingerprint: "0123456789abcdef",
      applets: [{ appletId: "alice.todo", sharedWithBotIds: ["bot-2"] }],
    });
    expect(asked).toEqual([
      { schemaVersion: 1, botId: "bot-1" },
      { schemaVersion: 1, botId: "bot-1" },
    ]);
  });

  test("a shared Bot asking for the owner's code or deletion is told so, not a 500", async () => {
    const refusal = Object.assign(
      new Error(
        'Applet "alice.todo" is shared with this Bot; only the Bot that owns it can change it',
      ),
      { name: "AppletNotOwnerError" },
    );
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        readAppletSourceV1: () => Promise.reject(refusal),
        readAppletBuildV1: () => Promise.reject(refusal),
        deleteApplet: () => Promise.reject(refusal),
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const app = createUserApplication();
    for (const request of [
      new Request(
        "https://frockbot.test/api/bots/bot-2/applets/alice.todo/source",
      ),
      new Request(
        "https://frockbot.test/api/bots/bot-2/applets/alice.todo/build",
      ),
      new Request(
        "https://frockbot.test/api/bots/bot-2/applets/alice.todo/delete",
        {
          method: "POST",
        },
      ),
    ]) {
      const response = await app(request, env);
      expect(response.status).toBe(403);
      expect<unknown>(await response.json()).toMatchObject({
        code: "applet-not-owner",
        definitive: true,
      });
    }
  });

  test("focusing an Applet the Bot cannot open is a 404", async () => {
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        setFocusedApplet: () =>
          Promise.reject(new AppletUnavailableError("alice.todo")),
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/bot-2/applets/focus", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appletId: "alice.todo" }),
      }),
      env,
    );
    expect(response.status).toBe(404);
  });
});

describe("Applet deletion", () => {
  test("POST uses the scoped authority; GET and malformed ids cannot delete", async () => {
    const calls: unknown[] = [];
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        deleteApplet: async (input) => {
          calls.push(input);
          return { status: "deleted" };
        },
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const app = createUserApplication();
    expect(
      (
        await app(
          new Request(
            "https://frockbot.test/api/bots/bot-1/applets/alice.todo/delete",
          ),
          env,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await app(
          new Request(
            "https://frockbot.test/api/bots/bot-1/applets/invalid/delete",
            {
              method: "POST",
            },
          ),
          env,
        )
      ).status,
    ).toBe(400);
    expect(calls).toEqual([]);
    const response = await app(
      new Request(
        "https://frockbot.test/api/bots/bot-1/applets/alice.todo/delete",
        {
          method: "POST",
        },
      ),
      env,
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { schemaVersion: 1, botId: "bot-1", appletId: "alice.todo" },
    ]);
    expect((await response.json()) as unknown).toEqual({
      schemaVersion: 1,
      status: "deleted",
    });
  });

  test("an Applet the directory no longer holds answers 404, not a retryable 503", async () => {
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        deleteApplet: async () => {
          throw new AppletUnavailableError("alice.todo");
        },
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const app = createUserApplication();
    const response = await app(
      new Request(
        "https://frockbot.test/api/bots/bot-1/applets/alice.todo/delete",
        {
          method: "POST",
        },
      ),
      env,
    );
    expect(response.status).toBe(404);
  });

  test("a failure that merely reads as unavailable stays a retryable 503", async () => {
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        deleteApplet: async () => {
          throw new Error("the Applet Durable Object is unavailable");
        },
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const app = createUserApplication();
    const response = await app(
      new Request(
        "https://frockbot.test/api/bots/bot-1/applets/alice.todo/delete",
        {
          method: "POST",
        },
      ),
      env,
    );
    expect(response.status).toBe(503);
  });

  test("a delete that might still work stays a 503", async () => {
    const env: UserApplicationEnv = {
      BOT_STATE: {
        ...rpcBindingFor({} as BotStateBinding),
        deleteApplet: async () => {
          throw new Error("Network connection lost");
        },
      },
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };
    const app = createUserApplication();
    const response = await app(
      new Request(
        "https://frockbot.test/api/bots/bot-1/applets/alice.todo/delete",
        {
          method: "POST",
        },
      ),
      env,
    );
    expect(response.status).toBe(503);
  });
});

test("the public turn route forwards a retry target under its fresh command id", async () => {
  const calls: unknown[] = [];
  const binding = rpcBindingFor({} as BotStateBinding);
  binding.run = async (request) => {
    calls.push(request);
    return {
      schemaVersion: 1,
      runId: request.command.runId,
      text: "",
      events: [],
    };
  };
  const response = await createUserApplication()(
    new Request("https://app.example/api/bots/primary/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "attempt-2",
        retryOf: "attempt-1",
        text: "Check the build",
      }),
    }),
    {
      BOT_STATE: binding,
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    },
  );
  expect(response.status).toBe(200);
  expect(calls).toEqual([
    expect.objectContaining({
      botId: "primary",
      command: expect.objectContaining({
        runId: "attempt-2",
        retryOf: "attempt-1",
        text: "Check the build",
        sessionId: "alice:primary",
      }),
    }),
  ]);
});
