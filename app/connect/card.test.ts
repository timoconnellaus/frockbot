import { describe, expect, test } from "bun:test";
import {
  decodeA2uiAgentMessageV1,
  type A2uiAgentMessageV1,
} from "@frockbot/core/contracts";
import { bindCardConnectAppsV1, CardDecodeError } from "../shell/cards.js";
import { findConnectToolkitV1 } from "./catalog.js";
import { connectCardAppV1 } from "./card.js";

function surface(components: unknown[]): A2uiAgentMessageV1[] {
  return [
    decodeA2uiAgentMessageV1({
      version: "v1.0",
      createSurface: { surfaceId: "offer-gmail", components },
    }),
  ];
}

function components(messages: A2uiAgentMessageV1[]): unknown[] {
  const [first] = messages;
  return first && "createSurface" in first
    ? (first.createSurface.components ?? [])
    : [];
}

describe("finding the app a Bot named", () => {
  test("takes the Marketplace id or the name, however it is spelled", () => {
    for (const named of [
      "googlecalendar",
      "Google Calendar",
      "google_calendar",
      "GOOGLE-CALENDAR",
    ]) {
      const found = findConnectToolkitV1(named);
      expect("toolkit" in found && found.toolkit.slug).toBe("googlecalendar");
    }
  });

  test("names the closest apps, featured first, when none is the one named", () => {
    const found = findConnectToolkitV1("google mail");
    expect("closest" in found).toBe(true);
    if (!("closest" in found)) return;
    expect(found.closest.length).toBeGreaterThan(0);
    expect(found.closest.length).toBeLessThanOrEqual(5);
    expect(found.closest[0]?.slug).toBe("gmail");
  });

  test("names nothing for a blank name", () => {
    expect(findConnectToolkitV1("  -- ")).toEqual({ closest: [] });
  });
});

describe("a ConnectApp on a card", () => {
  test("is bound to the app the catalog says it is", () => {
    const bound = bindCardConnectAppsV1(
      surface([
        { id: "root", component: "Column", children: ["connect"] },
        { id: "connect", component: "ConnectApp", app: "Gmail" },
      ]),
      connectCardAppV1,
    );
    expect(components(bound)[1]).toEqual({
      id: "connect",
      component: "ConnectApp",
      app: "gmail",
      name: "Gmail",
      description: "Read, search, label and send email in a Gmail account.",
      packageId: "connect",
      connectionTypeId: "connect-gmail",
    });
  });

  test("cannot say one app and connect another", () => {
    const bound = bindCardConnectAppsV1(
      surface([
        { id: "root", component: "Column", children: ["connect"] },
        {
          id: "connect",
          component: "ConnectApp",
          app: "slack",
          name: "Gmail",
          description: "Your email.",
          packageId: "connect",
          connectionTypeId: "connect-gmail",
        },
      ]),
      connectCardAppV1,
    );
    expect(components(bound)[1]).toMatchObject({
      app: "slack",
      name: "Slack",
      connectionTypeId: "connect-slack",
    });
  });

  test("is bound in an update as well as a first draw", () => {
    const [bound] = bindCardConnectAppsV1(
      [
        decodeA2uiAgentMessageV1({
          version: "v1.0",
          updateComponents: {
            surfaceId: "offer-gmail",
            components: [
              { id: "connect", component: "ConnectApp", app: "notion" },
            ],
          },
        }),
      ],
      connectCardAppV1,
    );
    expect(
      bound && "updateComponents" in bound
        ? bound.updateComponents.components[0]
        : undefined,
    ).toMatchObject({ name: "Notion", connectionTypeId: "connect-notion" });
  });

  test("refuses an app the Marketplace does not carry, naming the closest", () => {
    expect(() =>
      bindCardConnectAppsV1(
        surface([{ id: "root", component: "ConnectApp", app: "google mail" }]),
        connectCardAppV1,
      ),
    ).toThrow(
      new CardDecodeError(
        `no app "google mail" is in the Marketplace; the closest are Gmail ("gmail"), ` +
          `Google Calendar ("googlecalendar"), Google Drive ("googledrive"), ` +
          `Google Sheets ("googlesheets"), Google Docs ("googledocs")`,
      ),
    );
    expect(() =>
      bindCardConnectAppsV1(
        surface([{ id: "root", component: "ConnectApp", app: "zzqqxx" }]),
        connectCardAppV1,
      ),
    ).toThrow(new CardDecodeError(`no app "zzqqxx" is in the Marketplace`));
  });

  test("refuses one that names no app", () => {
    expect(() =>
      bindCardConnectAppsV1(
        surface([
          { id: "root", component: "ConnectApp", app: { path: "/app" } },
        ]),
        connectCardAppV1,
      ),
    ).toThrow(new CardDecodeError(`ConnectApp "root" must name an app`));
  });

  test("leaves every other component as it was written", () => {
    const messages = surface([
      { id: "root", component: "Text", text: "Hello" },
    ]);
    expect(bindCardConnectAppsV1(messages, connectCardAppV1)).toEqual(messages);
  });
});
