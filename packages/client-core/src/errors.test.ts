import { describe, expect, test } from "bun:test";
import {
  classifyClientFailureV1,
  clientFailureDetailV1,
  presentClientFailureV1,
  readJsonResponseV1,
  serverRefusalMessageV1,
  TransportFailureV1,
} from "./errors.js";

describe("readJsonResponseV1", () => {
  test("returns the parsed body of a good response", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
    });
    expect(await readJsonResponseV1(response)).toEqual({ ok: true });
  });

  test("an HTML error body is a transport failure, not a parse error", async () => {
    // Incident 1: the visible symptom was `Unexpected token '<'` in the
    // sidebar.
    const response = new Response("<html><body>Bad gateway</body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
    const failure = await readJsonResponseV1(response).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TransportFailureV1);
    const transport = failure as TransportFailureV1;
    expect(transport.kind).toBe("unreachable");
    expect(transport.message).not.toContain("JSON");
    expect(transport.message).toBe("Couldn't reach FrockBot.");
    expect(transport.detail).toContain("Bad gateway");
  });

  test("a 200 with a non-JSON body is unreachable rather than a crash", async () => {
    const response = new Response("<html>proxy</html>", { status: 200 });
    const failure = (await readJsonResponseV1(response).catch(
      (error: unknown) => error,
    )) as TransportFailureV1;
    expect(failure.kind).toBe("unreachable");
  });

  test("a refusal's own sentence is offered, a fault's is not", async () => {
    // A 4xx is the deployment explaining a rule it holds, in words it wrote
    // for a person; a 5xx is a fault, and its text is about plumbing.
    const refusal = (await readJsonResponseV1(
      new Response(
        JSON.stringify({ error: "Your message is too long. Keep it short." }),
        { status: 413 },
      ),
    ).catch((error: unknown) => error)) as TransportFailureV1;
    expect(serverRefusalMessageV1(refusal)).toBe(
      "Your message is too long. Keep it short.",
    );

    const fault = (await readJsonResponseV1(
      new Response(JSON.stringify({ error: "R2 is down" }), { status: 500 }),
    ).catch((error: unknown) => error)) as TransportFailureV1;
    expect(serverRefusalMessageV1(fault)).toBeUndefined();
    expect(fault.detail).toBe("R2 is down");

    // Nothing written, nothing to offer.
    const bare = (await readJsonResponseV1(
      new Response("{}", { status: 400 }),
    ).catch((error: unknown) => error)) as TransportFailureV1;
    expect(serverRefusalMessageV1(bare)).toBeUndefined();
    expect(serverRefusalMessageV1(new Error("boom"))).toBeUndefined();
  });

  test("the server's error field is kept as detail, not as the message", async () => {
    const response = new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
    });
    const failure = (await readJsonResponseV1(response).catch(
      (error: unknown) => error,
    )) as TransportFailureV1;
    expect(failure.kind).toBe("server");
    expect(failure.detail).toBe("boom");
    expect(failure.message).not.toBe("boom");
  });

  test("carries the definitive flag through", async () => {
    const response = new Response(
      JSON.stringify({ error: "no", definitive: true }),
      { status: 400 },
    );
    const failure = (await readJsonResponseV1(response).catch(
      (error: unknown) => error,
    )) as TransportFailureV1;
    expect(failure.definitive).toBe(true);
    expect(failure.kind).toBe("rejected");
  });

  test("classifies by status", async () => {
    const kindOf = async (status: number): Promise<string> => {
      const failure = (await readJsonResponseV1(
        new Response("{}", { status }),
      ).catch((error: unknown) => error)) as TransportFailureV1;
      return failure.kind;
    };
    expect(await kindOf(401)).toBe("denied");
    expect(await kindOf(403)).toBe("denied");
    expect(await kindOf(404)).toBe("missing");
    expect(await kindOf(500)).toBe("server");
    expect(await kindOf(503)).toBe("unreachable");
    expect(await kindOf(422)).toBe("rejected");
  });
});

describe("presentClientFailureV1", () => {
  test("names what the User was doing", () => {
    const failure = new TransportFailureV1({
      kind: "server",
      detail: "boom",
    });
    expect(presentClientFailureV1(failure, "load your plugins")).toBe(
      "Couldn't load your plugins. Something went wrong at our end.",
    );
  });

  test("never repeats a parse error", () => {
    const parse = new SyntaxError(
      `Unexpected token '<', "<html><bod"... is not valid JSON`,
    );
    const sentence = presentClientFailureV1(parse, "load your flock");
    expect(sentence).not.toContain("JSON");
    expect(sentence).toBe("Couldn't load your flock — FrockBot didn't answer.");
  });

  test("a dropped fetch reads as unreachable", () => {
    expect(presentClientFailureV1(new TypeError("Failed to fetch"))).toBe(
      "Couldn't reach FrockBot.",
    );
  });

  test("keeps the raw text available for the console", () => {
    expect(clientFailureDetailV1(new Error("boom"))).toBe("boom");
    expect(classifyClientFailureV1("boom").detail).toBe("boom");
  });
});
