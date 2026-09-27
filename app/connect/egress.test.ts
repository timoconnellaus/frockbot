import { describe, expect, test } from "bun:test";
import { base64ToBytesV1, bytesToBase64V1 } from "@frockbot/computer/egress";
import type { ProxyRequestInputV1, ProxyRequestResultV1 } from "./composio.js";
import { sendAsConnectedAccountV1 } from "./egress.js";

function client(result: ProxyRequestResultV1, binary = new Uint8Array()) {
  const sent: ProxyRequestInputV1[] = [];
  return {
    sent,
    client: {
      proxyRequest: async (input: ProxyRequestInputV1) => {
        sent.push(input);
        return result;
      },
      readBinary: async () => binary,
    },
  };
}

const text = (bodyBase64: string) =>
  new TextDecoder().decode(base64ToBytesV1(bodyBase64));

describe("sending as a connected account", () => {
  test("carries the query and safe headers, and never the CLI's own credential", async () => {
    const { client: fake, sent } = client({
      status: 201,
      data: { number: 7 },
      headers: {
        link: '<https://api.github.com/x?page=2>; rel="next"',
        "x-ratelimit-remaining": "4999",
        "set-cookie": "a=b",
      },
    });
    const response = await sendAsConnectedAccountV1(
      fake,
      "ca_1",
      {
        method: "POST",
        url: "https://api.github.com/repos/o/r/issues?per_page=5",
        headers: {
          authorization: "token frockbot-connected-account",
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          cookie: "x=y",
        },
        bodyBase64: bytesToBase64V1(
          new TextEncoder().encode('{"title":"Broken build"}'),
        ),
      },
      "https://api.github.com/repos/o/r/issues",
    );
    expect(sent).toEqual([
      {
        connectedAccountId: "ca_1",
        endpoint: "https://api.github.com/repos/o/r/issues",
        method: "POST",
        body: { title: "Broken build" },
        parameters: [
          { name: "per_page", value: "5", type: "query" },
          {
            name: "accept",
            value: "application/vnd.github+json",
            type: "header",
          },
          { name: "content-type", value: "application/json", type: "header" },
        ],
      },
    ]);
    expect(response.status).toBe(201);
    expect(response.headers).toEqual({
      link: '<https://api.github.com/x?page=2>; rel="next"',
      "x-ratelimit-remaining": "4999",
      "content-type": "application/json; charset=utf-8",
    });
    expect(JSON.parse(text(response.bodyBase64))).toEqual({ number: 7 });
  });

  test("refuses a body that is not a JSON object before anything is sent", async () => {
    const { client: fake, sent } = client({
      status: 200,
      data: null,
      headers: {},
    });
    const response = await sendAsConnectedAccountV1(
      fake,
      "ca_1",
      {
        method: "POST",
        url: "https://api.github.com/markdown/raw",
        headers: { "content-type": "text/plain" },
        bodyBase64: bytesToBase64V1(new TextEncoder().encode("# hi")),
      },
      "https://api.github.com/markdown/raw",
    );
    expect(response.status).toBe(415);
    expect(sent).toHaveLength(0);
  });

  test("relays a binary answer from where the provider parked it", async () => {
    const { client: fake } = client(
      {
        status: 200,
        data: null,
        headers: {},
        binary: {
          url: "https://files.example/x",
          contentType: "application/zip",
        },
      },
      new Uint8Array([1, 2, 3]),
    );
    const response = await sendAsConnectedAccountV1(
      fake,
      "ca_1",
      {
        method: "GET",
        url: "https://api.github.com/repos/o/r/zipball",
        headers: {},
      },
      "https://api.github.com/repos/o/r/zipball",
    );
    expect(response.headers["content-type"]).toBe("application/zip");
    expect([...base64ToBytesV1(response.bodyBase64)]).toEqual([1, 2, 3]);
  });

  test("hands the provider a relative path for an app's generic address", async () => {
    const { client: fake, sent } = client({
      status: 200,
      data: {},
      headers: {},
    });
    await sendAsConnectedAccountV1(
      fake,
      "ca_2",
      {
        method: "GET",
        url: "https://notion.connected.internal/v1/users/me?x=1",
        headers: {},
      },
      "/v1/users/me",
    );
    expect(sent[0]).toMatchObject({
      endpoint: "/v1/users/me",
      parameters: [{ name: "x", value: "1", type: "query" }],
    });
  });
});
