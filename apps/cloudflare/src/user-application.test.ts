import { describe, expect, test } from "bun:test";
import type {
  BotStateBinding,
  BotTurnResult,
  UserApplicationEnv,
} from "./contracts.js";
import { createUserApplication } from "./user-application.js";

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
      listNotifications: () => Promise.resolve([]),
      acknowledgeNotification: () => Promise.resolve(),
      reconcileRun: () => Promise.resolve(result),
    };
    const env: UserApplicationEnv = {
      BOT_STATE: botState,
      DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
    };

    const response = await createUserApplication()(
      new Request("https://frockbot.test/api/bots/primary/turns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello", commandId: "command-1" }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as BotTurnResult).toEqual(result);
    expect(calls).toEqual([{ botId: "primary", text: "hello" }]);
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
      BOT_STATE: botState,
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
});
