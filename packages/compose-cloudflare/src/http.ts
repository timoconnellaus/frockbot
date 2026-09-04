import {
  executeHttpGrantFetch,
  type HttpGrantLimits,
  type HttpGrantResponse,
  type HttpOperation,
  type HttpServices,
} from "@frockbot/compose-core/grants";

/** The structural service-binding surface used by the HTTP grant. */
export interface HttpBinding {
  fetch(request: Request): Response | Promise<Response>;
}

export type { HttpGrantLimits };

export interface HttpGrantEnvironment extends HttpGrantLimits {
  services: HttpServices;
  bindings?: Readonly<Record<string, HttpBinding>>;
  fetch?: (request: Request) => Response | Promise<Response>;
}

const prefix = "@frockbot/compose-cloudflare";

/** Execute one approved HTTP grant operation inside the trusted host. */
export async function performHttpGrant(
  environment: HttpGrantEnvironment,
  value: unknown,
): Promise<HttpGrantResponse> {
  const input = value as HttpOperation | null;
  if (input?.method !== "fetch" || !Array.isArray(input.args)) {
    throw new Error(`${prefix}: unknown http operation`);
  }
  const [service, path, rawOptions] = input.args;
  return await executeHttpGrantFetch(
    {
      services: environment.services,
      prefix,
      ...(environment.timeoutMs === undefined
        ? {}
        : { timeoutMs: environment.timeoutMs }),
      ...(environment.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: environment.maxResponseBytes }),
      send: (request, name) => {
        const binding = environment.bindings?.[name];
        return binding
          ? binding.fetch(request)
          : (environment.fetch ?? fetch)(request);
      },
    },
    service,
    path,
    rawOptions,
  );
}
