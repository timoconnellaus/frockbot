import { describe, expect, test } from "bun:test";
import {
  parseAuthenticationResultsV1,
  senderAuthenticationV1,
  type EmailHeaderV1,
} from "./authentication.ts";

const CLOUDFLARE_PASS = `i=1; mx.cloudflare.net;
	dkim=pass header.d=gmail.com header.s=20230601 header.b=AbCdEf12;
	dmarc=pass header.from=gmail.com policy.dmarc=none;
	spf=pass (mx.cloudflare.net: domain of tim@gmail.com designates 209.85.1.2 as permitted sender) smtp.mailfrom=tim@gmail.com;
	arc=none smtp.remote-ip=209.85.1.2`;

function arc(value: string): EmailHeaderV1 {
  return { key: "arc-authentication-results", value };
}

describe("the receiving server's verdict", () => {
  test("reads the authserv-id and each method's result, comments and all", () => {
    const parsed = parseAuthenticationResultsV1(CLOUDFLARE_PASS, true);
    expect(parsed?.authservId).toBe("mx.cloudflare.net");
    expect(parsed?.results.map((result) => result.method)).toEqual([
      "dkim",
      "dmarc",
      "spf",
      "arc",
    ]);
    expect(parsed?.results[1]?.properties["header.from"]).toBe("gmail.com");
    // The comment's own `domain of … designates` is not a property.
    expect(parsed?.results[2]?.properties).toEqual({
      "smtp.mailfrom": "tim@gmail.com",
    });
  });

  test("passes a DMARC pass for the From domain", () => {
    expect(senderAuthenticationV1([arc(CLOUDFLARE_PASS)], "gmail.com")).toEqual(
      { status: "pass", basis: "dmarc" },
    );
    expect(
      senderAuthenticationV1(
        [
          {
            key: "authentication-results",
            value: "mx.cloudflare.net; dmarc=pass header.from=Example.COM",
          },
        ],
        "example.com",
      ),
    ).toEqual({ status: "pass", basis: "dmarc" });
  });

  test("a pass for another domain is not this sender's", () => {
    expect(senderAuthenticationV1([arc(CLOUDFLARE_PASS)], "work.com")).toEqual({
      status: "fail",
      reason: "not-aligned",
    });
  });

  test("no policy published: the From domain's own DKIM signature, and nothing less", () => {
    const noPolicy = (dkim: string) =>
      arc(
        `i=1; mx.cloudflare.net; ${dkim}; dmarc=none header.from=home.example; spf=pass smtp.mailfrom=me@home.example`,
      );
    expect(
      senderAuthenticationV1(
        [noPolicy("dkim=pass header.d=home.example")],
        "home.example",
      ),
    ).toEqual({ status: "pass", basis: "dkim" });
    // Signed by the provider, not by the domain in From.
    expect(
      senderAuthenticationV1(
        [noPolicy("dkim=pass header.d=mailer.example")],
        "home.example",
      ),
    ).toEqual({ status: "fail", reason: "not-aligned" });
    // SPF alone vouches for the envelope, not for From.
    expect(
      senderAuthenticationV1([noPolicy("dkim=none")], "home.example"),
    ).toEqual({ status: "fail", reason: "not-aligned" });
  });

  test("a DMARC failure fails, whatever else passed", () => {
    expect(
      senderAuthenticationV1(
        [
          arc(
            "i=1; mx.cloudflare.net; dkim=pass header.d=gmail.com; dmarc=fail header.from=gmail.com",
          ),
        ],
        "gmail.com",
      ),
    ).toEqual({ status: "fail", reason: "dmarc-fail" });
    expect(
      senderAuthenticationV1(
        [
          arc(
            "i=1; mx.cloudflare.net; dmarc=pass header.from=gmail.com; dmarc=fail header.from=gmail.com",
          ),
        ],
        "gmail.com",
      ),
    ).toEqual({ status: "fail", reason: "dmarc-fail" });
  });

  test("only the topmost verdict is believed, and only from the receiving server", () => {
    // A sender's own line below the server's fail does not rescue it.
    expect(
      senderAuthenticationV1(
        [
          arc("i=2; mx.cloudflare.net; dmarc=fail header.from=gmail.com"),
          {
            key: "authentication-results",
            value: "mx.cloudflare.net; dmarc=pass header.from=gmail.com",
          },
        ],
        "gmail.com",
      ),
    ).toEqual({ status: "fail", reason: "dmarc-fail" });
    // Another service's verdict on top is someone on the way, or the sender.
    expect(
      senderAuthenticationV1(
        [
          {
            key: "authentication-results",
            value: "mx.google.com; dmarc=pass header.from=gmail.com",
          },
          arc(CLOUDFLARE_PASS),
        ],
        "gmail.com",
      ),
    ).toEqual({ status: "fail", reason: "untrusted-verdict" });
    // A look-alike authserv-id is another service.
    expect(
      senderAuthenticationV1(
        [
          {
            key: "authentication-results",
            value:
              "mx.cloudflare.net.evil.example; dmarc=pass header.from=gmail.com",
          },
        ],
        "gmail.com",
      ),
    ).toEqual({ status: "fail", reason: "untrusted-verdict" });
  });

  test("fails closed with no verdict at all", () => {
    expect(senderAuthenticationV1([], "gmail.com")).toEqual({
      status: "fail",
      reason: "no-verdict",
    });
    // What issue workerd#6740 reports arriving at a Worker: Gmail's ARC seal
    // with no verdicts in it.
    expect(
      senderAuthenticationV1(
        [arc("i=1; mx.google.com; arc=none")],
        "gmail.com",
      ),
    ).toEqual({ status: "fail", reason: "untrusted-verdict" });
    expect(
      senderAuthenticationV1(
        [arc("i=1; mx.cloudflare.net; arc=none")],
        "gmail.com",
      ),
    ).toEqual({ status: "fail", reason: "no-verdict" });
    expect(
      senderAuthenticationV1([arc("mx.cloudflare.net; dmarc=pass")], "a.b"),
    ).toEqual({ status: "fail", reason: "no-verdict" });
  });
});
