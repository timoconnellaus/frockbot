import { describe, expect, test } from "bun:test";
import {
  MobileCommandRegistry,
  MobileNotificationCapability,
  type MobileNotificationRequest,
} from "@frockbot/mobile-core";
import {
  createPluginHarness,
  verifyPluginPackage,
} from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import mobileNotificationsPlugin, {
  SHOW_NOTIFICATION_COMMAND,
  type ShowNotificationResult,
} from "./mobile.js";

class FakeNotifications extends MobileNotificationCapability {
  requests: MobileNotificationRequest[] = [];

  show(request: MobileNotificationRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.requests.push(request);
    return Promise.resolve();
  }
}

async function createHost(): Promise<{
  harness: Awaited<ReturnType<typeof createPluginHarness>>;
  notifications: FakeNotifications;
}> {
  const harness = await createPluginHarness([
    MobileCommandRegistry,
    FakeNotifications,
  ]);
  return {
    harness,
    notifications: harness.root.mobileNotifications as FakeNotifications,
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

describe("mobile notifications plugin", () => {
  test("registers a command backed by the granted capability", async () => {
    const { harness, notifications } = await createHost();
    await harness.mount(mobileNotificationsPlugin);

    expect(
      await harness.root.mobileCommands.invoke<ShowNotificationResult>(
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
    await harness.dispose();
  });

  test("forwards a critical urgency request", async () => {
    const { harness, notifications } = await createHost();
    await harness.mount(mobileNotificationsPlugin);

    await harness.root.mobileCommands.invoke(SHOW_NOTIFICATION_COMMAND, {
      title: "Blocked",
      urgency: "critical",
    });
    expect(notifications.requests).toEqual([
      { title: "Blocked", body: undefined, urgency: "critical" },
    ]);
    await harness.dispose();
  });

  test("unregisters its command when its fiber is disposed", async () => {
    const { harness } = await createHost();
    const fiber = await harness.mount(mobileNotificationsPlugin);

    await fiber.dispose();

    await expectFailure(
      harness.root.mobileCommands.invoke(SHOW_NOTIFICATION_COMMAND, {
        title: "Not delivered",
      }),
      "is unavailable",
    );
    await harness.dispose();
  });

  test("rejects malformed input before invoking the capability", async () => {
    const { harness, notifications } = await createHost();
    await harness.mount(mobileNotificationsPlugin);

    await expectFailure(
      harness.root.mobileCommands.invoke(SHOW_NOTIFICATION_COMMAND, {
        title: " ",
      }),
      "notification title is required",
    );
    await expectFailure(
      harness.root.mobileCommands.invoke(SHOW_NOTIFICATION_COMMAND, {
        title: "Turn complete",
        urgency: "loud",
      }),
      'notification urgency must be "normal" or "critical"',
    );
    expect(notifications.requests).toEqual([]);
    await harness.dispose();
  });

  test("propagates the caller signal to the capability", async () => {
    const { harness, notifications } = await createHost();
    await harness.mount(mobileNotificationsPlugin);
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));

    await expectFailure(
      harness.root.mobileCommands.invoke(
        SHOW_NOTIFICATION_COMMAND,
        { title: "Turn complete" },
        controller.signal,
      ),
      "cancelled by test",
    );
    expect(notifications.requests).toEqual([]);
    await harness.dispose();
  });

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-mobile-notifications",
      contributionKinds: ["mobile"],
    });
  });
});
