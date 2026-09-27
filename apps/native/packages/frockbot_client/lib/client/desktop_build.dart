import '../brand.dart';

/// Whether this is the local development Mac build.
///
/// `scripts/native-desktop-update.py` builds the Mac app under its own
/// identity (`com.frockbot.mobile.dev`) so it can sit beside the released app,
/// which updates itself, without macOS opening one in place of the other. The
/// two must not answer each other's browser returns either, so the dev build
/// comes back through its own pages and its own scheme.
const desktopDevelopmentBuild = bool.fromEnvironment('FROCKBOT_DESKTOP_DEV');

/// The Mac app's custom scheme: the brand's, which the application's
/// `macos/Runner/Configs/AppInfo.xcconfig` registers as `FROCKBOT_URL_SCHEME`.
String get macosSchemeV1 => desktopDevelopmentBuild
    ? '${clientBrand.nativeScheme}-dev'
    : clientBrand.nativeScheme;

/// The segment naming this Mac build's hosted return pages, under
/// `/native/return/` and `/api/connect/callback/`.
const macosReturnSegmentV1 = desktopDevelopmentBuild ? 'macos-dev' : 'macos';
