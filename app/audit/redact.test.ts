import { describe, expect, test } from "bun:test";
import { auditArgumentDigestV1, auditPreviewV1 } from "./redact.ts";
import { AUDIT_MAX_PREVIEW_LENGTH_V1 } from "./shared.ts";

describe("the audit preview", () => {
  test("redacts a bearer token out of a shell command", () => {
    const preview = auditPreviewV1("shell", "computer_exec", {
      command:
        "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' https://api.example",
    });
    expect(preview).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(preview).toContain("[redacted:bearer-token]");
    // The rest of the command survives, which is the only reason to keep a
    // preview at all.
    expect(preview).toContain("https://api.example");
  });

  test("redacts a JWT and an sk- key", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(
      auditPreviewV1("shell", "computer_exec", { command: `echo ${jwt}` }),
    ).toBe("echo [redacted:jwt]");
    expect(
      auditPreviewV1("shell", "computer_exec", {
        command: "export OPENAI_API_KEY=sk-abcdefghijklmnopqrst",
      }),
    ).toContain("[redacted:");
  });

  test("never carries env or a credential reference, whatever the input", () => {
    // Structural, not filtered: the preview is built from a per-kind
    // allowlist, so `env` is absent because it was never reachable.
    const preview = auditPreviewV1("shell", "computer_exec", {
      command: "printenv",
      env: { OPENAI_API_KEY: "sk-abcdefghijklmnopqrst" },
      credentialRef: "sprites:user:alice",
    });
    expect(preview).toBe("printenv");
    expect(preview).not.toContain("credentialRef");
    expect(preview).not.toContain("sprites:user:alice");
  });

  test("shows a browser action and its url, and an MCP call's shape only", () => {
    expect(
      auditPreviewV1("browser", "computer_browser", {
        action: "navigate",
        url: "https://example.test/login",
      }),
    ).toBe("navigate https://example.test/login");
    // A remote server's arguments are somebody else's schema; the preview
    // names the keys and never their values.
    expect(
      auditPreviewV1("mcp", "mcp__example__echo", {
        message: "Bearer abcdefghijklmnopqrstuvwx",
        chatId: 42,
      }),
    ).toBe("mcp__example__echo (chatId, message)");
  });

  test("is bounded and deterministic", () => {
    const input = { command: "x".repeat(5_000) };
    const once = auditPreviewV1("shell", "computer_exec", input);
    expect(once.length).toBe(AUDIT_MAX_PREVIEW_LENGTH_V1);
    expect(auditPreviewV1("shell", "computer_exec", input)).toBe(once);
    // Falls back to the tool name rather than an empty cell.
    expect(auditPreviewV1("shell", "computer_exec", {})).toBe("computer_exec");
    expect(auditPreviewV1("file", "memory_write", null)).toBe("memory_write");
  });
});

describe("the argument digest", () => {
  test("is a stable sha-256 of the exact argument JSON", async () => {
    const digest = await auditArgumentDigestV1({ command: "ls -la" });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await auditArgumentDigestV1({ command: "ls -la" })).toBe(digest);
    // The same bytes SHA-256 answers for `{"command":"ls -la"}`.
    expect(digest).toBe(
      "1df8bccaec747dc615b50678f35bf5b51756a45f9b2b77b247c7a617fde58b3e",
    );
  });

  test("distinguishes two different calls, and is total", async () => {
    const left = await auditArgumentDigestV1({ command: "ls" });
    const right = await auditArgumentDigestV1({ command: "ls " });
    expect(left).not.toBe(right);
    expect(await auditArgumentDigestV1(undefined)).toBe(
      await auditArgumentDigestV1(null),
    );
  });
});

describe("secrets a preview must not carry", () => {
  test("redacts an env-var assignment whose keyword sits behind an underscore", () => {
    // `_` is a word character, so the old `\bsecret\b` anchor did not match
    // inside `AWS_SECRET_ACCESS_KEY` and these landed verbatim in a durable
    // table a person reads — the exact shape a leased credential takes in a
    // `computer_exec` command.
    for (const command of [
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY aws s3 ls",
      "GITHUB_TOKEN=abcdefghijklmnopqrst gh pr list",
      "MYSQL_PASSWORD=hunter2hunter2 mysql -u root",
    ]) {
      const preview = auditPreviewV1("shell", "computer_exec", { command });
      expect(preview).toContain("[redacted:credential-assignment]");
      expect(preview).not.toContain("wJalrXUtnFEMIK");
      expect(preview).not.toContain("abcdefghijklmnopqrst");
      expect(preview).not.toContain("hunter2hunter2");
    }
  });

  test("redacts credentials carried in a URL", () => {
    const withUser = auditPreviewV1("browser", "computer_browser", {
      action: "open",
      url: "https://alice:s3cr3tpass@internal.example.com/reports",
    });
    expect(withUser).toContain("[redacted:url-credentials]");
    expect(withUser).not.toContain("s3cr3tpass");

    for (const [url, secret] of [
      ["https://example.com/cb?token=abcdefghijklmnop", "abcdefghijklmnop"],
      ["https://example.com/cb?code=4%2F0AeanS0abcdefgh", "AeanS0abcdefgh"],
      ["https://example.com/f.zip?sig=aGVsbG93b3JsZA", "aGVsbG93b3JsZA"],
    ] as const) {
      const preview = auditPreviewV1("browser", "computer_browser", {
        action: "open",
        url,
      });
      // Which shape catches it does not matter; that it never reaches the
      // durable table does.
      expect(preview).toMatch(/\[redacted:/);
      expect(preview).not.toContain(secret);
    }
  });

  test("never previews the body of a memory or skill write", () => {
    const preview = auditPreviewV1("file", "memory_write", {
      path: "by-agent/scout/profile.md",
      text: "Tim's home address is 12 Somewhere Street and his PIN is 4021.",
    });
    // The audit row says where something was written. What was written is the
    // Workspace's business and the digest's.
    expect(preview).toBe("by-agent/scout/profile.md");
    expect(preview).not.toContain("Somewhere Street");
  });
});
