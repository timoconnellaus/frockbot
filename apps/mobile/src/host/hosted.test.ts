import { describe, expect, test } from "bun:test";
import type { MobileHost, MobileHostPackage } from "./index.ts";
import { mountHostedMobileCapabilities } from "./hosted.ts";

const packages: readonly MobileHostPackage[] = [
  { specifier: "declared-first", manifest: {} },
  { specifier: "declared-second", manifest: {} },
];

function fakeHost(input?: {
  invoke?(
    commandId: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  disposed?(): void;
}): MobileHost {
  return {
    list: () => [{ id: "mobile.declared.action" }],
    invoke: (commandId, value, signal) =>
      (input?.invoke?.(commandId, value, signal) ??
        Promise.resolve({ handled: true })) as Promise<never>,
    dispose: () => {
      input?.disposed?.();
      return Promise.resolve();
    },
  };
}

function options(
  overrides: Partial<Parameters<typeof mountHostedMobileCapabilities>[0]> = {},
): Parameters<typeof mountHostedMobileCapabilities>[0] {
  return {
    native: true,
    configuredServerUrl: "https://app.example.com",
    currentUrl: "https://app.example.com/?bot=primary",
    applicationHash: "foundation-v1",
    bodyApplicationHash: "foundation-v1",
    packages,
    createHost: () => Promise.resolve(fakeHost()),
    reportFailure: () => {},
    ...overrides,
  };
}

describe("hosted mobile capability mounting", () => {
  test("gates mounting by native runtime, configured origin, and application declaration", async () => {
    let mounts = 0;
    const createHost = () => {
      mounts += 1;
      return Promise.resolve(fakeHost());
    };

    expect(
      await mountHostedMobileCapabilities(
        options({ native: false, createHost }),
      ),
    ).toBeUndefined();
    expect(
      await mountHostedMobileCapabilities(
        options({ currentUrl: "https://attacker.test/", createHost }),
      ),
    ).toBeUndefined();
    expect(
      await mountHostedMobileCapabilities(
        options({ bodyApplicationHash: "other-v1", createHost }),
      ),
    ).toBeUndefined();
    expect(mounts).toBe(0);
  });

  test("mounts the immutable declaration unchanged and exposes no backend transport", async () => {
    let received: readonly MobileHostPackage[] | undefined;
    const capabilities = await mountHostedMobileCapabilities(
      options({
        createHost: (input) => {
          received = input.packages;
          return Promise.resolve(fakeHost());
        },
      }),
    );

    expect(received).toBe(packages);
    expect(capabilities?.applicationHash).toBe("foundation-v1");
    expect(capabilities?.list()).toEqual([{ id: "mobile.declared.action" }]);
    expect(Object.keys(capabilities ?? {}).sort()).toEqual([
      "applicationHash",
      "invoke",
      "list",
      "schemaVersion",
    ]);
    expect("fetch" in (capabilities ?? {})).toBe(false);
    expect("token" in (capabilities ?? {})).toBe(false);
  });

  test("strictly decodes bounded requests before declared dispatch", async () => {
    const invocations: unknown[] = [];
    const capabilities = await mountHostedMobileCapabilities(
      options({
        createHost: () =>
          Promise.resolve(
            fakeHost({
              invoke(commandId, value) {
                invocations.push({ commandId, value });
                return Promise.resolve({ handled: true });
              },
            }),
          ),
      }),
    );
    const hidden = {
      schemaVersion: 1,
      action: "invoke",
      commandId: "mobile.declared.action",
      input: {},
    };
    Object.defineProperty(hidden, "secret", { value: true });
    const symbol = {
      schemaVersion: 1,
      action: "invoke",
      commandId: "mobile.declared.action",
      input: {},
      [Symbol("secret")]: true,
    };

    expect(await capabilities?.invoke(hidden)).toMatchObject({
      status: "error",
      error: expect.stringContaining("unknown fields"),
    });
    expect(await capabilities?.invoke(symbol)).toMatchObject({
      status: "error",
      error: expect.stringContaining("unknown fields"),
    });
    expect(
      await capabilities?.invoke({
        schemaVersion: 1,
        action: "invoke",
        commandId: "mobile.declared.action",
        input: { payload: "x".repeat(1_200_000) },
      }),
    ).toMatchObject({ status: "error" });
    expect(invocations).toEqual([]);

    expect(
      await capabilities?.invoke({
        schemaVersion: 1,
        action: "invoke",
        commandId: "mobile.declared.action",
        input: { value: 1 },
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "ok",
      result: { handled: true },
    });
    expect(invocations).toEqual([
      { commandId: "mobile.declared.action", value: { value: 1 } },
    ]);
  });

  test("reports missing capabilities, cancellation, and startup failure without blocking", async () => {
    const unavailable = await mountHostedMobileCapabilities(
      options({
        createHost: () =>
          Promise.resolve(
            fakeHost({
              invoke: () =>
                Promise.reject(
                  new Error('mobile command "mobile.missing" is unavailable'),
                ),
            }),
          ),
      }),
    );
    expect(
      await unavailable?.invoke({
        schemaVersion: 1,
        action: "invoke",
        commandId: "mobile.missing",
        input: {},
      }),
    ).toMatchObject({ status: "unavailable" });

    const controller = new AbortController();
    const cancelled = await mountHostedMobileCapabilities(
      options({
        createHost: () =>
          Promise.resolve(
            fakeHost({
              invoke: async (_id, _value, signal) => {
                controller.abort(new Error("gesture cancelled"));
                signal?.throwIfAborted();
              },
            }),
          ),
      }),
    );
    expect(
      await cancelled?.invoke(
        {
          schemaVersion: 1,
          action: "invoke",
          commandId: "mobile.declared.action",
          input: {},
        },
        controller.signal,
      ),
    ).toMatchObject({ status: "cancelled" });

    expect(
      await mountHostedMobileCapabilities(
        options({
          createHost: () => Promise.reject(new Error("adapter denied")),
        }),
      ),
    ).toBeUndefined();
    expect(
      await mountHostedMobileCapabilities(
        options({
          createHost: () => Promise.reject(new Error("adapter denied")),
          reportFailure: () => {
            throw new Error("diagnostics unavailable");
          },
        }),
      ),
    ).toBeUndefined();
  });

  test("bounds never-resolving adapters by deadline and caller cancellation", async () => {
    const never = () => new Promise<never>(() => {});
    const timed = await mountHostedMobileCapabilities(
      options({
        invokeTimeoutMs: 5,
        createHost: () => Promise.resolve(fakeHost({ invoke: never })),
      }),
    );
    expect(
      await timed?.invoke({
        schemaVersion: 1,
        action: "invoke",
        commandId: "mobile.declared.action",
        input: {},
      }),
    ).toMatchObject({
      status: "error",
      error: expect.stringContaining("timed out"),
    });

    const cancelled = await mountHostedMobileCapabilities(
      options({
        invokeTimeoutMs: 60_000,
        createHost: () => Promise.resolve(fakeHost({ invoke: never })),
      }),
    );
    const controller = new AbortController();
    const pending = cancelled?.invoke(
      {
        schemaVersion: 1,
        action: "invoke",
        commandId: "mobile.declared.action",
        input: {},
      },
      controller.signal,
    );
    controller.abort(new Error("caller detached"));
    expect(await pending).toMatchObject({
      status: "cancelled",
      error: expect.stringContaining("caller detached"),
    });
  });

  test("page lifecycle cancels invocations and disposes optional observers", async () => {
    let pageHide: (() => void) | undefined;
    let disposals = 0;
    const capabilities = await mountHostedMobileCapabilities(
      options({
        createHost: () =>
          Promise.resolve(
            fakeHost({
              invoke: () => new Promise<never>(() => {}),
              disposed: () => (disposals += 1),
            }),
          ),
        onPageHide: (dispose) => {
          pageHide = dispose;
        },
      }),
    );
    const pending = capabilities?.invoke({
      schemaVersion: 1,
      action: "invoke",
      commandId: "mobile.declared.action",
      input: {},
    });
    expect(disposals).toBe(0);
    pageHide?.();
    expect(await pending).toMatchObject({
      status: "cancelled",
      error: expect.stringContaining("lifecycle detached"),
    });
    await Bun.sleep(0);
    expect(disposals).toBe(1);
  });

  test("page lifecycle observes rejecting optional disposal without blocking", async () => {
    let pageHide: (() => void) | undefined;
    const failures: string[] = [];
    await mountHostedMobileCapabilities(
      options({
        createHost: () =>
          Promise.resolve({
            ...fakeHost(),
            dispose: () => Promise.reject(new Error("native teardown failed")),
          }),
        reportFailure: (message) => {
          failures.push(message);
        },
        onPageHide: (dispose) => {
          pageHide = dispose;
        },
      }),
    );

    expect(() => pageHide?.()).not.toThrow();
    await Bun.sleep(0);
    expect(failures).toEqual(["native teardown failed"]);
  });

  test("page lifecycle contains synchronous disposal and rejecting diagnostics", async () => {
    let pageHide: (() => void) | undefined;
    let reports = 0;
    await mountHostedMobileCapabilities(
      options({
        createHost: () =>
          Promise.resolve({
            ...fakeHost(),
            dispose: (() => {
              throw new Error("synchronous teardown failed");
            }) as MobileHost["dispose"],
          }),
        reportFailure: () => {
          reports += 1;
          return Promise.reject(new Error("diagnostics rejected"));
        },
        onPageHide: (dispose) => {
          pageHide = dispose;
        },
      }),
    );

    expect(() => pageHide?.()).not.toThrow();
    await Bun.sleep(0);
    expect(reports).toBe(1);
  });
});
