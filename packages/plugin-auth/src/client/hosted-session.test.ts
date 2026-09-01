import { describe, expect, test } from "bun:test";
import { createHostedAuthAdapter } from "./hosted-session.js";

const user = { id: "alice", name: "Alice", email: "alice@example.com" };

function browser(
  overrides: Partial<Parameters<typeof createHostedAuthAdapter>[0]> = {},
) {
  return createHostedAuthAdapter({
    location: new URL("https://frockbot.test/"),
    embeddedUserId: "alice",
    embeddedMode: "better-auth",
    embeddedIsAdmin: true,
    betterAuth: {
      getSession: () => Promise.resolve({ data: { user }, error: null }),
      signOut: () => Promise.resolve({ data: { success: true }, error: null }),
    },
    ...overrides,
  });
}

describe("hosted auth adapter", () => {
  test("projects Better Auth and returns authoritative anonymous sign-out", async () => {
    let signOuts = 0;
    const adapter = browser({
      betterAuth: {
        getSession: () => Promise.resolve({ data: { user }, error: null }),
        signOut: () => {
          signOuts += 1;
          return Promise.resolve({ data: { success: true }, error: null });
        },
      },
    });

    expect(await adapter.read()).toEqual({
      schemaVersion: 1,
      status: "authenticated",
      mode: "better-auth",
      user: { ...user, isAdmin: true },
    });
    expect(await adapter.signOut()).toEqual({
      schemaVersion: 1,
      status: "anonymous",
    });
    expect(signOuts).toBe(1);
  });

  test("uses the trusted desktop bridge", async () => {
    let signOuts = 0;
    const adapter = browser({
      desktop: {
        getUser: () => Promise.resolve(user),
        signOut: () => {
          signOuts += 1;
          return Promise.resolve();
        },
      },
    });

    expect(await adapter.read()).toMatchObject({
      status: "authenticated",
      mode: "desktop",
      user: { ...user, isAdmin: true },
    });
    expect(await adapter.signOut()).toEqual({
      schemaVersion: 1,
      status: "anonymous",
    });
    expect(signOuts).toBe(1);
  });

  test("projects explicit and persisted development identity separately", async () => {
    const direct = browser({
      location: new URL("http://localhost:8787/?as_user=development"),
    });
    expect(await direct.read()).toMatchObject({
      status: "authenticated",
      mode: "development",
      user: { id: "development" },
    });
    await expect(direct.signOut()).rejects.toThrow(
      "Development identity cannot be signed out",
    );

    let desktopSignOuts = 0;
    const directInDesktop = browser({
      location: new URL("http://localhost:8787/?as_user=development"),
      desktop: {
        getUser: () => Promise.resolve(user),
        signOut: () => {
          desktopSignOuts += 1;
          return Promise.resolve();
        },
      },
    });
    await expect(directInDesktop.signOut()).rejects.toThrow(
      "Development identity cannot be signed out",
    );
    expect(desktopSignOuts).toBe(0);

    const persisted = browser({
      location: new URL("http://localhost:8787/"),
      embeddedUserId: "development",
      embeddedMode: "development",
      betterAuth: {
        getSession: () => Promise.resolve({ data: null, error: null }),
        signOut: () => Promise.resolve({ data: null, error: null }),
      },
    });
    expect(await persisted.read()).toMatchObject({
      status: "authenticated",
      mode: "development",
    });
  });

  test("keeps embedded development authority ahead of desktop and Better Auth", async () => {
    let desktopReads = 0;
    let desktopSignOuts = 0;
    let sessionReads = 0;
    let betterAuthSignOuts = 0;
    const adapter = browser({
      embeddedUserId: "development",
      embeddedMode: "development",
      desktop: {
        getUser: () => {
          desktopReads += 1;
          return Promise.resolve(user);
        },
        signOut: () => {
          desktopSignOuts += 1;
          return Promise.resolve();
        },
      },
      betterAuth: {
        getSession: () => {
          sessionReads += 1;
          return Promise.resolve({ data: { user }, error: null });
        },
        signOut: () => {
          betterAuthSignOuts += 1;
          return Promise.resolve({ data: { success: true }, error: null });
        },
      },
    });

    expect(await adapter.read()).toEqual({
      schemaVersion: 1,
      status: "authenticated",
      mode: "development",
      user: {
        id: "development",
        name: "Local developer",
        email: "dev@localhost",
        isAdmin: true,
      },
    });
    expect(desktopReads).toBe(0);
    expect(sessionReads).toBe(0);
    await expect(adapter.signOut()).rejects.toThrow(
      "Development identity cannot be signed out",
    );
    expect(desktopSignOuts).toBe(0);
    expect(betterAuthSignOuts).toBe(0);
  });

  test("surfaces Better Auth failure without fabricating success", async () => {
    const adapter = browser({
      betterAuth: {
        getSession: () => Promise.resolve({ data: { user }, error: null }),
        signOut: () =>
          Promise.resolve({
            data: null,
            error: { message: "server unavailable" },
          }),
      },
    });
    await expect(adapter.signOut()).rejects.toThrow("server unavailable");
  });

  test("projects only the gateway-owned admin boolean", async () => {
    expect(await browser({ embeddedIsAdmin: false }).read()).toMatchObject({
      user: { id: "alice", isAdmin: false },
    });
  });
});
