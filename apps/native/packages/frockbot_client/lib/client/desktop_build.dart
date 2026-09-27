/// Whether this is the local "FrockBot Dev" Mac build.
///
/// `scripts/native-desktop-update.py` builds the Mac app under its own
/// identity (`com.frockbot.mobile.dev`) so it can sit beside the released app,
/// which updates itself, without macOS opening one in place of the other. The
/// two must not answer each other's browser returns either, so the dev build
/// comes back through its own pages and its own scheme.
const desktopDevelopmentBuild = bool.fromEnvironment('FROCKBOT_DESKTOP_DEV');

/// The Mac app's custom scheme, matching `FROCKBOT_URL_SCHEME` in
/// `macos/Runner/Configs/AppInfo.xcconfig`.
const macosSchemeV1 = desktopDevelopmentBuild ? 'frockbot-dev' : 'frockbot';

/// The segment naming this Mac build's hosted return pages, under
/// `/native/return/` and `/api/connect/callback/`.
const macosReturnSegmentV1 = desktopDevelopmentBuild ? 'macos-dev' : 'macos';
