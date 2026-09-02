import { describe, expect, test } from "bun:test";
import type {
  BotStateBinding,
  BotTurnResult,
  UserApplicationEnv,
  UserBotStateBinding,
} from "./contracts.js";
import { createUserApplication } from "./user-application.js";

function rpcBindingFor(state: BotStateBinding): UserBotStateBinding {
  return {
    assertRegistered: () => Promise.resolve(),
    listSkills: () =>
      Promise.resolve({ schemaVersion: 1 as const, skills: [] }),
    listPackageUi: ({ botId }) =>
      Promise.resolve({
        schemaVersion: 1 as const,
        botId,
        generationId: "generation-1",
        contributions: [],
      }),
    runPackageUiTool: ({ command }) =>
      Promise.resolve({
        schemaVersion: 1 as const,
        runId: command.commandId,
        text: "",
        events: [],
      }),
    readWorkspaceFileV1: () =>
      Promise.resolve({
        schemaVersion: 1 as const,
        status: "not-found" as const,
        reason: "no workspace in this test",
      }),
    run: ({ botId, command }) => state.run(botId, command),
    listRuns: ({ botId, query }) => state.listRuns(botId, query),
    lookupRun: ({ botId, query }) => state.lookupRun(botId, query),
    fenceRunAdmission: ({ botId, query }) =>
      state.fenceRunAdmission(botId, query),
    listNotifications: ({ botId }) => state.listNotifications(botId),
    listApprovals: ({ botId }) => state.listApprovals(botId),
    decideApproval: ({ botId, approvalId, command }) =>
      state.decideApproval(botId, approvalId, command),
    acknowledgeNotification: ({ botId, notificationId }) =>
      state.acknowledgeNotification(botId, notificationId),
    reconcileRun: ({ botId, runId }) => state.reconcileRun(botId, runId),
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
    expect(html).toContain('data-frockbot-auth-mode="development"');
    expect(html).toContain('data-frockbot-is-admin="true"');

    for (const mode of [undefined, "desktop", "development,better-auth"]) {
      const headers = mode ? { "x-frockbot-auth-session-v1": mode } : undefined;
      await expect(
        fetchUserApplication(
          new Request("https://app.example/", { headers }),
          securityEnv,
        ),
      ).rejects.toThrow("hosted auth session projection is invalid");
    }
  });

  test("serves the stylesheet with a policy that allows the embedded fonts", async () => {
    const fetchUserApplication = createUserApplication();

    const response = await fetchUserApplication(
      new Request("https://app.example/app.css"),
      securityEnv,
    );

    expect(response.status).toBe(200);
    const policy = parseContentSecurityPolicy(
      response.headers.get("content-security-policy"),
    );
    // The shipped stylesheet embeds Manrope and Archivo Black as data: URIs,
    // so fonts render only when the policy declares font-src for them.
    expect(policy.get("font-src")).toEqual(["'self'", "data:"]);
    expect(policy.get("img-src")).toEqual(["'self'", "data:"]);
    expect(policy.get("style-src")).toEqual(["'self'"]);
    expect(policy.get("frame-src")).toEqual(["https://ui.app.example"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
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
      acknowledgeNotification: () => Promise.resolve(),
      reconcileRun: () => Promise.resolve(result),
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
        reconcileRun: unexpected,
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
      new Request(
        "https://frockbot.test/api/bots/missing/turns/run-1/reconcile",
        { method: "POST", body: "{}" },
      ),
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

  test("rejects archived Bot routes before dispatch", async () => {
    let dispatches = 0;
    const archived = new Error('Bot "primary" is archived');
    archived.name = "BotArchivedError";
    const env = {
      BOT_STATE: {
        assertRegistered: () => Promise.reject(archived),
        run: () => {
          dispatches += 1;
          return Promise.reject(new Error("must not dispatch"));
        },
      } as unknown as UserBotStateBinding,
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    } satisfies UserApplicationEnv;
    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/turns"),
      env,
    );
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toEqual({
      error: 'Bot "primary" is archived',
    });
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

  test("rejects inexact notification and reconciliation commands", async () => {
    let acknowledgements = 0;
    let reconciliations = 0;
    const botState = {
      acknowledgeNotification: () => {
        acknowledgements += 1;
        return Promise.resolve();
      },
      reconcileRun: () => {
        reconciliations += 1;
        return Promise.reject(new Error("must not reconcile"));
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
      new Request(
        "https://frockbot.test/api/bots/primary/turns/run-1/reconcile",
        {
          method: "POST",
          body: JSON.stringify({ schemaVersion: 2, action: "resume" }),
        },
      ),
    ];
    for (const request of invalidRequests) {
      expect((await fetchUserApplication(request, env)).status).toBe(400);
    }
    expect(acknowledgements).toBe(0);
    expect(reconciliations).toBe(0);
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
      acknowledgeNotification: () => Promise.resolve(),
      reconcileRun: () => Promise.reject(new Error("unexpected")),
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
