/**
 * The front Worker in the runtime that actually has to agree with it.
 *
 * `src/router.test.ts` pins the logic down with bun's own `Request`. Here the
 * same router runs in workerd, where the two things it does with a request are
 * the runtime's and not bun's: cloning a body to read it twice before
 * forwarding it, and rebuilding a `Request` around the caller's abort signal.
 * Both are silent when they are wrong.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  APPLET_BUILD_ROUTE,
  APPLET_BUILD_TOKEN_HEADER,
  encodeAppletBuildRequestV1,
} from "@frockbot/applets/build-contract";
import { FRONT_WORKER_TOKEN } from "./front-worker.ts";

const APPLET_ID = "vgpqfaCcwnPlzjYdb2mI.weekly-todos";
const URL_ = `https://applet-build.internal${APPLET_BUILD_ROUTE}`;

const BODY = JSON.stringify(
  encodeAppletBuildRequestV1({
    version: 1,
    effectId: "effect-1",
    kind: "applet",
    id: APPLET_ID,
    mode: "build",
    files: [
      { path: "applet.json", text: "{}" },
      { path: "server.ts", text: "export default class {}\n" },
    ],
  }),
);

function post(token: string | undefined, body = BODY): Request {
  return new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { [APPLET_BUILD_TOKEN_HEADER]: token }),
    },
    body,
  });
}

describe("the Applet build front Worker in workerd", () => {
  test("answers /healthz without a token", async () => {
    const response = await SELF.fetch("https://applet-build.internal/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, shards: 2 });
  });

  test("refuses a missing token", async () => {
    const response = await SELF.fetch(post(undefined));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      version: 1,
      code: "not-authorized",
      retryable: false,
    });
  });

  test("refuses a wrong token", async () => {
    expect((await SELF.fetch(post("not-the-token"))).status).toBe(401);
  });

  test("refuses a malformed body before it forwards", async () => {
    const response = await SELF.fetch(
      post(FRONT_WORKER_TOKEN, JSON.stringify({ version: 1 })),
    );
    expect(response.status).toBe(400);
  });

  test("forwards the body verbatim, with the token, to the Applet's shard", async () => {
    const response = await SELF.fetch(post(FRONT_WORKER_TOKEN));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      shard: expect.stringMatching(/^applet-build-[01]$/),
      method: "POST",
      path: APPLET_BUILD_ROUTE,
      token: FRONT_WORKER_TOKEN,
      contentType: "application/json",
      body: BODY,
    });
  });
});
