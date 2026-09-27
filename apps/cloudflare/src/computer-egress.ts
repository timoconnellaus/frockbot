// The door the Computer's connected-account proxy posts to. It is on the open
// internet, so the token is verified before any object is addressed: only a
// token this deployment signed names one.
import {
  COMPUTER_EGRESS_PATH_V1,
  decodeComputerEgressRequestV1,
  decodeComputerEgressResponseV1,
  verifyComputerEgressTokenV1,
  type ComputerEgressRequestV1,
} from "@frockbot/computer/egress";

export { COMPUTER_EGRESS_PATH_V1 };

/** A forwarded request: a 1 MB body in base64 plus its headers and URL. */
const MAX_BODY_BYTES = 1_500_000;

export interface ComputerEgressAnswerInputV1 {
  schemaVersion: 1;
  object: string;
  nonce: string;
  request: ComputerEgressRequestV1;
}

export function decodeComputerEgressAnswerInputV1(
  value: unknown,
): ComputerEgressAnswerInputV1 {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const request = decodeComputerEgressRequestV1(record.request);
  if (
    record.schemaVersion !== 1 ||
    typeof record.object !== "string" ||
    typeof record.nonce !== "string" ||
    !request
  ) {
    throw new Error("computer egress input is invalid");
  }
  return {
    schemaVersion: 1,
    object: record.object,
    nonce: record.nonce,
    request,
  };
}

function refuse(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function routeComputerEgressV1(
  request: Request,
  dependencies: {
    /** The signing secret; absent, the door is closed. */
    secret?: string;
    answer(input: ComputerEgressAnswerInputV1): Promise<unknown>;
    now?: number;
  },
): Promise<Response> {
  if (request.method !== "POST") return refuse(405, "method not allowed");
  if (!dependencies.secret) return refuse(503, "computer egress is off");
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? await verifyComputerEgressTokenV1(
        dependencies.secret,
        authorization.slice(7).trim(),
        dependencies.now,
      )
    : undefined;
  if (!token) return refuse(401, "token is invalid or expired");
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return refuse(413, "request is too large");
  let text: string;
  try {
    text = await request.text();
  } catch {
    return refuse(400, "request could not be read");
  }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return refuse(413, "request is too large");
  }
  let forwarded: ComputerEgressRequestV1 | undefined;
  try {
    forwarded = decodeComputerEgressRequestV1(JSON.parse(text));
  } catch {
    forwarded = undefined;
  }
  if (!forwarded) return refuse(400, "request is invalid");
  let answer: unknown;
  try {
    answer = await dependencies.answer({
      schemaVersion: 1,
      object: token.o,
      nonce: token.n,
      request: forwarded,
    });
  } catch (error) {
    console.error("computer egress failed", error);
    return refuse(502, "the request could not be answered");
  }
  const response = decodeComputerEgressResponseV1(answer);
  if (!response) return refuse(502, "the request could not be answered");
  return Response.json(response, {
    headers: { "cache-control": "no-store" },
  });
}
