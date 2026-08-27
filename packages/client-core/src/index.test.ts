import { describe, expect, test } from "bun:test";
import { defineComponent } from "vue";
import { ClientApplication, type ClientPlugin } from "./index.js";

const transport = {
  turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
};
const First = defineComponent(() => () => null);
const Second = defineComponent(() => () => null);

describe("ClientApplication", () => {
  test("orders plugin-owned slots and removes them on disposal", async () => {
    const application = new ClientApplication(transport);
    const plugin: ClientPlugin = (ctx) => [
      ctx.slot({ slot: "panel", order: 20, component: Second }),
      ctx.slot({ slot: "panel", order: 10, component: First }),
    ];

    await application.install(plugin);
    expect(application.slots("panel").map((slot) => slot.component)).toEqual([
      First,
      Second,
    ]);

    application.dispose();
    expect(application.slots("panel")).toEqual([]);
  });

  test("rejects multiple root contributions during installation", async () => {
    const application = new ClientApplication(transport);
    await application.install((ctx) =>
      ctx.slot({ slot: "root", order: 10, component: First }),
    );
    let failure: unknown;

    try {
      await application.install((ctx) =>
        ctx.slot({ slot: "root", order: 20, component: Second }),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure instanceof Error ? failure.message : "").toContain(
      "root is already registered",
    );
    application.dispose();
  });
});
