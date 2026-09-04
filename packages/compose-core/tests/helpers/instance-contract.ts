/**
 * One parameterised suite for the parts of the kernel's criteria that are
 * observable of any single instance, expressed against a factory that builds an
 * entry for the same probe behaviour. It is run once with an ordinary plugin
 * and once with plugin source on the in-process host, so a hosted plugin is
 * held to the kernel's rules by the same assertions rather than by a second
 * suite that could drift. A host package adds an arm and no new assertions.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
  createClient,
  createContextKey,
  createPlugin,
  createStub,
} from "../../src/index";
import { validator } from "./validator";
import type { Client, Host, Instance, PluginEntry } from "../../src/index";

/** What the probe reports about its own life, in order. */
let notes: Array<string> = [];

/** The handlers instances registered, by `<instance id>:<name>`. */
const handlers = new Map<string, (input: unknown) => Promise<unknown>>();

const note = (message: string) => {
  notes.push(message);
};

/** A cleanup that yields before it reports, so awaiting removal is meaningful. */
const holdCleanup = (message: string) => async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  note(message);
};

/** The key a `needs`-flavoured probe waits for. */
const gateKey = createContextKey<string>("contract.gate");

/** Provides the key a `needs`-flavoured probe waits for. */
const gatePlugin = createPlugin({
  name: "gate",
  provides: [gateKey],
  setup(instance) {
    instance.provide(gateKey, "open");
  },
});

/** What every probe is given, whichever arm builds it. */
export interface ProbeOptions {
  label: string;
  /** Wait on {@link gateKey} before starting. */
  needs?: boolean;
  /** Throw once everything is registered. */
  fail?: boolean;
}

const probeOptions = validator<ProbeOptions, ProbeOptions>((value) => ({
  value,
}));

// ------------------------------------------------------------- the plugin arm

const probeSetup = (instance: Instance, options: ProbeOptions) => {
  note(`start:${options.label}`);
  instance.cleanup(
    holdCleanup(`stop1:${options.label}`),
    `probe(${options.label})`,
  );
  instance.cleanup(
    holdCleanup(`stop2:${options.label}`),
    `late(${options.label})`,
  );
  const key = `${instance.id}:echo`;
  handlers.set(key, (input) => Promise.resolve(`echo:${String(input)}`));
  instance.cleanup(() => {
    handlers.delete(key);
  }, "echo");
  if (options.fail) throw new Error("probe failed");
};

const probePlugin = createPlugin({
  name: "probe",
  validator: probeOptions,
  setup: probeSetup,
});

const gatedProbePlugin = createPlugin({
  name: "probe",
  deps: [gateKey],
  validator: probeOptions,
  setup: probeSetup,
});

/** Builds the probe as an ordinary plugin: the control arm. */
export const pluginArm = {
  name: "an ordinary plugin",
  entry: (id: string, options: ProbeOptions): PluginEntry => ({
    id,
    plugin: options.needs ? gatedProbePlugin : probePlugin,
    options,
  }),
};

// ------------------------------------------------------------- the source arm

/** The same probe, written as plugin source. */
const probeSource = `
export default async function setup({ options, stubs }) {
  await stubs.note('start:' + options.label)
  await stubs.hold({ label: 'probe(' + options.label + ')', message: 'stop1:' + options.label })
  await stubs.hold({ label: 'late(' + options.label + ')', message: 'stop2:' + options.label })
  await stubs.expose({ name: 'echo', handler: 'echo' })
  if (options.fail) throw new Error('probe failed')
}

export async function echo(input) {
  return 'echo:' + String(input)
}
`;

const noteStub = createStub<string, void>({
  name: "note",
  declarations: "declare const note: (message: string) => Promise<void>",
  handler: ({ input }) => note(input),
});

const holdStub = createStub<{ label: string; message: string }, void>({
  name: "hold",
  declarations:
    "declare const hold: (held: { label: string; message: string }) => Promise<void>",
  handler: ({ input, instance }) => {
    instance.cleanup(holdCleanup(input.message), input.label);
  },
});

const exposeStub = createStub<{ name: string; handler: string }, void>({
  name: "expose",
  declarations:
    "declare const expose: (handler: { name: string; handler: string }) => Promise<void>",
  handler: ({ input, instance, instanceId, call }) => {
    const key = `${instanceId}:${input.name}`;
    handlers.set(key, (argument) => call(input.handler, argument));
    instance.cleanup(() => {
      handlers.delete(key);
    }, input.name);
  },
});

const gateStub = createStub<void, string>({
  name: "gate",
  declarations: "declare const gate: () => Promise<string>",
  deps: [gateKey],
  handler: ({ instance }) => instance.context.get(gateKey),
});

/** Builds the probe as plugin source started through a host. */
export const sourceArm = (host?: string, hosts?: Record<string, Host>) => ({
  name: `plugin source in ${host ?? "in-process"}`,
  hosts,
  entry: (id: string, options: ProbeOptions): PluginEntry => ({
    id,
    source: probeSource,
    host: host ?? "in-process",
    stubs: options.needs
      ? [noteStub, holdStub, exposeStub, gateStub]
      : [noteStub, holdStub, exposeStub],
    options,
  }),
});

// ------------------------------------------------------------- the suite

/** One way of putting the probe into a plugin list. */
export interface ContractArm {
  name: string;
  hosts?: Record<string, Host>;
  entry: (id: string, options: ProbeOptions) => PluginEntry;
  /** Run one assertion inside a host-owned context, such as a Durable Object. */
  scope?: <T>(work: () => Promise<T>) => Promise<T>;
}

/**
 * The kernel's rules for one instance, asserted against whatever the arm
 * builds. Every arm must pass every one of them unchanged.
 */
export function runInstanceContract(arm: ContractArm): void {
  describe(arm.name, () => {
    let client: Client;

    const start = async (...entries: Array<PluginEntry>) => {
      client = createClient({
        plugins: entries,
        ...(arm.hosts ? { hosts: arm.hosts } : {}),
      });
      await client.settled();
      return client;
    };

    const scoped = <T>(work: () => Promise<T>): Promise<T> =>
      arm.scope?.(work) ?? work();

    beforeEach(() => {
      notes = [];
      handlers.clear();
    });

    it("starts, records what it registered, and is listed as an ordinary instance", () =>
      scoped(async () => {
        await start(arm.entry("a", { label: "a" }));

        const [snapshot] = client.inspect();
        expect(snapshot?.id).toBe("a");
        expect(snapshot?.status).toBe("active");
        expect(snapshot?.missing).toEqual([]);
        expect(notes).toEqual(["start:a"]);

        const labels = client
          .resources("a")
          ?.children.map((node) => node.label);
        expect(labels).toContain("probe(a)");
        expect(labels).toContain("late(a)");
      }));

    it("leaves no trace when it is removed, and removing twice is safe", () =>
      scoped(async () => {
        await start(
          arm.entry("a", { label: "a" }),
          arm.entry("b", { label: "b" }),
        );
        notes = [];

        await Promise.all([client.removePlugin("a"), client.removePlugin("a")]);

        expect(notes).toEqual(["stop2:a", "stop1:a"]);
        expect(client.inspect().map((one) => one.id)).toEqual(["b"]);
        expect(client.resources("a")).toBeUndefined();
        expect(handlers.has("a:echo")).toBe(false);
      }));

    it("runs a handler it registered, through whatever boundary it is behind", () =>
      scoped(async () => {
        await start(arm.entry("a", { label: "a" }));
        await expect(handlers.get("a:echo")?.("hi")).resolves.toBe("echo:hi");
      }));

    it("ends in error when it throws while starting, leaving siblings alone", () =>
      scoped(async () => {
        await start(
          arm.entry("a", { label: "a", fail: true }),
          arm.entry("b", { label: "b" }),
        );

        const [failed, sibling] = client.inspect();
        expect(failed?.status).toBe("error");
        expect(String((failed?.error as Error).message)).toContain(
          "probe failed",
        );
        expect(sibling?.status).toBe("active");
        // Nothing it half-registered survives.
        expect(notes).toContain("stop1:a");
        expect(handlers.has("a:echo")).toBe(false);
        expect(client.resources("a")?.children).toEqual([]);
      }));

    it("stays pending until its dep is provided, and names what is missing", () =>
      scoped(async () => {
        await start(arm.entry("a", { label: "a", needs: true }));

        expect(client.inspect()[0]?.status).toBe("pending");
        expect(client.inspect()[0]?.missing).toEqual(["contract.gate"]);
        expect(notes).toEqual([]);

        await client.addPlugin({ id: "gate", plugin: gatePlugin });
        expect(client.inspect()[0]?.status).toBe("active");
        expect(notes).toEqual(["start:a"]);
      }));

    it("is cleaned up and returns to pending when its dep goes away", () =>
      scoped(async () => {
        await start(
          { id: "gate", plugin: gatePlugin },
          arm.entry("a", { label: "a", needs: true }),
        );
        notes = [];

        const probe = () => client.inspect().find((one) => one.id === "a");

        await client.setEnabled("gate", false);
        expect(probe()?.status).toBe("pending");
        expect(notes).toEqual(["stop2:a", "stop1:a"]);

        notes = [];
        await client.setEnabled("gate", true);
        expect(probe()?.status).toBe("active");
        expect(notes).toEqual(["start:a"]);
      }));

    it("restarts only itself when its options change", () =>
      scoped(async () => {
        await start(
          arm.entry("a", { label: "a" }),
          arm.entry("b", { label: "b" }),
        );
        notes = [];

        await client.setOptions("a", { label: "a2" });

        expect(notes).toEqual(["stop2:a", "stop1:a", "start:a2"]);
        expect(client.inspect().map((one) => one.status)).toEqual([
          "active",
          "active",
        ]);
      }));

    it("is removed by disabling its entry and restored by enabling it", () =>
      scoped(async () => {
        await start(arm.entry("a", { label: "a" }));
        notes = [];

        await client.setEnabled("a", false);
        expect(client.inspect()).toEqual([]);
        expect(notes).toEqual(["stop2:a", "stop1:a"]);

        notes = [];
        await client.setEnabled("a", true);
        expect(client.inspect()[0]?.status).toBe("active");
        expect(notes).toEqual(["start:a"]);
      }));
  });
}
