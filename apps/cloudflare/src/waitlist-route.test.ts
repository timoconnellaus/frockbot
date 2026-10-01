import { describe, expect, test } from "bun:test";
import { routeWaitlistV1, WAITLIST_PATH_V1 } from "./waitlist-route.js";

const homepage = "https://frockbot.com";

function post(fields: Record<string, string>): Request {
  return new Request(`https://bot.frockbot.com${WAITLIST_PATH_V1}`, {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

function recorder(answer: unknown = { schemaVersion: 1, status: "joined" }) {
  const joined: unknown[] = [];
  return {
    joined,
    join: (input: unknown) => {
      joined.push(input);
      return Promise.resolve(answer);
    },
  };
}

describe("the waitlist form", () => {
  test("joins with a normalized address and first job, then lands on thanks", async () => {
    const host = recorder();
    const response = await routeWaitlistV1(
      post({ email: " Person@Example.COM ", firstJob: " Watch\nprices " }),
      { homepage, join: host.join },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://frockbot.com/beta/thanks/",
    );
    expect(host.joined).toEqual([
      {
        schemaVersion: 1,
        email: "person@example.com",
        firstJob: "Watch prices",
      },
    ]);
  });

  test("an address already there, or a full list, looks exactly like joining", async () => {
    for (const status of ["already-joined", "full"]) {
      const response = await routeWaitlistV1(
        post({ email: "person@example.com" }),
        { homepage, ...recorder({ schemaVersion: 1, status }) },
      );
      expect(response.headers.get("location")).toBe(
        "https://frockbot.com/beta/thanks/",
      );
    }
  });

  test("a filled honeypot is thanked and kept nowhere", async () => {
    const host = recorder();
    const response = await routeWaitlistV1(
      post({ email: "bot@example.com", website: "https://spam.example" }),
      { homepage, join: host.join },
    );
    expect(response.headers.get("location")).toBe(
      "https://frockbot.com/beta/thanks/",
    );
    expect(host.joined).toEqual([]);
  });

  test("an unusable address goes back to the form without joining", async () => {
    const host = recorder();
    const response = await routeWaitlistV1(post({ email: "not-an-address" }), {
      homepage,
      join: host.join,
    });
    expect(response.headers.get("location")).toBe(
      "https://frockbot.com/beta/#join",
    );
    expect(host.joined).toEqual([]);
  });

  test("an authority that cannot answer says nothing was saved", async () => {
    const response = await routeWaitlistV1(
      post({ email: "person@example.com" }),
      { homepage, join: () => Promise.reject(new Error("unreachable")) },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Nothing was saved.");
  });

  test("answers only POST", async () => {
    const response = await routeWaitlistV1(
      new Request(`https://bot.frockbot.com${WAITLIST_PATH_V1}`),
      recorder() as never,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
