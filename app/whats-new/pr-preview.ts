/**
 * Posts a sticky pull-request comment that shows every What’s New still.
 *
 * GitHub renders the files in the diff, but the conversation is where a
 * reviewer actually looks. This comment uses the pull request head so the
 * picture is the one the branch is shipping.
 */
import { WHATS_NEW_ENTRIES_V1 } from "./entries.ts";

const MARKER_V1 = "<!-- whats-new-preview -->";

export function whatsNewPullRequestCommentV1(
  repository: string,
  sha: string,
): string {
  const blocks = [
    MARKER_V1,
    "## What’s New preview",
    "",
    "Stills and copy this pull request ships. The same list is `PREVIEW.md`.",
    "",
  ];
  for (const entry of WHATS_NEW_ENTRIES_V1) {
    blocks.push(`### ${entry.title}`, "", entry.summary, "");
    if (entry.image) {
      const url = `https://github.com/${repository}/raw/${sha}/app/whats-new/media/${entry.image.file}`;
      blocks.push(`![${entry.image.alt}](${url})`, "");
    }
  }
  return `${blocks.join("\n")}\n`;
}

async function existingCommentId(
  repository: string,
  pr: string,
): Promise<string | undefined> {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/issues/${pr}/comments?per_page=100`,
    {
      headers: {
        authorization: `Bearer ${process.env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`listing comments failed: ${response.status}`);
  }
  const comments = (await response.json()) as { id: number; body?: string }[];
  const found = comments.find((comment) => comment.body?.includes(MARKER_V1));
  return found === undefined ? undefined : String(found.id);
}

async function main(): Promise<void> {
  const repository = process.env.GH_REPO;
  const sha = process.env.SHA;
  const pr = process.env.PR;
  const token = process.env.GH_TOKEN;
  if (!repository || !sha || !pr || !token) {
    throw new Error("GH_REPO, SHA, PR and GH_TOKEN are required");
  }
  const body = whatsNewPullRequestCommentV1(repository, sha);
  const existing = await existingCommentId(repository, pr);
  const url = existing
    ? `https://api.github.com/repos/${repository}/issues/comments/${existing}`
    : `https://api.github.com/repos/${repository}/issues/${pr}/comments`;
  const response = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    throw new Error(
      `preview comment failed: ${response.status} ${await response.text()}`,
    );
  }
}

if (import.meta.main) {
  await main();
}
