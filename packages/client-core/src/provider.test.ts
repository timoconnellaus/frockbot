import { describe, expect, test } from "bun:test";
import type { InjectionKey } from "vue";
import { ClientApplication } from "./index.js";

const serviceKey: InjectionKey<{ value: string }> = Symbol("test-service");
const transport = {
  turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
};

describe("client plugin services", () => {
  test("lets later plugins consume lifecycle-owned providers", async () => {
    const application = new ClientApplication(transport);
    const service = { value: "available" };
    let consumed: typeof service | undefined;

    await application.install((ctx) => ctx.provide(serviceKey, service));
    await application.install((ctx) => {
      consumed = ctx.inject(serviceKey);
    });

    expect(consumed).toBe(service);
    application.dispose();
  });

  test("rejects missing and duplicate providers", async () => {
    const application = new ClientApplication(transport);
    let missingFailure: unknown;
    try {
      await application.install((ctx) => {
        ctx.inject(serviceKey);
      });
    } catch (error) {
      missingFailure = error;
    }
    expect(missingFailure).toEqual(
      new Error("required client provider is unavailable"),
    );

    await application.install((ctx) =>
      ctx.provide(serviceKey, { value: "first" }),
    );
    let duplicateFailure: unknown;
    try {
      await application.install((ctx) =>
        ctx.provide(serviceKey, { value: "second" }),
      );
    } catch (error) {
      duplicateFailure = error;
    }
    expect(duplicateFailure).toEqual(
      new Error("client provider is already registered"),
    );
  });
});
