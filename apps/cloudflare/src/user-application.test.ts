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
    run: ({ botId, command }) => state.run(botId, command),
    listRuns: ({ botId, query }) => state.listRuns(botId, query),
    lookupRun: ({ botId, query }) => state.lookupRun(botId, query),
    fenceRunAdmission: ({ botId, query }) =>
      state.fenceRunAdmission(botId, query),
    listNotifications: ({ botId }) => state.listNotifications(botId),
    acknowledgeNotification: ({ botId, notificationId }) =>
      state.acknowledgeNotification(botId, notificationId),
    reconcileRun: ({ botId, runId }) => state.reconcileRun(botId, runId),
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
    expect(policy.get("style-src")).toEqual(["'self'"]);
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
      acknowledgeNotification: () => Promise.resolve(),
      reconcileRun: () => Promise.resolve(result),
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
