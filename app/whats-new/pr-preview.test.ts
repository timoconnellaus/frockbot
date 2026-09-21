import { describe, expect, test } from "bun:test";
import { whatsNewPullRequestCommentV1 } from "./pr-preview.ts";

describe("What’s New pull-request preview", () => {
  test("the comment embeds the still from this branch’s commit", () => {
    const body = whatsNewPullRequestCommentV1(
      "timoconnellaus/frockbot",
      "abc123",
    );
    expect(body).toContain("<!-- whats-new-preview -->");
    expect(body).toContain("What’s New in the app");
    expect(body).toContain(
      "https://github.com/timoconnellaus/frockbot/raw/abc123/app/whats-new/media/whats-new.webp",
    );
  });
});
