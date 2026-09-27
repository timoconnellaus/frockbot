/// Whether this is the "FrockBot Dev" iPhone build.
///
/// Like the Mac's (`desktop_build.dart`), a development iPhone build is its
/// own app, `com.frockbot.mobile.dev`, so it installs beside the released one
/// instead of over it — a build without Shorebird's engine installed over the
/// released app would end that install's patches. The two must not answer
/// each other's browser returns either, so the dev build comes back through
/// its own pages and its own scheme. Xcode's half of the switch is
/// `FROCKBOT_IOS_DEV=YES` (`ios/Runner/Configs/AppInfo.xcconfig`).
const iosDevelopmentBuild = bool.fromEnvironment('FROCKBOT_IOS_DEV');

/// The iPhone app's custom scheme, matching `FROCKBOT_URL_SCHEME` in
/// `ios/Runner/Configs/AppInfo.xcconfig`.
const iosSchemeV1 = iosDevelopmentBuild ? 'frockbot-dev' : 'frockbot';

/// The segment naming this iPhone build's hosted return pages, under
/// `/native/return/` and `/api/connect/callback/`.
const iosReturnSegmentV1 = iosDevelopmentBuild ? 'ios-dev' : 'ios';
