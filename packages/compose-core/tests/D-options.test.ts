import { describe, expect, it, mock } from "bun:test";
import { createClient, createPlugin, optionsUpdateAction } from "../src/index";
import { intervalValidator } from "./helpers/validator";

const starts: Array<number> = [];

const ticker = createPlugin({
  name: "ticker",
  validator: intervalValidator,
  setup(instance, options) {
    starts.push(options.every);
    instance.cleanup(() => {});
  },
});

const other = createPlugin({
  name: "other",
  setup(instance) {
    instance.cleanup(() => {});
  },
});

describe("D. Options", () => {
  it("options are validated and defaulted before the instance starts", async () => {
    starts.length = 0;
    const client = createClient({
      plugins: [
        { id: "defaulted", plugin: ticker },
        { id: "invalid", plugin: ticker, options: { every: "soon" as never } },
      ],
    });
    await client.settled();

    expect(starts).toEqual([10]);
    const invalid = client.inspect().find((entry) => entry.id === "invalid");
    expect(invalid?.status).toBe("error");
    expect(String(invalid?.error)).toMatch(/options\.every: expected a number/);
  });

  it("an options update restarts only that instance", async () => {
    starts.length = 0;
    const otherStart = mock();
    const watched = createPlugin({
      name: "watched",
      setup() {
        otherStart();
      },
    });
    const client = createClient({
      plugins: [
        { id: "ticker", plugin: ticker, options: { every: 1 } },
        { id: "watched", plugin: watched },
      ],
    });
    await client.settled();
    expect(starts).toEqual([1]);
    expect(otherStart).toHaveBeenCalledTimes(1);

    await client.setOptions("ticker", { every: 2 });

    expect(starts).toEqual([1, 2]);
    expect(otherStart).toHaveBeenCalledTimes(1);
    expect(
      client.inspect().find((entry) => entry.id === "ticker")?.status,
    ).toBe("active");

    // An identical options value is not a change, so nothing restarts.
    await client.setOptions("ticker", { every: 2 });
    expect(starts).toEqual([1, 2]);
  });

  it("an options update is an action tooling can observe, veto or replace", async () => {
    starts.length = 0;
    const client = createClient({
      plugins: [
        { id: "ticker", plugin: ticker, options: { every: 1 } },
        { id: "other", plugin: other },
      ],
    });
    await client.settled();

    const observed: Array<unknown> = [];
    const stopObserving = client.use(optionsUpdateAction, ({ input, next }) => {
      observed.push(input);
      return next(input);
    });
    await client.setOptions("ticker", { every: 3 });
    expect(observed).toEqual([{ id: "ticker", options: { every: 3 } }]);
    expect(starts).toEqual([1, 3]);
    stopObserving();

    const stopVetoing = client.use(optionsUpdateAction, () => undefined);
    await client.setOptions("ticker", { every: 99 });
    expect(starts).toEqual([1, 3]);
    stopVetoing();

    const stopReplacing = client.use(optionsUpdateAction, ({ input, next }) =>
      next({ ...input, options: { every: 7 } }),
    );
    await client.setOptions("ticker", { every: 99 });
    expect(starts).toEqual([1, 3, 7]);
    stopReplacing();
  });
});
