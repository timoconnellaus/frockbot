import { describe, expect, test } from "bun:test";
import type { AuthPackageV1 } from "@frockbot/core/contracts";
import type { GatewayDependencies } from "./contracts.js";
import { createGateway } from "./gateway.js";

const unreached = (member: string) => (): never => {
  throw new Error(`the deletion route must not reach ${member}`);
};

function gatewayFor(options: {
  email?: string;
  deletion?: GatewayDependencies["deletion"];
}) {
  const auth: AuthPackageV1 = {
    handler: unreached("auth.handler"),
    signOut: unreached("auth.signOut"),
    startSignIn: unreached("auth.startSignIn"),
    getSession: () =>
      Promise.resolve({
        user: {
          id: "member",
          ...(options.email ? { email: options.email } : {}),
        },
      }),
  };
  return createGateway({
    loader: { get: unreached("loader") } as never,
    artifacts: { load: unreached("artifacts") },
    auth,
    admitAccount: () =>
      Promise.resolve({ schemaVersion: 1, admitted: true, basis: "active" }),
    applicationHashFor: unreached("applicationHashFor"),
    botStateFor: unreached("botStateFor"),
    userConfigurationFor: unreached("userConfigurationFor"),
    botConfigurationFor: unreached("botConfigurationFor"),
    ...(options.deletion ? { deletion: options.deletion } : {}),
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`https://frockbot.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const COMMAND_ID = "command-0123456789abcdef";

describe("deleting the account", () => {
  test("answers what to type: the email this session signed in with", async () => {
    const gateway = gatewayFor({
      email: "Member@Example.com",
      deletion: {
        deleteAccount: unreached("deleteAccount"),
        deleteComputer: unreached("deleteComputer"),
      },
    });
    const response = await gateway(
      new Request("https://frockbot.test/api/account/delete"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      confirmation: "Member@Example.com",
    });
  });

  test("deletes only against the phrase, for the identity this request is", async () => {
    const asked: Array<[string, unknown]> = [];
    const gateway = gatewayFor({
      email: "Member@Example.com",
      deletion: {
        deleteAccount: async (userId, command) => {
          asked.push([userId, command]);
          return { schemaVersion: 1, status: "deleting" };
        },
        deleteComputer: unreached("deleteComputer"),
      },
    });
    const wrong = await gateway(
      post("/api/account/delete", {
        schemaVersion: 1,
        commandId: COMMAND_ID,
        confirmation: "someone@example.com",
      }),
    );
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({
      code: "confirmation-mismatch",
    });
    expect(asked).toEqual([]);

    const confirmed = await gateway(
      post("/api/account/delete", {
        schemaVersion: 1,
        commandId: COMMAND_ID,
        confirmation: "  member@example.COM ",
      }),
    );
    expect(confirmed.status).toBe(202);
    expect(await confirmed.json()).toEqual({
      schemaVersion: 1,
      status: "deleting",
    });
    // The account deleted is the authenticated one, and the address kept
    // for its invitation is the normalized one sign-in gave.
    expect(asked).toEqual([
      ["member", { commandId: COMMAND_ID, email: "member@example.com" }],
    ]);
  });

  test("a deletion already under way is an answer, not an error", async () => {
    const gateway = gatewayFor({
      email: "member@example.com",
      deletion: {
        deleteAccount: async () => {
          const error = new Error("This account has been deleted.");
          error.name = "AccountDeletedError";
          throw error;
        },
        deleteComputer: unreached("deleteComputer"),
      },
    });
    const response = await gateway(
      post("/api/account/delete", {
        schemaVersion: 1,
        commandId: COMMAND_ID,
        confirmation: "member@example.com",
      }),
    );
    expect(response.status).toBe(202);
  });

  test("refuses a malformed command before anything is deleted", async () => {
    const gateway = gatewayFor({
      email: "member@example.com",
      deletion: {
        deleteAccount: unreached("deleteAccount"),
        deleteComputer: unreached("deleteComputer"),
      },
    });
    for (const body of [
      { schemaVersion: 1, commandId: "short", confirmation: "x" },
      { schemaVersion: 1, commandId: COMMAND_ID },
      {
        schemaVersion: 1,
        commandId: COMMAND_ID,
        confirmation: "member@example.com",
        userId: "someone-else",
      },
    ]) {
      expect((await gateway(post("/api/account/delete", body))).status).toBe(
        400,
      );
    }
    expect(
      (
        await gateway(
          new Request("https://frockbot.test/api/account/delete", {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(405);
  });

  test("a deployment that cannot delete says so", async () => {
    const response = await gatewayFor({ email: "member@example.com" })(
      new Request("https://frockbot.test/api/account/delete"),
    );
    expect(response.status).toBe(503);
  });
});

describe("deleting the Computer", () => {
  test("carries the command for the authenticated User and answers the receipt", async () => {
    const asked: Array<[string, string]> = [];
    const gateway = gatewayFor({
      deletion: {
        deleteAccount: unreached("deleteAccount"),
        deleteComputer: async (userId, commandId) => {
          asked.push([userId, commandId]);
          return { schemaVersion: 1, status: "deleted" };
        },
      },
    });
    const response = await gateway(
      post("/api/computer/delete", { schemaVersion: 1, commandId: COMMAND_ID }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      status: "deleted",
    });
    expect(asked).toEqual([["member", COMMAND_ID]]);
  });

  test("a host that failed is reported, so the press can be retried", async () => {
    const gateway = gatewayFor({
      deletion: {
        deleteAccount: unreached("deleteAccount"),
        deleteComputer: async () => {
          throw new Error("The Computer host is unavailable");
        },
      },
    });
    const response = await gateway(
      post("/api/computer/delete", { schemaVersion: 1, commandId: COMMAND_ID }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The Computer host is unavailable",
    });
  });
});
