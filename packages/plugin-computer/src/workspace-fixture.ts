// Test support: an in-memory `ComputerWorkspace`.
//
// A module under `src` rather than a fixture inside one test file because two
// suites need the same one — the screenshot tool and the background-process
// tools both write through the Workspace, and a fixture per suite would let
// two of them drift from one contract. Deliberately absent from this Package's
// `exports`, and not a `*.test.ts` file, so `bun test` never runs it as one.
import type {
  ComputerWorkspace,
  WorkspaceLayoutV1,
} from "@frockbot/computer-core";
import type {
  WorkspaceEntryV1,
  WorkspaceGenerationV1,
  WorkspacePathV1,
  WorkspaceRootV1,
  WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";

export const FAKE_WORKSPACE_LAYOUT: WorkspaceLayoutV1 = {
  schemaVersion: 1,
  home: "/home/box",
  roots: [
    {
      kind: "package-declared",
      scope: "user",
      mountPath: "/home/box/agent-data/user-packages/{package}/{root}",
      access: "read-write",
    },
  ],
};

/** An in-memory `ComputerWorkspace` that records every write it admitted. */
export class FakeWorkspace implements ComputerWorkspace {
  readonly layout = FAKE_WORKSPACE_LAYOUT;
  readonly files = new Map<
    string,
    { bytes: Uint8Array; generation: WorkspaceGenerationV1 }
  >();
  readonly deleted: string[] = [];
  private sequence = 0;

  private key(path: WorkspacePathV1): string {
    return path.path;
  }

  read(path: WorkspacePathV1) {
    const held = this.files.get(this.key(path));
    return Promise.resolve(
      held
        ? {
            status: "ok" as const,
            file: { path, generation: held.generation, bytes: held.bytes },
          }
        : { status: "not-found" as const, reason: "no such file" },
    );
  }

  stat(path: WorkspacePathV1) {
    const held = this.files.get(this.key(path));
    return Promise.resolve(
      held
        ? {
            status: "ok" as const,
            entry: { path, generation: held.generation },
          }
        : { status: "not-found" as const, reason: "no such file" },
    );
  }

  list(request: { root: WorkspaceRootV1; prefix?: string }) {
    const entries: WorkspaceEntryV1[] = [...this.files.entries()]
      .filter(([path]) => !request.prefix || path.startsWith(request.prefix))
      .map(([path, held]) => ({
        path: { root: request.root, path },
        generation: held.generation,
      }));
    return Promise.resolve({ status: "ok" as const, entries });
  }

  write(request: {
    path: WorkspacePathV1;
    bytes: Uint8Array;
    writer: WorkspaceWriterV1;
  }) {
    this.sequence += 1;
    const generation: WorkspaceGenerationV1 = {
      schemaVersion: 1,
      generationId: `gen-${this.sequence}`,
      // A stand-in digest with the shape the decoders require.
      contentHash: this.sequence.toString(16).padStart(64, "a"),
      size: request.bytes.byteLength,
      writer: request.writer,
      writtenAt: new Date(1_700_000_000_000 + this.sequence).toISOString(),
    };
    this.files.set(this.key(request.path), {
      bytes: request.bytes,
      generation,
    });
    return Promise.resolve({ status: "ok" as const, generation });
  }

  delete(request: { path: WorkspacePathV1 }) {
    const held = this.files.get(this.key(request.path));
    this.deleted.push(request.path.path);
    this.files.delete(this.key(request.path));
    return Promise.resolve(
      held
        ? { status: "ok" as const, generation: held.generation }
        : { status: "not-found" as const, reason: "no such file" },
    );
  }
}
