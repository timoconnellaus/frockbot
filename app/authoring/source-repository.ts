import {
  PLUGIN_BUILD_LIMITS,
  type PluginBuildSourceFileV1,
} from "@frockbot/applets/build-contract";
import type {
  WorkspaceFilesV1,
  WorkspacePathV1,
  WorkspaceRootV1,
  WorkspaceWriterV1,
} from "@frockbot/core/contracts";

export interface AuthoringSourceFileV1 {
  path: string;
  size: number;
}

export interface AuthoringSourcePolicyV1 {
  /** Used in failures a Bot or operator acts on. */
  artifactName: string;
  root: WorkspaceRootV1;
  /** A validated directory prefix with a trailing slash. */
  sourcePath(artifactId: string): string;
  /** A validated path to one file inside the artifact directory. */
  sourceFilePath(artifactId: string, path: string): WorkspacePathV1;
  sourceMediaType(path: string): string;
  emptySourceFailure(artifactId: string): string;
  /** How stored bytes become source text; Plugins reject malformed UTF-8. */
  textDecoder: TextDecoder;
}

export interface AuthoringSourceRepositoryV1 {
  list(
    artifactId: string,
  ): Promise<{ entries: AuthoringSourceFileV1[] } | { failure: string }>;
  read(artifactId: string, path: string): Promise<string>;
  write(
    artifactId: string,
    path: string,
    text: string,
    writer: WorkspaceWriterV1,
  ): Promise<void>;
  readBuildSource(
    artifactId: string,
  ): Promise<{ files: PluginBuildSourceFileV1[] } | { failure: string }>;
}

/**
 * Source persistence for Bot-authored Plugins.
 *
 * This stops at the build boundary. What is built, hashed, stored, approved
 * and activated is the Plugin host's policy and remains there.
 */
export function createAuthoringSourceRepositoryV1(
  workspace: WorkspaceFilesV1,
  policy: AuthoringSourcePolicyV1,
): AuthoringSourceRepositoryV1 {
  const encoder = new TextEncoder();

  async function list(
    artifactId: string,
  ): Promise<{ entries: AuthoringSourceFileV1[] } | { failure: string }> {
    const prefix = policy.sourcePath(artifactId);
    const listed = await workspace.list({
      root: policy.root,
      // Workspace prefixes are relative paths and may not end in a slash.
      prefix: prefix.slice(0, -1),
      limit: PLUGIN_BUILD_LIMITS.files + 1,
    });
    if (listed.status !== "ok") {
      return {
        failure: `the ${policy.artifactName}'s source could not be listed: ${listed.status}${
          listed.reason ? ` — ${listed.reason}` : ""
        }`,
      };
    }
    return {
      // The explicit slash keeps `notes/` separate from `notes-2/` even though
      // the Workspace list itself accepts only the slashless prefix.
      entries: listed.entries
        .filter((entry) => entry.path.path.startsWith(prefix))
        .map((entry) => ({
          path: entry.path.path.slice(prefix.length),
          size: entry.generation.size,
        }))
        .filter((entry) => entry.path.length > 0)
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  async function readOutcome(
    artifactId: string,
    path: string,
  ): Promise<{ text: string } | { failure: string }> {
    const outcome = await workspace.read(
      policy.sourceFilePath(artifactId, path),
    );
    if (outcome.status !== "ok") {
      return { failure: `"${path}" is ${outcome.status}` };
    }
    return { text: policy.textDecoder.decode(outcome.file.bytes) };
  }

  async function read(artifactId: string, path: string): Promise<string> {
    const outcome = await readOutcome(artifactId, path);
    if ("failure" in outcome) throw new Error(outcome.failure);
    return outcome.text;
  }

  return {
    list,
    read,

    async write(artifactId, path, text, writer) {
      const sourcePath = policy.sourceFilePath(artifactId, path);
      const existing = await workspace.stat(sourcePath);
      const outcome = await workspace.write({
        path: sourcePath,
        bytes: encoder.encode(text),
        writer,
        expectedGenerationId:
          existing.status === "ok"
            ? existing.entry.generation.generationId
            : null,
        mediaType: policy.sourceMediaType(path),
      });
      if (outcome.status !== "ok") {
        throw new Error(
          `"${path}" could not be written: ${outcome.status}${
            outcome.reason ? ` — ${outcome.reason}` : ""
          }`,
        );
      }
    },

    async readBuildSource(artifactId) {
      const listed = await list(artifactId);
      if ("failure" in listed) return listed;
      if (listed.entries.length === 0) {
        return { failure: policy.emptySourceFailure(artifactId) };
      }
      if (listed.entries.length > PLUGIN_BUILD_LIMITS.files) {
        return {
          failure: `${artifactId} has more than ${PLUGIN_BUILD_LIMITS.files} source files; the build service takes no more.`,
        };
      }
      const files: PluginBuildSourceFileV1[] = [];
      let total = 0;
      for (const entry of listed.entries) {
        const source = await readOutcome(artifactId, entry.path);
        if ("failure" in source) return source;
        const { text } = source;
        total += text.length;
        if (
          text.length > PLUGIN_BUILD_LIMITS.fileText ||
          total > PLUGIN_BUILD_LIMITS.sourceBytes
        ) {
          return {
            failure: `${artifactId}'s source is over the ${PLUGIN_BUILD_LIMITS.sourceBytes}-byte ceiling the build service accepts.`,
          };
        }
        files.push({ path: entry.path, text });
      }
      return { files };
    },
  };
}
