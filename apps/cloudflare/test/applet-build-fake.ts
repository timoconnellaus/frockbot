// A faithful-enough stand-in for the `APPLET_BUILD` service binding.
//
// Why a stand-in and not the real service: a build runs inside a container,
// and `@cloudflare/vitest-plugin` cannot build, tag, or start an image — its
// pool never touches Docker. `apps/applet-build` is exercised where a
// container exists, and `apps/cloudflare/e2e/applets-publish.e2e.ts` is where
// the two halves meet.
//
// What is real here is the seam and the request. The binding is called the way
// the deployed Worker calls it — the same route, the same
// `x-frockbot-applet-build-token` header, the same encoded body — and its
// answer is the response shape the contract decodes, with honest hashes over
// the artifacts it declares. Every request is recorded, so a suite can read
// back the source the app actually posted rather than the source the app
// believed it posted; that is the observable half of reading a Workspace root
// and posting it for a build.
//
// It runs in Node (a Miniflare `serviceBindings` function), so the suites
// reach its state over the same binding, under `/__fake/*` — routes the real
// service does not serve.
import { createHash } from "node:crypto";
import type {
  AppletBuildKindV1,
  AppletBuildModeV1,
  AppletBuildSourceFileV1,
} from "@frockbot/applets/build-contract";

/**
 * The two wire constants the app sends, spelled out rather than imported.
 *
 * This module is loaded by the Vitest config, which runs in Node under
 * `--experimental-strip-types`: a *value* import of the build contract pulls in
 * a class whose parameter property Node refuses to strip, so the config would
 * not load at all. The type imports above are erased and cost nothing. Both
 * values are asserted against the contract by the request the app actually
 * posts — a route or header that drifted answers 404 or 401 to every check.
 */
const APPLET_BUILD_ROUTE = "/build";
const APPLET_BUILD_TOKEN_HEADER = "x-frockbot-applet-build-token";

/** The token the fake accepts. The config hands the app the same string. */
export const FAKE_APPLET_BUILD_TOKEN = "fake-applet-build-token";

/** One build the app asked for, as the fake read it off the wire. */
export interface FakeAppletBuildRequestV1 {
  version: number;
  effectId: string;
  kind: AppletBuildKindV1;
  id: string;
  mode: AppletBuildModeV1;
  files: AppletBuildSourceFileV1[];
}

/**
 * The artifacts every request compiles to.
 *
 * Fixed bytes rather than bytes derived from the source: this stands in for a
 * compiler, and what a suite reads from it is the request. The hashes it
 * declares are over these exact bytes, because the app verifies them and
 * refuses a manifest that describes artifacts it did not receive.
 */
const SERVER = "export const built = true;\n";
const UI = "<!doctype html><title>Fake build</title>\n";
const MODULE = "export const built = true;\n";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function createAppletBuildFake(): {
  fetch(request: Request): Promise<Response>;
  requests: FakeAppletBuildRequestV1[];
} {
  const requests: FakeAppletBuildRequestV1[] = [];

  function built(request: FakeAppletBuildRequestV1): unknown {
    if (request.kind === "plugin") {
      return {
        status: "built",
        manifest: {
          contract: 1,
          tools: [],
          hooks: [],
          services: [],
          triggers: [],
          views: [],
          cards: [],
          modelProviders: [],
          hashes: { module: sha256Hex(MODULE) },
        },
        module: MODULE,
      };
    }
    return {
      status: "built",
      manifest: {
        contract: 1,
        tools: [],
        hashes: { server: sha256Hex(SERVER), ui: sha256Hex(UI) },
      },
      server: SERVER,
      ui: UI,
    };
  }

  return {
    requests,
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === "/__fake/reset") {
        requests.length = 0;
        return Response.json({ ok: true });
      }
      if (pathname === "/__fake/requests") {
        return Response.json({ requests });
      }
      if (pathname !== APPLET_BUILD_ROUTE) {
        return Response.json({ error: "no such route" }, { status: 404 });
      }
      if (
        request.headers.get(APPLET_BUILD_TOKEN_HEADER) !==
        FAKE_APPLET_BUILD_TOKEN
      ) {
        return Response.json(
          { error: "the build token header is missing or wrong" },
          { status: 401 },
        );
      }
      const asked = (await request.json()) as FakeAppletBuildRequestV1;
      requests.push(asked);
      return Response.json(built(asked));
    },
  };
}
