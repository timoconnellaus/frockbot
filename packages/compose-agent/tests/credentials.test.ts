import { createClient, createPlugin } from "@frockbot/compose-core";
import { describe, expect, it } from "bun:test";
import {
  credentialsKey,
  credentialsPlugin,
  environmentCredentials,
  modelKey,
  modelsPlugin,
  staticCredentials,
} from "../src";
import { buildComposer, listing, resultsOf } from "./helpers/composer";
import { validator } from "./helpers/validator";
import type { Client, PluginEntry } from "@frockbot/compose-core";
import type { CredentialSource, ModelProvider, SessionLog } from "../src";

/** The value no test may ever find anywhere the client publishes. */
const secret = "sk-never-observable-9d41";

const source: CredentialSource = staticCredentials({
  MODEL_CREDENTIAL: secret,
});

// ------------------------------------------------------------------ fixtures

interface ProviderOptionsInput {
  baseUrl: string;
  credential: string;
}

/**
 * A **model provider** in the shape E5 asks for: it names a **credential** and
 * reads the value through the key when it starts. The real one is its own
 * package; this one exists so the shape can be shown with no network.
 */
const keyedProviderPlugin = createPlugin({
  name: "keyed-provider",
  deps: [modelKey, credentialsKey],
  validator: validator<ProviderOptionsInput, ProviderOptionsInput>((value) => {
    const { baseUrl, credential } = value;
    if (typeof baseUrl !== "string") {
      return { issues: [{ message: "expected a string", path: ["baseUrl"] }] };
    }
    if (typeof credential !== "string") {
      return {
        issues: [{ message: "expected a string", path: ["credential"] }],
      };
    }
    return { value: { baseUrl, credential } };
  }),
  setup(instance, options) {
    const value = instance.context.get(credentialsKey).get(options.credential);
    if (value === undefined) {
      throw new Error(
        `the credential "${options.credential}" has no value; provide it through the credentials plugin or name another one`,
      );
    }
    // The name carries the endpoint so a test can see whether it moved. The
    // value stays in this closure and reaches nothing but the request.
    const provider: ModelProvider = {
      name: `keyed@${options.baseUrl}`,
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream() {
        yield { kind: "text", text: `authorized against ${options.baseUrl}` };
      },
    };
    instance.cleanup(
      instance.context.get(modelKey).register(provider),
      "provider(keyed)",
    );
  },
});

/** The two entries an operator adds: the runtime's secrets, and a provider. */
const withProvider = (
  baseUrl = "https://api.example.com/v1",
): Array<PluginEntry> => [
  {
    id: "credentials",
    plugin: credentialsPlugin,
    options: { source },
  },
  {
    id: "provider",
    plugin: keyedProviderPlugin,
    options: { baseUrl, credential: "MODEL_CREDENTIAL" },
  },
];

/** Everything the client publishes, plus the session, as one string to search. */
const everythingPublished = (client: Client, session: SessionLog): string => {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    {
      pluginList: client.pluginList.state,
      instances: client.instances.state,
      context: client.context.state,
      errors: client.errors.state,
      inspect: client.inspect(),
      resources: client.pluginList.state.map((entry) =>
        client.resources(entry.id),
      ),
      session: session.snapshot(),
      messages: session.messages(),
    },
    (_key, value: unknown) => {
      if (typeof value === "function") return `[function ${value.name}]`;
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[seen]";
        seen.add(value);
        if (value instanceof Error) {
          return { message: value.message, stack: value.stack };
        }
      }
      return value;
    },
  );
};

// --------------------------------------------------------------------- tests

describe("reading a credential by name", () => {
  it("answers for the name it was given and offers nothing to enumerate", async () => {
    const client = createClient({
      plugins: [
        { id: "credentials", plugin: credentialsPlugin, options: { source } },
      ],
    });
    await client.settled();

    const credentials = client.getContext(credentialsKey)!;
    expect(credentials.get("MODEL_CREDENTIAL")).toBe(secret);
    expect(credentials.has("MODEL_CREDENTIAL")).toBe(true);
    expect(credentials.get("SOMETHING_ELSE")).toBeUndefined();
    expect(credentials.has("SOMETHING_ELSE")).toBe(false);
    // Asking by name is the whole surface: nothing lists names or values.
    expect(Object.keys(credentials).sort()).toEqual(["get", "has"]);

    await client.destroy();
  });

  it("reads the process environment when the operator names no source", async () => {
    process.env.TEST_AGENT_CREDENTIAL = secret;
    const client = createClient({
      plugins: [{ id: "credentials", plugin: credentialsPlugin }],
    });
    await client.settled();

    expect(
      client.getContext(credentialsKey)!.get("TEST_AGENT_CREDENTIAL"),
    ).toBe(secret);
    expect(environmentCredentials().get("TEST_AGENT_CREDENTIAL")).toBe(secret);

    delete process.env.TEST_AGENT_CREDENTIAL;
    expect(
      client.getContext(credentialsKey)!.has("TEST_AGENT_CREDENTIAL"),
    ).toBe(false);

    await client.destroy();
  });

  it("leaves a provider whose credential has no value in error, naming the credential", async () => {
    const client = createClient({
      plugins: [
        {
          id: "credentials",
          plugin: credentialsPlugin,
          options: { source: staticCredentials({}) },
        },
        {
          id: "provider",
          plugin: keyedProviderPlugin,
          options: {
            baseUrl: "https://api.example.com/v1",
            credential: "MODEL_CREDENTIAL",
          },
        },
        { id: "models", plugin: modelsPlugin },
      ],
    });
    await client.settled();

    const provider = client.inspect().find((one) => one.id === "provider");
    expect(provider?.status).toBe("error");
    expect(String((provider?.error as Error).message)).toContain(
      'the credential "MODEL_CREDENTIAL" has no value',
    );
    // Nothing registered, so the agent has no model rather than an unauthorized one.
    expect(client.getContext(modelKey)!.list()).toEqual([]);

    await client.destroy();
  });
});

describe("where a credential value is allowed to appear", () => {
  it("keeps the value out of the plugin list, the stores, inspection, the session and every tool result", async () => {
    const { client, agent, session } = await buildComposer({
      select: "scripted",
      plugins: withProvider(),
      protected: ["session", "tools", "prompt", "models", "loop", "provider"],
      script: [
        { toolCalls: [{ name: "list_plugins", args: {} }] },
        {
          toolCalls: [
            {
              name: "configure_plugin",
              args: {
                id: "provider",
                options: {
                  baseUrl: "https://collector.example/v1",
                  credential: "MODEL_CREDENTIAL",
                },
              },
            },
          ],
        },
        { chunks: ["done"] },
      ],
    });

    agent.send("show me everything you are made of");
    await agent.idle();

    // The listing reached the model, and so did the refusal.
    const results = resultsOf(session);
    expect(results[0]?.entries.map((entry) => entry.id)).toContain("provider");
    expect(JSON.stringify(results)).not.toContain(secret);

    // The name is wherever the operator and the model wrote it. The value is
    // in none of it.
    const published = everythingPublished(client, session);
    expect(published).toContain("MODEL_CREDENTIAL");
    expect(published).not.toContain(secret);
    // And the provider really did have it: the turn ran against the endpoint.
    expect(
      client
        .getContext(modelKey)!
        .list()
        .map((one) => one.name),
    ).toEqual(["scripted", "keyed@https://api.example.com/v1"]);

    await client.destroy();
  });
});

describe("what the composer will not do to a model provider", () => {
  it("refuses to point a protected provider entry at another endpoint", async () => {
    const { client, agent, session } = await buildComposer({
      select: "scripted",
      plugins: withProvider(),
      protected: ["session", "tools", "prompt", "models", "loop", "provider"],
      script: [
        {
          toolCalls: [
            {
              name: "configure_plugin",
              args: {
                id: "provider",
                options: {
                  baseUrl: "https://collector.example/v1",
                  credential: "MODEL_CREDENTIAL",
                },
              },
            },
          ],
        },
        { chunks: ["done"] },
      ],
    });
    const before = listing(client);

    agent.send("point the model somewhere else");
    await agent.idle();

    const [result] = resultsOf(session);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe(
      'the entry "provider" is protected and cannot be changed',
    );
    expect(result?.entries[0]?.protected).toBe(true);

    // The endpoint did not move, in the list or in the running provider.
    expect(
      client.pluginList.state.find((one) => one.id === "provider")?.options,
    ).toEqual({
      baseUrl: "https://api.example.com/v1",
      credential: "MODEL_CREDENTIAL",
    });
    expect(
      client
        .getContext(modelKey)!
        .list()
        .map((one) => one.name),
    ).toContain("keyed@https://api.example.com/v1");
    expect(listing(client)).toEqual(before);

    await client.destroy();
  });
});
