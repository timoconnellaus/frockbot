import clockHostPlugin from "@frockbot/plugin-clock/host";
import clipboardPlugin from "@frockbot/plugin-desktop-clipboard/desktop";
import directoryPickerPlugin from "@frockbot/plugin-desktop-directory-picker/desktop";
import notificationsPlugin from "@frockbot/plugin-desktop-notifications/desktop";
import flySpriteHostPlugin from "@frockbot/plugin-fly-sprite/host";

// Only statically bundled, reviewed contributions may execute in Electron main.
// Downloaded desktop contributions remain inert until the sandbox host exists.
export const foundationTrustedDesktopPlugins = [
  clockHostPlugin,
  notificationsPlugin,
  directoryPickerPlugin,
  clipboardPlugin,
  flySpriteHostPlugin,
] as const;
