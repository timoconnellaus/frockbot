export interface FlyHostSmokeRequest {
  version: 1;
  effectId: string;
  botId: string;
  credentialRef: string;
  probe: string;
}

export interface FlyHostSmokeEvidence {
  effectId: string;
  stream: string;
  file: string;
  cancellationObserved: boolean;
  reconstructionObserved: boolean;
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

export function decodeSmokeRequest(value: unknown): FlyHostSmokeRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("effectId" in value) ||
    !boundedString(value.effectId, 128) ||
    !("botId" in value) ||
    !boundedString(value.botId, 128) ||
    !("credentialRef" in value) ||
    !boundedString(value.credentialRef, 256) ||
    !("probe" in value) ||
    !boundedString(value.probe, 1_024)
  ) {
    throw new TypeError("Invalid Fly host smoke request");
  }
  return {
    version: 1,
    effectId: value.effectId,
    botId: value.botId,
    credentialRef: value.credentialRef,
    probe: value.probe,
  };
}

function problem(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export async function decodeSmokeHttpRequest(
  request: Request,
): Promise<
  { ok: true; value: FlyHostSmokeRequest } | { ok: false; response: Response }
> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { ok: false, response: problem(400, "invalid-url") };
  }
  if (url.pathname !== "/v1/computer/smoke") {
    return { ok: false, response: problem(404, "not-found") };
  }
  if (request.method !== "POST") {
    return { ok: false, response: problem(405, "method-not-allowed") };
  }
  let body: unknown;
  try {
    body = await request.json();
    return { ok: true, value: decodeSmokeRequest(body) };
  } catch {
    return { ok: false, response: problem(400, "invalid-request") };
  }
}

export function encodeSmokeResponse(evidence: FlyHostSmokeEvidence) {
  return {
    version: 1 as const,
    effectId: evidence.effectId,
    capabilities: {
      streaming: evidence.stream.length > 0,
      files: evidence.file.length > 0,
      cancellation: evidence.cancellationObserved,
      reconstruction: evidence.reconstructionObserved,
    },
    evidence: {
      stream: evidence.stream,
      file: evidence.file,
    },
  };
}
