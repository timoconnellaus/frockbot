import { afterEach, describe, expect, test } from "bun:test";
import {
  DesktopCommandRegistry,
  DesktopNotificationCapability,
  type DesktopNotificationRequest,
} from "@frockbot/desktop-core";
import { Context } from "cordis";
import {
  desktopNotificationsPlugin,
  SHOW_NOTIFICATION_COMMAND,
  type ShowNotificationResult,
} from "./desktop.js";

class FakeNotifications extends DesktopNotificationCapability {
  requests: DesktopNotificationRequest[] = [];

  show(
    request: DesktopNotificationRequest,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.requests.push(request);
    return Promise.resolve();
  }
}

const roots: Context[] = [];

async function createHost(): Promise<{
  root: Context;
  notifications: FakeNotifications;
}> {
  const root = new Context();
  roots.push(root);
  await root.plugin(DesktopCommandRegistry);
  await root.plugin(FakeNotifications);
  return {
    root,
    notifications: root.desktopNotifications as FakeNotifications,
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

describe("desktop notifications plugin", () => {
  test("registers a command backed by the granted capability", async () => {
    const { root, notifications } = await createHost();
    await root.plugin(desktopNotificationsPlugin);

    expect(
      await root.desktopCommands.invoke<ShowNotificationResult>(
        SHOW_NOTIFICATION_COMMAND,
        { title: " Turn complete ", body: " FrockBot is idle " },
      ),
    ).toEqual({ shown: true });
    expect(notifications.requests).toEqual([
      {
        title: "Turn complete",
        body: "FrockBot is idle",
        urgency: "normal",
      },
    ]);
  });

  test("unregisters its command when its fiber is disposed", async () => {
    const { root } = await createHost();
    const fiber = await root.plugin(desktopNotificationsPlugin);

    await fiber.dispose();

    await expectFailure(
      root.desktopCommands.invoke(SHOW_NOTIFICATION_COMMAND, {
        title: "Not delivered",
      }),
      "is unavailable",
    );
  });

  test("rejects malformed input before invoking the capability", async () => {
    const { root, notifications } = await createHost();
    await root.plugin(desktopNotificationsPlugin);

    await expectFailure(
      root.desktopCommands.invoke(SHOW_NOTIFICATION_COMMAND, { title: " " }),
      "notification title is required",
    );
    expect(notifications.requests).toEqual([]);
  });
});
