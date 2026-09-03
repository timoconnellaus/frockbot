/**
 * The built Applet, running for real, in a Node process.
 *
 * Miniflare gives the built `dist/server.js` the one thing no fake can: a
 * SQLite-backed Durable Object with hibernating WebSockets, which is exactly
 * what the loader gives it in production. `applet dev` serves the page from
 * it, and `applet build` uses the same runtime to ask the mounted class what
 * tools it declares rather than guessing from the source.
 */

import { convertV4MiniflareOptions, Miniflare } from "miniflare";

/** Pinned with the SDK: the runtime an Applet is checked against. */
export const APPLET_COMPATIBILITY_DATE = "2026-08-27";

/**
 * The dev worker. It exists only to route: the DO class is the Applet's own,
 * and everything else here is the two seams the kernel provides in production
 * — a viewer token on the socket, and a `CAPABILITIES` binding.
 */
const DEV_WORKER = `
export { Applet } from "./server.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.APPLET.get(env.APPLET.idFromName(env.APPLET_ID));

    if (url.pathname === "/socket") {
      if (url.searchParams.get("token") !== env.APPLET_TOKEN) {
        return new Response("Forbidden", { status: 403 });
      }
      url.searchParams.set("viewer", url.searchParams.get("viewer") ?? "dev-viewer");
      return stub.fetch(new Request(url, request));
    }

    if (url.pathname === "/health") {
      return Response.json(await stub.health());
    }

    if (url.pathname === "/tool" && request.method === "POST") {
      const body = await request.json();
      try {
        return Response.json({ ok: true, result: await stub.invokeTool(body.name, body.input) });
      } catch (error) {
        return Response.json({ ok: false, error: String(error && error.message || error) });
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(env.APPLET_UI, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
`;

export interface AppletRuntimeOptions {
  /** Contents of `dist/server.js`: one ESM file importing only cloudflare:workers. */
  serverCode: string;
  /** Contents of `dist/ui.html`; omitted when only `health()` is wanted. */
  html?: string;
  appletId: string;
  /** The dev viewer token the socket demands. */
  token: string;
  /** 0 picks a free port. */
  port?: number;
}

export interface AppletRuntime {
  url: URL;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

export async function startAppletRuntime(
  options: AppletRuntimeOptions,
): Promise<AppletRuntime> {
  // Miniflare 5's own option shape is the wrangler config (`workers[].config`).
  // `convertV4MiniflareOptions` is the supported way to keep the flat v4 shape,
  // which is the one the Workers docs and the rest of this repo speak.
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        { type: "ESModule", path: "/index.mjs", contents: DEV_WORKER },
        { type: "ESModule", path: "/server.js", contents: options.serverCode },
      ],
      modulesRoot: "/",
      compatibilityDate: APPLET_COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { APPLET: { className: "Applet", useSQLite: true } },
      serviceBindings: {
        // The lease-backed proxy is a later slice; models are unavailable.
        CAPABILITIES: async () =>
          Response.json({ status: "unavailable", reason: "dev" }),
      },
      bindings: {
        APPLET_ID: options.appletId,
        APPLET_TOKEN: options.token,
        APPLET_UI: options.html ?? "",
      },
      host: "127.0.0.1",
      port: options.port ?? 0,
    }),
  );

  const url = await miniflare.ready;
  return {
    url,
    fetch: (path, init) =>
      miniflare.dispatchFetch(
        new URL(path, url).toString(),
        init as never,
      ) as unknown as Promise<Response>,
    dispose: () => miniflare.dispose(),
  };
}
