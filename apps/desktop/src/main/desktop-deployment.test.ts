import { expect, test } from "bun:test";
import {
  deploymentFollowV1,
  deploymentStaleV1,
} from "@frockbot/plugin-shell/client/deployment";
import {
  DEPLOYMENT_HEADER_V1,
  responseFromDesktopApiV1,
} from "@frockbot/protocol";
import {
  decodeDesktopApiResponse,
  desktopApiResponseV1,
} from "./desktop-api.js";

const SERVED = "application-d1";
const ANSWERED = "application-d2";

/**
 * The whole desktop path for one answer: the main process makes the request
 * and encodes the reply, the DTO is serialized across IPC, the preload
 * decodes it, and the renderer rebuilds a `Response` the ordinary client code
 * reads. Serializing here is not ceremony — structured clone is what actually
 * runs between the two ends, and the bug this covers was a field the DTO
 * never carried in the first place.
 */
function acrossIpc(response: Response, body: string): Response {
  const encoded = desktopApiResponseV1(response, body);
  return responseFromDesktopApiV1(
    decodeDesktopApiResponse(JSON.parse(JSON.stringify(encoded))),
  );
}

test("a desktop window sees the application that answered it", () => {
  const answer = acrossIpc(
    new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        [DEPLOYMENT_HEADER_V1]: ANSWERED,
      },
    }),
    "{}",
  );
  const observed = answer.headers.get(DEPLOYMENT_HEADER_V1) ?? undefined;
  expect(observed).toBe(ANSWERED);
  expect(answer.headers.get("content-type")).toBe("application/json");
  // The window was served D1 and D2 answered, so the shell is behind — and
  // with nothing typed, nothing running and nothing open, it reloads itself
  // rather than leaving the desktop on client code the backend has replaced.
  expect(deploymentStaleV1(SERVED, observed)).toBe(true);
  expect(
    deploymentFollowV1({
      stale: deploymentStaleV1(SERVED, observed),
      turnRunning: false,
      draft: "",
      overlayOpen: false,
      listening: false,
      holds: 0,
      now: Date.parse("2026-09-05T00:00:00.000Z"),
    }),
  ).toBe("reload");
});

test("the same application answering leaves the window alone", () => {
  const answer = acrossIpc(
    new Response("{}", {
      status: 200,
      headers: { [DEPLOYMENT_HEADER_V1]: SERVED },
    }),
    "{}",
  );
  expect(
    deploymentStaleV1(
      SERVED,
      answer.headers.get(DEPLOYMENT_HEADER_V1) ?? undefined,
    ),
  ).toBe(false);
});

test("no other backend header crosses into the renderer", () => {
  const answer = acrossIpc(
    new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        [DEPLOYMENT_HEADER_V1]: ANSWERED,
        "set-cookie": "session=secret",
        "x-backend-detail": "internal",
      },
    }),
    "{}",
  );
  expect(answer.headers.get("set-cookie")).toBeNull();
  expect(answer.headers.get("x-backend-detail")).toBeNull();
});

test("a deployment name the platform would not have written is dropped", () => {
  const answer = acrossIpc(
    new Response("{}", {
      status: 200,
      headers: { [DEPLOYMENT_HEADER_V1]: "not a deployment name" },
    }),
    "{}",
  );
  expect(answer.headers.get(DEPLOYMENT_HEADER_V1)).toBeNull();
  // Nothing observed is not the same as a mismatch: a window with no answer
  // to compare against must not reload on a header it could not read.
  expect(deploymentStaleV1(SERVED, undefined)).toBe(false);
});

test("the decoder refuses a deployment name the main process did not validate", () => {
  expect(() =>
    decodeDesktopApiResponse({
      schemaVersion: 1,
      status: 200,
      contentType: "application/json",
      body: "{}",
      deployment: "not a deployment name",
    }),
  ).toThrow("invalid API response");
});
