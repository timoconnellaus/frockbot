import { createContextKey, createPlugin } from "@frockbot/compose-core";
import type { ContextKey, StandardSchemaV1 } from "@frockbot/compose-core";

/**
 * Where a **credential** value comes from in one runtime: a process
 * environment, a Worker's bindings, a value a person typed into a page. A
 * source answers by name and offers no way to list what it holds, so a plugin
 * that has one can read the credential it was told to read and learn nothing
 * else.
 */
export interface CredentialSource {
  /** The value of the credential with this name, or `undefined`. */
  get: (name: string) => string | undefined;
}

/**
 * What a plugin that needs a **credential** reads. It names the credential in
 * its options and asks for the value here; the value itself is never in the
 * plugin list, the session, a store or any tool result.
 *
 * There is deliberately no way to list the names or the values: a plugin can
 * only ask about a credential the operator already told it to use.
 */
export interface Credentials {
  /** The value of the credential with this name, or `undefined`. */
  get: (name: string) => string | undefined;
  /** Whether there is a value for this name, without reading it. */
  has: (name: string) => boolean;
}

/**
 * The **credentials** key: how a plugin reads a secret it was told the name of.
 * The key is stable — one operator plugin provides it for the life of the
 * client, and which runtime the values come from is that plugin's option, not
 * the reading plugin's concern (E5).
 */
export const credentialsKey: ContextKey<Credentials> =
  createContextKey<Credentials>("agent.credentials");

/**
 * A **credential source** over the process environment. The default, and what a
 * command-line agent or a server process wants.
 *
 * @example
 * ```ts
 * { id: 'credentials', plugin: credentialsPlugin } // the same thing
 * { id: 'credentials', plugin: credentialsPlugin, options: { source: environmentCredentials() } }
 * ```
 */
export const environmentCredentials = (): CredentialSource => ({
  get: (name: string) =>
    (
      globalThis as {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process?.env?.[name],
});

/**
 * A **credential source** over values already in memory: what a test uses, and
 * what a page that asks a person for a key uses.
 *
 * The record is held in this closure and nowhere else. It is in memory only —
 * it is not written anywhere, and nothing persists it across a reload — so a
 * page that collects a key this way collects it again next time.
 *
 * @example
 * ```ts
 * { id: 'credentials', plugin: credentialsPlugin, options: { source: staticCredentials({ OPENAI_API_KEY: typed }) } }
 * ```
 */
export const staticCredentials = (
  values: Readonly<Record<string, string | undefined>>,
): CredentialSource => {
  const held = { ...values };
  return {
    get: (name: string) =>
      Object.prototype.hasOwnProperty.call(held, name) ? held[name] : undefined,
  };
};

/** What an operator hands the credentials plugin. */
export interface CredentialsOptionsInput {
  /** Where values come from. Defaults to the process environment. */
  source?: CredentialSource;
}

interface CredentialsOptions {
  source: CredentialSource;
}

const isSource = (value: unknown): value is CredentialSource =>
  typeof (value as CredentialSource | null)?.get === "function";

const credentialsOptions: StandardSchemaV1<
  CredentialsOptionsInput | undefined,
  CredentialsOptions
> = {
  "~standard": {
    version: 1,
    vendor: "frockbot-compose-agent",
    validate: (value: unknown) => {
      const input = (value ?? {}) as CredentialsOptionsInput;
      if (input.source !== undefined && !isSource(input.source)) {
        return {
          issues: [
            {
              message: "expected a credential source with a get(name) function",
              path: ["source"],
            },
          ],
        };
      }
      return { value: { source: input.source ?? environmentCredentials() } };
    },
  },
};

/**
 * The operator's plugin for one runtime's secrets: it provides
 * {@link credentialsKey} for the life of the client, reading values from the
 * **credential source** it was given.
 *
 * The source lives in this instance's closure. Nothing puts a value into the
 * plugin list, the session, a store, `inspect()` or a tool result — a plugin
 * that needs a secret names it, and the value travels no further than the
 * request it is used in (E5).
 *
 * @example
 * ```ts
 * { id: 'credentials', plugin: credentialsPlugin } // the process environment
 * ```
 */
export const credentialsPlugin = createPlugin({
  name: "credentials",
  provides: [credentialsKey],
  validator: credentialsOptions,
  setup(instance, options) {
    // The source is captured here and never published. The value the key hands
    // back is a pair of functions over it, so there is nothing to enumerate.
    const source = options.source;
    instance.provide(credentialsKey, {
      get: (name: string) => source.get(name),
      has: (name: string) => source.get(name) !== undefined,
    });
  },
});
