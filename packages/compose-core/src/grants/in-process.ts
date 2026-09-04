import type {
  InProcessGrant,
  InProcessGrantContext,
  InProcessGrantInstance,
} from "../host";
import type { GrantMethodCall } from "../base";
import type {
  AiTextInput,
  FileValue,
  FilesOperation,
  HttpGrantResponse,
  HttpOperation,
  HttpRequestOptions,
  HttpServices,
  ScheduleOperation,
  StorageOperation,
} from "./definitions";

/** Options for the standard grants' in-process reference implementation. */
export interface InProcessGrantsOptions {
  services?: HttpServices;
  respond?: (input: AiTextInput) => string | Promise<string>;
  fetch?: typeof fetch;
}

interface LocalAlarm {
  at: number;
  every?: number;
  handler: string;
}

interface LocalState {
  values: Map<string, unknown>;
  alarm?: LocalAlarm;
  timer?: ReturnType<typeof setTimeout>;
  call?: InProcessGrantContext["call"];
}

const string = (value: unknown, what: string): string => {
  if (typeof value !== "string") {
    throw new Error(`@frockbot/compose-core: ${what} must be a string`);
  }
  return value;
};

const operation = <T>(value: unknown): T => value as T;
const clone = <T>(value: T): T =>
  typeof structuredClone === "function" ? structuredClone(value) : value;

const method = <T extends { method: string }, TMethod extends T["method"]>(
  input: T,
  expected: TMethod,
): Extract<T, { method: TMethod }> => {
  if (input.method !== expected) {
    throw new Error(
      `@frockbot/compose-core: expected ${expected} grant operation`,
    );
  }
  return input as Extract<T, { method: TMethod }>;
};

const armAlarm = (state: LocalState): void => {
  clearTimeout(state.timer);
  if (!state.alarm || !state.call) return;
  state.timer = setTimeout(
    () => {
      const alarm = state.alarm;
      if (!alarm) return;
      if (alarm.every === undefined) delete state.alarm;
      else alarm.at = Date.now() + alarm.every;
      void state.call?.(alarm.handler, { scheduledAt: Date.now() }).then(
        () => armAlarm(state),
        () => armAlarm(state),
      );
    },
    Math.max(0, state.alarm.at - Date.now()),
  );
};

const storageGrant = (): InProcessGrant => {
  const states = new Map<string, LocalState>();
  return {
    start(context): InProcessGrantInstance {
      const fresh = !states.has(context.instanceId);
      const state = states.get(context.instanceId) ?? { values: new Map() };
      states.set(context.instanceId, state);
      return {
        value: Object.freeze({
          get: async (key: unknown) => {
            const input = operation<StorageOperation>(
              await context.invoke({ method: "get", args: [key] }),
            );
            const read = method(input, "get");
            return clone(state.values.get(string(read.args[0], "storage key")));
          },
          set: async (key: unknown, value: unknown) => {
            const input = operation<StorageOperation>(
              await context.invoke({ method: "set", args: [key, value] }),
            );
            const write = method(input, "set");
            state.values.set(
              string(write.args[0], "storage key"),
              write.args[1],
            );
          },
          delete: async (key: unknown) => {
            const input = operation<StorageOperation>(
              await context.invoke({ method: "delete", args: [key] }),
            );
            const remove = method(input, "delete");
            return state.values.delete(string(remove.args[0], "storage key"));
          },
          list: async (prefix: unknown = "") => {
            const input = operation<StorageOperation>(
              await context.invoke({ method: "list", args: [prefix] }),
            );
            const listed = method(input, "list");
            const start = string(listed.args[0] ?? "", "storage prefix");
            const result: Record<string, unknown> = {};
            for (const [key, value] of state.values) {
              if (key.startsWith(start)) result[key] = clone(value);
            }
            return result;
          },
        }),
        failed: fresh
          ? () => {
              states.delete(context.instanceId);
            }
          : undefined,
        destroy: () => {
          states.delete(context.instanceId);
        },
      };
    },
  };
};

const scheduleGrant = (): InProcessGrant => {
  const states = new Map<string, LocalState>();
  return {
    start(context): InProcessGrantInstance {
      const fresh = !states.has(context.instanceId);
      const state: LocalState = states.get(context.instanceId) ?? {
        values: new Map(),
      };
      states.set(context.instanceId, state);

      const change = async (given: ScheduleOperation): Promise<void> => {
        const input = operation<ScheduleOperation>(await context.invoke(given));
        if (input.method === "cancel") {
          delete state.alarm;
          clearTimeout(state.timer);
          return;
        }
        let at: unknown;
        let every: number | undefined;
        if (input.method === "every") {
          const [ms] = input.args;
          if (!Number.isFinite(ms) || Number(ms) <= 0) {
            throw new Error("@frockbot/compose-core: interval must be >0");
          }
          every = Number(ms);
          at = Date.now() + every;
        } else {
          const [when] = input.args;
          at = when instanceof Date ? when.getTime() : when;
        }
        const handler = input.args[1];
        if (
          typeof at !== "number" ||
          !Number.isFinite(at) ||
          typeof handler !== "string" ||
          handler === ""
        ) {
          throw new Error(
            "@frockbot/compose-core: schedule needs a time and named export",
          );
        }
        state.alarm = {
          at,
          handler,
          ...(every ? { every } : {}),
        };
        armAlarm(state);
      };

      return {
        value: Object.freeze({
          every: (ms: unknown, handler: unknown) =>
            change({ method: "every", args: [ms, handler] }),
          at: (when: number | Date, handler: unknown) =>
            change({
              method: "at",
              args: [when, handler],
            }),
          cancel: () => change({ method: "cancel", args: [] }),
        }),
        ready: () => {
          state.call = context.call;
          armAlarm(state);
        },
        stop: () => {
          state.call = undefined;
          clearTimeout(state.timer);
        },
        failed: fresh
          ? () => {
              clearTimeout(state.timer);
              states.delete(context.instanceId);
            }
          : undefined,
        destroy: () => {
          clearTimeout(state.timer);
          states.delete(context.instanceId);
        },
      };
    },
  };
};

const httpGrant = (
  services: HttpServices,
  doFetch: typeof fetch,
): InProcessGrant => ({
  start(context) {
    return {
      value: Object.freeze({
        fetch: async (
          service: unknown,
          path: unknown,
          init?: unknown,
        ): Promise<HttpGrantResponse> => {
          const input = operation<HttpOperation>(
            await context.invoke({
              method: "fetch",
              args: [service, path, init],
            }),
          );
          const [approvedService, approvedPath, approvedInit] = input.args;
          const name = string(approvedService, "HTTP service");
          const policy = services[name];
          if (!policy) throw new Error(`no service named "${name}" is granted`);
          const base = new URL(policy.origin);
          const url = new URL(string(approvedPath, "HTTP path"), base);
          if (url.origin !== base.origin) {
            throw new Error(`HTTP path leaves the granted "${name}" origin`);
          }
          const request = (approvedInit ?? {}) as HttpRequestOptions;
          const headers = new Headers(request.headers);
          if (policy.credential) {
            headers.set(policy.credential.header, policy.credential.value);
          }
          const response = await doFetch(url, { ...request, headers });
          return {
            status: response.status,
            ok: response.ok,
            headers: Object.fromEntries(response.headers),
            body: await response.text(),
          };
        },
      }),
    };
  },
});

const aiGrant = (
  respond: NonNullable<InProcessGrantsOptions["respond"]>,
): InProcessGrant => ({
  start(context) {
    return {
      value: Object.freeze({
        text: async (given: unknown): Promise<string> => {
          const approved = operation<GrantMethodCall>(
            await context.invoke({ method: "text", args: [given] }),
          );
          const input = operation<AiTextInput>(approved.args[0]);
          if (typeof input.prompt !== "string") {
            throw new Error("@frockbot/compose-core: ai.text needs a prompt");
          }
          if (input.system !== undefined && typeof input.system !== "string") {
            throw new Error(
              "@frockbot/compose-core: ai.text system must be a string",
            );
          }
          return await respond(input);
        },
      }),
    };
  },
});

const bytes = async (value: unknown): Promise<ArrayBuffer> => {
  if (typeof value === "string") return new TextEncoder().encode(value).buffer;
  if (value instanceof ArrayBuffer) return value;
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return await value.arrayBuffer();
  }
  throw new Error(
    "@frockbot/compose-core: file body must be text, Blob or ArrayBuffer",
  );
};

const filesGrant = (): InProcessGrant => {
  const objects = new Map<string, FileValue>();
  return {
    start(context) {
      const prefix = `${context.instanceId}/`;
      const key = (value: unknown) => `${prefix}${string(value, "file key")}`;
      const fresh = ![...objects.keys()].some((name) =>
        name.startsWith(prefix),
      );
      const removeAll = () => {
        for (const name of objects.keys()) {
          if (name.startsWith(prefix)) objects.delete(name);
        }
      };
      return {
        value: Object.freeze({
          put: async (name: unknown, body: unknown, options?: unknown) => {
            const input = operation<FilesOperation>(
              await context.invoke({
                method: "put",
                args: [name, body, options],
              }),
            );
            if (input.method !== "put") return;
            const [approvedName, approvedBody, approvedOptions] = input.args;
            const contentType = (
              approvedOptions as { contentType?: unknown } | undefined
            )?.contentType;
            if (contentType !== undefined && typeof contentType !== "string") {
              throw new Error(
                "@frockbot/compose-core: file contentType must be a string",
              );
            }
            objects.set(key(approvedName), {
              body: await bytes(approvedBody),
              ...(contentType === undefined ? {} : { contentType }),
            });
          },
          get: async (name: unknown) => {
            const input = operation<FilesOperation>(
              await context.invoke({ method: "get", args: [name] }),
            );
            return clone(objects.get(key(method(input, "get").args[0])));
          },
          delete: async (name: unknown) => {
            const input = operation<FilesOperation>(
              await context.invoke({ method: "delete", args: [name] }),
            );
            objects.delete(key(method(input, "delete").args[0]));
          },
          list: async (given: unknown = "") => {
            const input = operation<FilesOperation>(
              await context.invoke({ method: "list", args: [given] }),
            );
            const start = key(method(input, "list").args[0] ?? "");
            return [...objects.keys()]
              .filter((name) => name.startsWith(start))
              .map((name) => name.slice(prefix.length))
              .sort();
          },
        }),
        failed: fresh ? removeAll : undefined,
        destroy: removeAll,
      };
    },
  };
};

/** Build the standard named grants for {@link createInProcessHost}. */
export function createInProcessGrants(
  options: InProcessGrantsOptions = {},
): Readonly<Record<string, InProcessGrant>> {
  return {
    storage: storageGrant(),
    schedule: scheduleGrant(),
    http: httpGrant(options.services ?? {}, options.fetch ?? fetch),
    ai: aiGrant(options.respond ?? ((input) => input.prompt)),
    files: filesGrant(),
  };
}
