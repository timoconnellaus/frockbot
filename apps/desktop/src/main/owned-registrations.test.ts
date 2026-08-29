import { describe, expect, test } from "bun:test";
import {
  mountOwnedRegistrations,
  setupDisposableAuthMain,
} from "./owned-registrations.js";

describe("owned desktop registrations", () => {
  test("prepares Better Auth before readiness without unmanaged registrations", () => {
    const calls: unknown[] = [];
    const window = {};
    setupDisposableAuthMain(
      { setupMain: (config) => calls.push(config) },
      false,
      () => window,
    );
    expect(calls).toEqual([
      {
        csp: false,
        bridges: false,
        scheme: false,
        getWindow: expect.any(Function),
      },
    ]);
    expect((calls[0] as { getWindow(): unknown }).getWindow()).toBe(window);
    expect(() =>
      setupDisposableAuthMain({ setupMain: () => {} }, true, () => null),
    ).toThrow("desktop authentication must mount before app ready");
  });

  test("keeps one-time auth preparation separate from remountable ownership", () => {
    let preparations = 0;
    let activeHandlers = 0;
    setupDisposableAuthMain(
      { setupMain: () => preparations++ },
      false,
      () => null,
    );
    const mount = () =>
      mountOwnedRegistrations([
        () => {
          activeHandlers += 1;
          return () => activeHandlers--;
        },
      ]);

    const firstDispose = mount();
    expect({ preparations, activeHandlers }).toEqual({
      preparations: 1,
      activeHandlers: 1,
    });
    firstDispose();
    const secondDispose = mount();
    expect({ preparations, activeHandlers }).toEqual({
      preparations: 1,
      activeHandlers: 1,
    });
    secondDispose();
    expect(activeHandlers).toBe(0);
  });

  test("tears down every registration and supports a clean remount", () => {
    const listeners = new Set<(value: string) => void>();
    const handlers = new Map<string, (value: string) => string>();
    const observed: string[] = [];
    const mount = () =>
      mountOwnedRegistrations([
        () => {
          const listener = (value: string) => observed.push(value);
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => {
          handlers.set("authenticate", (value) => `accepted:${value}`);
          return () => handlers.delete("authenticate");
        },
      ]);

    const firstDispose = mount();
    for (const listener of listeners) listener("first");
    expect(handlers.get("authenticate")?.("one")).toBe("accepted:one");
    firstDispose();
    firstDispose();
    expect(listeners.size).toBe(0);
    expect(handlers.size).toBe(0);

    const secondDispose = mount();
    for (const listener of listeners) listener("second");
    expect(handlers.get("authenticate")?.("two")).toBe("accepted:two");
    secondDispose();

    expect(observed).toEqual(["first", "second"]);
    expect(listeners.size).toBe(0);
    expect(handlers.size).toBe(0);
  });

  test("rolls back earlier registrations when mounting fails", () => {
    let active = 0;
    expect(() =>
      mountOwnedRegistrations([
        () => {
          active += 1;
          return () => {
            active -= 1;
          };
        },
        () => {
          throw new Error("registration failed");
        },
      ]),
    ).toThrow("registration failed");
    expect(active).toBe(0);
  });
});
