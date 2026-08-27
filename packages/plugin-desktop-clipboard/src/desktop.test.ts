import { describe, expect, test } from "bun:test";
import {
  DesktopClipboardCapability,
  DesktopCommandRegistry,
} from "@frockbot/desktop-core";
import {
  createPluginHarness,
  verifyPluginPackage,
} from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import desktopClipboardPlugin, {
  READ_CLIPBOARD_TEXT_COMMAND,
  type ReadClipboardTextResult,
  WRITE_CLIPBOARD_TEXT_COMMAND,
  type WriteClipboardTextResult,
} from "./desktop.js";

class FakeClipboard extends DesktopClipboardCapability {
  text = "initial";

  readText(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    return Promise.resolve(this.text);
  }

  writeText(text: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.text = text;
    return Promise.resolve();
  }
}

async function createHost(): Promise<{
  harness: Awaited<ReturnType<typeof createPluginHarness>>;
  clipboard: FakeClipboard;
}> {
  const harness = await createPluginHarness([
    DesktopCommandRegistry,
    FakeClipboard,
  ]);
  return {
    harness,
    clipboard: harness.root.desktopClipboard as FakeClipboard,
  };
}

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

describe("desktop clipboard plugin", () => {
  test("registers read and write commands over the granted capability", async () => {
    const { harness, clipboard } = await createHost();
    await harness.mount(desktopClipboardPlugin);

    expect(
      await harness.root.desktopCommands.invoke<ReadClipboardTextResult>(
        READ_CLIPBOARD_TEXT_COMMAND,
        {},
      ),
    ).toEqual({ text: "initial" });
    expect(
      await harness.root.desktopCommands.invoke<WriteClipboardTextResult>(
        WRITE_CLIPBOARD_TEXT_COMMAND,
        { text: "updated" },
      ),
    ).toEqual({ written: true });
    expect(clipboard.text).toBe("updated");
    await harness.dispose();
  });

  test("preserves exact clipboard text, including an empty string", async () => {
    const { harness, clipboard } = await createHost();
    await harness.mount(desktopClipboardPlugin);

    await harness.root.desktopCommands.invoke(WRITE_CLIPBOARD_TEXT_COMMAND, {
      text: "",
    });
    expect(clipboard.text).toBe("");
    await harness.dispose();
  });

  test("unregisters both commands on disposal", async () => {
    const { harness } = await createHost();
    const fiber = await harness.mount(desktopClipboardPlugin);

    await fiber.dispose();
    await expectFailure(
      harness.root.desktopCommands.invoke(READ_CLIPBOARD_TEXT_COMMAND, {}),
      "is unavailable",
    );
    await expectFailure(
      harness.root.desktopCommands.invoke(WRITE_CLIPBOARD_TEXT_COMMAND, {
        text: "not written",
      }),
      "is unavailable",
    );
    await harness.dispose();
  });

  test("rejects malformed writes before invoking the capability", async () => {
    const { harness, clipboard } = await createHost();
    await harness.mount(desktopClipboardPlugin);

    await expectFailure(
      harness.root.desktopCommands.invoke(WRITE_CLIPBOARD_TEXT_COMMAND, {
        text: 42,
      }),
      "clipboard text must be a string",
    );
    expect(clipboard.text).toBe("initial");
    await harness.dispose();
  });

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-desktop-clipboard",
      contributionKinds: ["desktop"],
    });
  });
});
