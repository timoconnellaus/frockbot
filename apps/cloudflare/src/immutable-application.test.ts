import { describe, expect, test } from "bun:test";
import { createImmutablePlanRequestFactory } from "./immutable-application.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("immutable application plan loading", () => {
  test("shares compilation while isolating every request construction", async () => {
    const compilation = deferred<Readonly<{ hash: string }>>();
    let compileCalls = 0;
    let constructionCalls = 0;
    const createForRequest = createImmutablePlanRequestFactory(
      () => {
        compileCalls += 1;
        return compilation.promise;
      },
      (plan, request: { secret: string; stub: object }) => {
        constructionCalls += 1;
        return { plan, secret: request.secret, stub: request.stub };
      },
    );
    const firstStub = {};
    const secondStub = {};
    const first = createForRequest({ secret: "first", stub: firstStub });
    const second = createForRequest({ secret: "second", stub: secondStub });

    await Promise.resolve();
    expect(compileCalls).toBe(1);
    expect(constructionCalls).toBe(0);
    const plan = Object.freeze({ hash: "application-hash" });
    compilation.resolve(plan);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { plan, secret: "first", stub: firstStub },
      { plan, secret: "second", stub: secondStub },
    ]);
    expect(constructionCalls).toBe(2);

    const thirdStub = {};
    await expect(
      createForRequest({ secret: "third", stub: thirdStub }),
    ).resolves.toEqual({ plan, secret: "third", stub: thirdStub });
    expect(compileCalls).toBe(1);
    expect(constructionCalls).toBe(3);
  });

  test("clears a rejected compilation for deterministic retry", async () => {
    const firstCompilation = deferred<Readonly<{ hash: string }>>();
    const recoveredPlan = Object.freeze({ hash: "recovered-hash" });
    let compileCalls = 0;
    let constructionCalls = 0;
    const createForRequest = createImmutablePlanRequestFactory(
      () => {
        compileCalls += 1;
        return compileCalls === 1
          ? firstCompilation.promise
          : Promise.resolve(recoveredPlan);
      },
      (plan, request: string) => {
        constructionCalls += 1;
        return { plan, request };
      },
    );
    const first = createForRequest("first");
    const concurrent = createForRequest("concurrent");
    await Promise.resolve();
    firstCompilation.reject(new Error("compile failed"));

    await expect(Promise.all([first, concurrent])).rejects.toThrow(
      "compile failed",
    );
    expect(compileCalls).toBe(1);
    expect(constructionCalls).toBe(0);

    await expect(createForRequest("retry")).resolves.toEqual({
      plan: recoveredPlan,
      request: "retry",
    });
    expect(compileCalls).toBe(2);
    expect(constructionCalls).toBe(1);
  });
});
