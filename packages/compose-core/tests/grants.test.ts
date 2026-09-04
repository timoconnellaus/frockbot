import { describe, expect, it } from "bun:test";
import {
  createClient,
  createInProcessHost,
  createPlugin,
  sourceErrorOf,
  stubCallAction,
} from "../src";
import {
  aiStub,
  createInProcessGrants,
  filesStub,
  httpStub,
} from "../src/grants";

const currencyHandler = (
  request: Request,
  expectedCredential: string,
): Response => {
  if (request.headers.get("authorization") !== expectedCredential) {
    return Response.json({ error: "credential required" }, { status: 401 });
  }
  if (new URL(request.url).pathname !== "/rates") {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ base: "AUD", rates: { USD: 0.66, EUR: 0.61 } });
};

const services = {
  currency: {
    origin: "https://currency.showcase.test",
    credential: { header: "authorization", value: "Bearer hidden" },
  },
};

const host = () =>
  createInProcessHost({
    grants: createInProcessGrants({
      services,
      respond: ({ prompt, system }) => `${system ?? ""}:${prompt}`,
      fetch: ((input, init) =>
        Promise.resolve(
          currencyHandler(new Request(input, init), "Bearer hidden"),
        )) as typeof fetch,
    }),
  });

describe("standard in-process grants", () => {
  it("attaches a service credential and refuses unknown service names", async () => {
    const client = createClient({
      hosts: { "in-process": host() },
      plugins: [
        {
          id: "currency",
          source: `
let http
export default ({ stubs }) => { http = stubs.http }
export const rates = () => http.fetch('currency', '/rates')
export const bank = () => http.fetch('bank', '/rates')
`,
          stubs: [httpStub],
        },
      ],
    });
    await client.settled();

    await expect(client.callSource("currency", "rates")).resolves.toMatchObject(
      {
        status: 200,
        ok: true,
      },
    );
    let refused: unknown;
    try {
      await client.callSource("currency", "bank");
    } catch (error) {
      refused = error;
    }
    expect(sourceErrorOf(refused)?.message).toBe(
      'no service named "bank" is granted',
    );
  });

  it("dispatches HTTP through per-instance middleware", async () => {
    const policy = createPlugin({
      name: "policy",
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
export const rates = () => http.fetch('currency', '/rates')
`;
    const client = createClient({
      hosts: { "in-process": host() },
      plugins: [
        { id: "policy", plugin: policy },
        { id: "blocked", source, stubs: [httpStub] },
        { id: "allowed", source, stubs: [httpStub] },
      ],
    });
    await client.settled();

    await expect(client.callSource("blocked", "rates")).rejects.toThrow(
      /HTTP refused for blocked/,
    );
    await expect(client.callSource("allowed", "rates")).resolves.toMatchObject({
      status: 200,
    });
  });

  it("provides deterministic AI text and entry-prefixed files", async () => {
    const source = `
let api
export default ({ stubs }) => { api = stubs }
export const text = () => api.ai.text({ prompt: 'hello', system: 'brief' })
export async function files() {
  await api.files.put('note.txt', 'hello', { contentType: 'text/plain' })
  return { value: await api.files.get('note.txt'), names: await api.files.list('note') }
}
export async function erase() {
  await api.files.delete('note.txt')
  return api.files.get('note.txt')
}
export const names = () => api.files.list()
`;
    const client = createClient({
      hosts: { "in-process": host() },
      plugins: [{ id: "writer", source, stubs: [aiStub, filesStub] }],
    });
    await client.settled();

    await expect(client.callSource("writer", "text")).resolves.toBe(
      "brief:hello",
    );
    const result = (await client.callSource("writer", "files")) as {
      value: { body: ArrayBuffer; contentType?: string };
      names: Array<string>;
    };
    expect(new TextDecoder().decode(result.value.body)).toBe("hello");
    expect(result.value.contentType).toBe("text/plain");
    expect(result.names).toEqual(["note.txt"]);
    await expect(client.callSource("writer", "erase")).resolves.toBeUndefined();
    await client.callSource("writer", "files");

    await client.removePlugin("writer");
    await client.addPlugin({
      id: "writer",
      source,
      stubs: [aiStub, filesStub],
    });
    await expect(client.callSource("writer", "names")).resolves.toEqual([]);
  });

  it("echoes the prompt when no AI responder is configured", async () => {
    const client = createClient({
      hosts: {
        "in-process": createInProcessHost({
          grants: createInProcessGrants(),
        }),
      },
      plugins: [
        {
          id: "echo",
          source: `
let ai
export default ({ stubs }) => { ai = stubs.ai }
export const run = () => ai.text({ prompt: 'hello' })
`,
          stubs: [aiStub],
        },
      ],
    });
    await client.settled();

    await expect(client.callSource("echo", "run")).resolves.toBe("hello");
  });
});
