import { describe, expect, test } from "bun:test";
import {
  decodeJoinWaitlistRequestV1,
  decodeWaitlistViewV1,
  invitationNoticeMessageV1,
  normalizeFirstJobV1,
  WAITLIST_FIRST_JOB_MAX_LENGTH_V1,
} from "./waitlist.js";

describe("the first job someone would hand off", () => {
  test("is one plain line, cut to length, and nothing when blank", () => {
    expect(normalizeFirstJobV1("  Watch\nflight​ prices  ")).toBe(
      "Watch flight prices",
    );
    expect(normalizeFirstJobV1(" \n\t ")).toBeUndefined();
    expect(normalizeFirstJobV1(42)).toBeUndefined();
    expect([...(normalizeFirstJobV1("é".repeat(500)) ?? "")].length).toBe(
      WAITLIST_FIRST_JOB_MAX_LENGTH_V1,
    );
  });

  test("a join request carries it only as already normalized", () => {
    expect(
      decodeJoinWaitlistRequestV1({
        schemaVersion: 1,
        email: " Person@Example.com ",
        firstJob: "Renew the car insurance",
      }),
    ).toEqual({
      schemaVersion: 1,
      email: "person@example.com",
      firstJob: "Renew the car insurance",
    });
    expect(() =>
      decodeJoinWaitlistRequestV1({
        schemaVersion: 1,
        email: "person@example.com",
        firstJob: "two\nlines",
      }),
    ).toThrow("invalid");
    expect(() =>
      decodeJoinWaitlistRequestV1({
        schemaVersion: 1,
        email: "person@example.com",
        source: "home",
      }),
    ).toThrow("unknown fields");
  });
});

describe("the waitlist view", () => {
  test("decodes rows with their invitation and email outcome", () => {
    const view = decodeWaitlistViewV1({
      schemaVersion: 1,
      total: 2,
      waiting: 1,
      rows: [
        {
          entry: {
            schemaVersion: 1,
            email: "a@example.com",
            joinedAt: "2026-09-30T00:00:00.000Z",
          },
        },
        {
          entry: {
            schemaVersion: 1,
            email: "b@example.com",
            joinedAt: "2026-09-29T00:00:00.000Z",
          },
          invitation: {
            schemaVersion: 1,
            email: "b@example.com",
            invitedAt: "2026-10-01T00:00:00.000Z",
            invitedBy: "owner@example.com",
          },
          notice: {
            schemaVersion: 1,
            email: "b@example.com",
            status: "sent",
            updatedAt: "2026-10-01T00:00:01.000Z",
          },
        },
      ],
    });
    expect(view.rows[1]?.notice?.status).toBe("sent");
    expect(() =>
      decodeWaitlistViewV1({ ...view, rows: [{ entry: {}, extra: 1 }] }),
    ).toThrow();
  });
});

describe("the you're-in email", () => {
  test("says only what the deployment says, never what the form said", () => {
    const message = invitationNoticeMessageV1({
      productName: "FrockBot",
      origin: "https://bot.frockbot.com",
      email: "person@example.com",
    });
    expect(message.subject).toBe("You're in: your FrockBot invite");
    expect(message.body).toContain("https://bot.frockbot.com");
    expect(message.body).toContain("person@example.com");
    expect(message.body).toContain("you can ignore this email");
  });
});
