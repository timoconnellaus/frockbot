import type { FrockBotDesktopAPI } from "@frockbot/protocol";

declare global {
  interface Window {
    frockbot: FrockBotDesktopAPI;
  }
}
