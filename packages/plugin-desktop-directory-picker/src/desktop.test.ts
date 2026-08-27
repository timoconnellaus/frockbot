import { afterEach, describe, expect, test } from "bun:test";
import {
  DesktopCommandRegistry,
  DesktopDirectoryPickerCapability,
  type DesktopDirectoryPickerRequest,
  type DesktopDirectoryPickerResult,
} from "@frockbot/desktop-core";
import { Context } from "cordis";
import {
  desktopDirectoryPickerPlugin,
  PICK_DIRECTORY_COMMAND,
} from "./desktop.js";

class FakeDirectoryPicker extends DesktopDirectoryPickerCapability {
  requests: DesktopDirectoryPickerRequest[] = [];
  result: DesktopDirectoryPickerResult = {
    paths: ["/tmp/frockbot"],
    cancelled: false,
  };

  pick(
    request: DesktopDirectoryPickerRequest,
    signal: AbortSignal,
  ): Promise<DesktopDirectoryPickerResult> {
    signal.throwIfAborted();
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

const roots: Context[] = [];

async function createHost(): Promise<{
  root: Context;
  picker: FakeDirectoryPicker;
}> {
  const root = new Context();
  roots.push(root);
  await root.plugin(DesktopCommandRegistry);
  await root.plugin(FakeDirectoryPicker);
  return {
    root,
    picker: root.desktopDirectoryPicker as FakeDirectoryPicker,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

async function expectFailure(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : "").toContain(message);
}

describe("desktop directory picker plugin", () => {
  test("registers a directory command backed by the granted capability", async () => {
    const { root, picker } = await createHost();
    await root.plugin(desktopDirectoryPickerPlugin);

    expect(
      await root.desktopCommands.invoke<DesktopDirectoryPickerResult>(
        PICK_DIRECTORY_COMMAND,
        { title: " Choose a workspace ", multiple: true },
      ),
    ).toEqual({ paths: ["/tmp/frockbot"], cancelled: false });
    expect(picker.requests).toEqual([
      {
        mode: "directory",
        title: "Choose a workspace",
        multiple: true,
      },
    ]);
  });

  test("preserves cancellation as an ordinary capability result", async () => {
    const { root, picker } = await createHost();
    picker.result = { paths: [], cancelled: true };
    await root.plugin(desktopDirectoryPickerPlugin);

    expect(
      await root.desktopCommands.invoke<DesktopDirectoryPickerResult>(
        PICK_DIRECTORY_COMMAND,
        {},
      ),
    ).toEqual({ paths: [], cancelled: true });
  });

  test("unregisters its command on disposal", async () => {
    const { root } = await createHost();
    const fiber = await root.plugin(desktopDirectoryPickerPlugin);

    await fiber.dispose();

    await expectFailure(
      root.desktopCommands.invoke(PICK_DIRECTORY_COMMAND, {}),
      "is unavailable",
    );
  });

  test("rejects malformed input before invoking the capability", async () => {
    const { root, picker } = await createHost();
    await root.plugin(desktopDirectoryPickerPlugin);

    await expectFailure(
      root.desktopCommands.invoke(PICK_DIRECTORY_COMMAND, {
        multiple: "yes",
      }),
      "directory picker multiple must be a boolean",
    );
    expect(picker.requests).toEqual([]);
  });
});
