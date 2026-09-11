import type { PackageDefinitionV1 } from "@frockbot/core/contracts";
import {
  CONNECT_PACKAGE_ID,
  CONNECT_TOOLKITS_V1,
  connectCapabilityIdV1,
  connectConnectionTypeIdV1,
} from "./catalog.js";

/**
 * One Package, one Connection Type per app. Each type is its own Connectors
 * row, so "Gmail" and "Slack" sit beside a model provider's accounts as peers
 * with nothing above them. Every type is a hosted grant: the person is sent to
 * the app's own sign-in and comes back; no key is ever typed.
 */
export const connectDefinitionV1: PackageDefinitionV1 = {
  id: CONNECT_PACKAGE_ID,
  displayName: "Connected apps",
  capabilities: CONNECT_TOOLKITS_V1.map((toolkit) => ({
    id: connectCapabilityIdV1(toolkit.slug),
    kind: "tool" as const,
    connectionTypes: [connectConnectionTypeIdV1(toolkit.slug)],
    admission: {
      turnTypes: ["chat", "automation", "subagent"] as const,
      subagentRoles: ["executor"],
    },
  })),
  connectionTypes: CONNECT_TOOLKITS_V1.map((toolkit) => ({
    id: connectConnectionTypeIdV1(toolkit.slug),
    displayName: toolkit.name,
    allowMultiple: true,
    authorization: { kind: "grant" as const, driverId: CONNECT_PACKAGE_ID },
    capabilities: [connectCapabilityIdV1(toolkit.slug)],
  })),
  dependencies: ["settings"],
};
