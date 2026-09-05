import { DurableObject } from "cloudflare:workers";
import {
  createClient,
  createPlugin,
  createStub,
  sourceErrorOf,
  stubCallAction,
} from "@frockbot/compose-core";
import {
  aiStub,
  filesStub,
  httpStub,
  scheduleStub,
  storageStub,
} from "@frockbot/compose-core/grants";
import { createFacetHost } from "../src/index";
import type { Client, PluginEntry } from "@frockbot/compose-core";
import type { FacetHost, StubAnswer, StubProps } from "../src/index";

interface Env {
  LOADER: WorkerLoader;
  FACET_TEST: DurableObjectNamespace;
  FILES: R2Bucket;
}

const storageSource = (step: number): string => `
let api
export default async function ({ stubs }) {
  api = stubs
  const before = await stubs.storage.get('count') ?? 0
  await stubs.storage.set('count', before + ${step})
}
export async function read() { return await api.storage.get('count') }
`;

/** A test-only supervisor proving the installed workerd can execute facets. */
export class FacetTestObject extends DurableObject<Env> {
  #client?: Client;
  #events: Array<string> = [];
  #host?: FacetHost;

  #facetHost(): FacetHost {
    this.#host ??= createFacetHost({
      ctx: this.ctx,
      self: () => this.env.FACET_TEST.get(this.ctx.id),
      loader: this.env.LOADER,
      compatibilityDate: "2026-05-01",
      callTimeoutMs: 6000,
      services: {
        currency: {
          origin: "https://currency.test",
          credential: { header: "authorization", value: "Bearer hidden" },
        },
      },
      serviceBindings: {
        currency: {
          fetch(input: Request) {
            const request = new Request(input);
            return Promise.resolve(
              Response.json({
                authorized:
                  request.headers.get("authorization") === "Bearer hidden",
              }),
            );
          },
        } as Fetcher,
      },
      ai: {
        run: () =>
          Promise.resolve({
            choices: [{ message: { content: "model answer" } }],
          }),
      },
      files: this.env.FILES,
    });
    return this.#host;
  }

  #noteStub() {
    return createStub<string, void>({
      name: "note",
      declarations: "declare const note: (value: string) => Promise<void>",
      handler: ({ input }) => {
        this.#events.push(input);
      },
    });
  }

  /** Direct-only test hook used while `runInDurableObject` owns the context. */
  facetHost() {
    return this.#facetHost();
  }

  async storageLifecycle(): Promise<Array<number | undefined>> {
    const entry = (source: string, options?: unknown): PluginEntry => ({
      id: "stored",
      source,
      host: "cloudflare",
      stubs: [storageStub],
      options,
    });
    const client = createClient({
      hosts: { cloudflare: this.#facetHost() },
      plugins: [entry(storageSource(1))],
    });
    this.#client = client;
    await client.settled();
    const values: Array<number | undefined> = [
      (await client.callSource("stored", "read")) as number,
    ];

    await client.setOptions("stored", { changed: true });
    values.push((await client.callSource("stored", "read")) as number);

    await client.setPluginList([entry(storageSource(10))]);
    values.push((await client.callSource("stored", "read")) as number);

    await client.removePlugin("stored");
    await client.addPlugin(entry(storageSource(10)));
    values.push((await client.callSource("stored", "read")) as number);
    return values;
  }

  async scheduleOnce(): Promise<void> {
    const note = this.#noteStub();
    const source = `
let api
export default async function ({ stubs }) {
  api = stubs
  await stubs.schedule.at(Date.now() + 20, 'fire')
}
export async function fire() { await api.note('fired') }
`;
    this.#client = createClient({
      hosts: { cloudflare: this.#facetHost() },
      plugins: [
        {
          id: "scheduled",
          source,
          host: "cloudflare",
          stubs: [scheduleStub, note],
        },
      ],
    });
    await this.#client.settled();
  }

  async scheduleEvery(): Promise<void> {
    const note = this.#noteStub();
    this.#client = createClient({
      hosts: { cloudflare: this.#facetHost() },
      plugins: [
        {
          id: "recurring",
          source: `
let api
export default async function ({ stubs }) {
  api = stubs
  await stubs.schedule.every(20, 'fire')
}
export async function fire() { await api.note('tick') }
export async function cancel() { await api.schedule.cancel() }
`,
          host: "cloudflare",
          stubs: [scheduleStub, note],
        },
      ],
    });
    await this.#client.settled();
  }

  async cancelRecurring(): Promise<void> {
    await this.#client?.callSource("recurring", "cancel");
  }

  async scheduleThroughRestartAndRewrite(): Promise<void> {
    const note = this.#noteStub();
    const first = `
let api
export default async function ({ options, stubs }) {
  api = stubs
  if (options.arm) await stubs.schedule.at(Date.now() + 100, 'fire')
}
export async function fire() { await api.note('first') }
`;
    const rewritten = `
let api
export default function ({ stubs }) { api = stubs }
export async function fire() { await api.note('survived') }
export async function arm() {
  await api.schedule.at(Date.now() + 40, 'fire')
}
`;
    const entry = (source: string, arm: boolean): PluginEntry => ({
      id: "survivor",
      source,
      options: { arm },
      host: "cloudflare",
      stubs: [scheduleStub, note],
    });
    this.#client = createClient({
      hosts: { cloudflare: this.#facetHost() },
      plugins: [entry(first, true)],
    });
    await this.#client.settled();
    await this.#client.setOptions("survivor", { arm: false });
    await this.#client.setPluginList([entry(rewritten, false)]);
  }

  async armSurvivor(): Promise<void> {
    await this.#client?.callSource("survivor", "arm");
  }

  async removeScheduled(id: string): Promise<void> {
    await this.#client?.removePlugin(id);
  }

  async schedulePair(): Promise<void> {
    const note = this.#noteStub();
    const source = `
let api, label
export default async function ({ options, stubs }) {
  api = stubs
  label = options.label
  await stubs.schedule.every(30, 'fire')
}
export async function fire() { await api.note(label) }
`;
    const entry = (id: string): PluginEntry => ({
      id,
      source,
      options: { label: id },
      host: "cloudflare",
      stubs: [scheduleStub, note],
    });
    this.#client = createClient({
      hosts: { cloudflare: this.#facetHost() },
      plugins: [entry("left"), entry("right")],
    });
    await this.#client.settled();
  }

  async standardGrants(): Promise<unknown> {
    const entry: PluginEntry = {
      id: "standard-grants",
      source: `
let api
export default ({ stubs }) => { api = stubs }
export async function run() {
  const response = await api.http.fetch('currency', '/rates')
  const text = await api.ai.text({ prompt: 'hello' })
  await api.files.put('note.txt', text, { contentType: 'text/plain' })
  const file = await api.files.get('note.txt')
  return {
    response: JSON.parse(response.body),
    text: new TextDecoder().decode(file.body),
    contentType: file.contentType,
    names: await api.files.list(),
  }
}
export const names = () => api.files.list()
`,
      host: "cloudflare",
      stubs: [httpStub, aiStub, filesStub],
    };
    this.#client = createClient({
      hosts: { cloudflare: this.#facetHost() },
      plugins: [entry],
    });
    await this.#client.settled();
    const value = await this.#client.callSource("standard-grants", "run");
    await this.#client.removePlugin("standard-grants");
    await this.#client.addPlugin(entry);
    const afterRemoval = await this.#client.callSource(
      "standard-grants",
      "names",
    );
    return { value, afterRemoval };
  }

  async httpMiddlewareIsolation(): Promise<unknown> {
    const policy = createPlugin({
      name: "http-policy",
      setup(instance) {
        instance.use(stubCallAction, ({ input, next }) => {
          if (input.instanceId === "blocked" && input.stub === "http") {
            throw new Error("HTTP refused for blocked");
          }
          return next(input);
        });
      },
    });
    const source = `
let http
export default ({ stubs }) => { http = stubs.http }
export const run = () => http.fetch('currency', '/rates')
`;
    const entry = (id: string): PluginEntry => ({
      id,
      source,
      host: "cloudflare",
      stubs: [httpStub],
    });
    this.#client = createClient({
      hosts: { cloudflare: this.#facetHost() },
      plugins: [
        { id: "http-policy", plugin: policy },
        entry("blocked"),
        entry("allowed"),
      ],
    });
    await this.#client.settled();
    let blocked = "";
    try {
      await this.#client.callSource("blocked", "run");
    } catch (error) {
      blocked = sourceErrorOf(error)?.message ?? String(error);
    }
    const allowed = (await this.#client.callSource("allowed", "run")) as {
      status: number;
    };
    return { blocked, allowed: allowed.status };
  }

  /** A refused service is an error the plugin can catch, not a hang. */
  async httpRefusal(): Promise<unknown> {
    const entry: PluginEntry = {
      id: "http-refusal",
      source: `
let http
export default ({ stubs }) => { http = stubs.http }
export async function run() {
  try {
    await http.fetch('bank', '/rates')
    return 'answered'
  } catch (error) {
    return 'refused: ' + error.message
  }
}
`,
      host: "cloudflare",
      stubs: [httpStub],
    };
    this.#client = createClient({
      hosts: { cloudflare: this.#facetHost() },
      plugins: [entry],
    });
    await this.#client.settled();
    return await this.#client.callSource("http-refusal", "run");
  }

  /** The same refusal during setup, while the object awaits that setup. */
  async httpRefusalInSetup(): Promise<unknown> {
    const entry: PluginEntry = {
      id: "http-refusal-setup",
      source: `
let outcome = 'unset'
export default async ({ stubs }) => {
  try {
    await stubs.http.fetch('bank', '/rates')
    outcome = 'answered'
  } catch (error) {
    outcome = 'refused: ' + error.message
  }
}
export const run = () => outcome
`,
      host: "cloudflare",
      stubs: [httpStub],
    };
    this.#client = createClient({
      hosts: { cloudflare: this.#facetHost() },
      plugins: [entry],
    });
    await this.#client.settled();
    const status = this.#client.inspect().find((one) => one.id === entry.id);
    return {
      status: status?.status,
      error: status?.error ? String(status.error) : undefined,
      outcome: await this.#client.callSource("http-refusal-setup", "run"),
    };
  }

  /**
   * The object restarts (a new host, a new client) while the facet from its
   * earlier life is still running: setup must run again for the new life.
   */
  async facetOutlivesHost(): Promise<Array<string>> {
    const note = this.#noteStub();
    const entry: PluginEntry = {
      id: "survivor",
      source: `
export default async function ({ stubs }) {
  await stubs.note('setup ran')
}
`,
      host: "cloudflare",
      stubs: [note],
    };
    const first = createClient({
      hosts: { cloudflare: this.#facetHost() },
      plugins: [entry],
    });
    await first.settled();
    // The earlier life ends without stopping anything, as an eviction or a
    // reload would: only the in-memory host and client are gone.
    this.#host = undefined;
    this.#client = createClient({
      hosts: { cloudflare: this.#facetHost() },
      plugins: [entry],
    });
    await this.#client.settled();
    const status = this.#client.inspect().find((one) => one.id === "survivor");
    return [...this.#events, `status:${status?.status ?? "missing"}`];
  }

  events(): Array<string> {
    return [...this.#events];
  }

  async alarm(): Promise<void> {
    await this.#facetHost().alarm();
  }

  /** Re-entered loopback calls; call only as an RPC into this object. */
  async composeStubCall(props: StubProps, input: unknown): Promise<StubAnswer> {
    return await this.#facetHost().stubCall(props, input);
  }

  /** Re-entered schedule writes; call only as an RPC into this object. */
  async composeSchedule(operation: unknown): Promise<void> {
    await this.#facetHost().schedule(operation);
  }

  async stopClient(): Promise<void> {
    await this.#client?.destroy();
  }
}
