import { describe, expectTypeOf, it } from "bun:test";
import {
  createAction,
  createClient,
  createContextKey,
  createEvent,
  createPlugin,
} from "../src/index";
import {
  mailSentEvent,
  mailerKey,
  mailerPlugin,
} from "./helpers/other-package";
import { intervalValidator } from "./helpers/validator";
import type { Mailer } from "./helpers/other-package";

const clockKey = createContextKey<{ now: () => number }>("clock");
const secretKey = createContextKey<string>("secret");

describe("H. Types", () => {
  it("reading context is typed from the declared deps", () => {
    createPlugin({
      name: "typed-reader",
      deps: [clockKey, mailerKey],
      setup(instance) {
        expectTypeOf(instance.context.get(clockKey)).toEqualTypeOf<{
          now: () => number;
        }>();
        expectTypeOf(instance.context.get(mailerKey)).toEqualTypeOf<Mailer>();

        // @ts-expect-error — `secret` was not declared as a dep.
        instance.context.get(secretKey);

        // Reading an undeclared key is still possible through `peek`, which
        // admits that the value may be absent.
        expectTypeOf(instance.context.peek(secretKey)).toEqualTypeOf<
          string | undefined
        >();
      },
    });
  });

  it("payloads, action input and result, and options are inferred from the builders", () => {
    const started = createEvent<{ at: number }>("started");
    const awaited = createEvent<{ at: number }>("awaited", { awaited: true });
    const compute = createAction<{ left: number; right: number }, string>(
      "compute",
    );

    createPlugin({
      name: "inferred",
      provides: [compute],
      validator: intervalValidator,
      setup(instance, options) {
        expectTypeOf(options).toEqualTypeOf<{ every: number }>();

        instance.on(started, (payload) => {
          expectTypeOf(payload).toEqualTypeOf<{ at: number }>();
        });
        expectTypeOf(instance.emit(started, { at: 1 })).toEqualTypeOf<void>();
        expectTypeOf(instance.emit(awaited, { at: 1 })).toEqualTypeOf<
          Promise<void>
        >();

        instance.defineAction(compute, (input) => {
          expectTypeOf(input).toEqualTypeOf<{ left: number; right: number }>();
          return `${input.left + input.right}`;
        });
        instance.use(compute, ({ input, next }) => {
          expectTypeOf(input).toEqualTypeOf<{ left: number; right: number }>();
          expectTypeOf(next).toEqualTypeOf<
            (input: { left: number; right: number }) => Promise<string>
          >();
          return next(input);
        });
        expectTypeOf(
          instance.dispatch(compute, { left: 1, right: 2 }),
        ).toEqualTypeOf<Promise<string>>();
      },
    });

    const client = createClient();
    expectTypeOf(client.emit(started, { at: 1 })).toEqualTypeOf<void>();
    expectTypeOf(client.emit(awaited, { at: 1 })).toEqualTypeOf<
      Promise<void>
    >();
  });

  it("types action callables from declared deps", () => {
    const compute = createAction<number, string>("compute");

    createPlugin({
      name: "consumer",
      deps: [compute],
      setup(instance) {
        expectTypeOf(instance.get(compute)).toEqualTypeOf<
          (input: number) => Promise<string>
        >();
        expectTypeOf(instance.get(compute)(1)).toEqualTypeOf<Promise<string>>();
      },
    });

    createPlugin({
      name: "non-consumer",
      setup(instance) {
        // @ts-expect-error — `compute` was not declared as a dep.
        instance.get(compute);
      },
    });
  });

  it("requires every plugin entry to select exactly one entry kind", () => {
    // @ts-expect-error — an entry must carry a plugin or source.
    createClient({ plugins: [{ id: "empty" }] });

    createClient({
      plugins: [
        // @ts-expect-error — a plugin-object entry cannot also carry source.
        { id: "both", plugin: mailerPlugin, source: "export default () => {}" },
      ],
    });
  });

  it("a plugin authored in another package keeps full types with value imports only", () => {
    const client = createClient({
      plugins: [
        {
          id: "mailer",
          plugin: mailerPlugin,
          options: { from: "ada@example.test" },
        },
      ],
    });

    // @ts-expect-error — the options are typed by the plugin's validator.
    void client.addPlugin({
      id: "wrong",
      plugin: mailerPlugin,
      options: { from: 1 },
    });

    expectTypeOf(client.getContext(mailerKey)).toEqualTypeOf<
      Mailer | undefined
    >();

    createPlugin({
      name: "consumer",
      deps: [mailerKey],
      setup(instance) {
        expectTypeOf(instance.context.get(mailerKey).send).toEqualTypeOf<
          (to: string) => Promise<"sent">
        >();
        instance.on(mailSentEvent, (payload) => {
          expectTypeOf(payload).toEqualTypeOf<{ to: string }>();
        });
      },
    });
  });
});
