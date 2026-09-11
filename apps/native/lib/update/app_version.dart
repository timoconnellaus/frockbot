/// What this running program is, said once at the foot of the Profile page.
library;

/// `<name>+<code>` as the build carried it, from
/// `--dart-define=FROCKBOT_APP_VERSION=…`.
///
/// The Shorebird release and patch commands in `scripts/native-update.py`,
/// the macOS build in `scripts/native-desktop-update.py` and the web build in
/// `apps/cloudflare/build-flutter-web.ts` all pass it from `pubspec.yaml`, so
/// no second copy of the version lives in Dart. A plain `flutter run` carries
/// nothing and says so instead of claiming a version it was never given.
const compiledAppVersion = String.fromEnvironment('FROCKBOT_APP_VERSION');

class AppVersion {
  /// The release this program was built as, or empty for a development build.
  final String build;

  /// The Shorebird patch the engine booted, when it booted one. A release
  /// running its own Dart, the web app and the desktop app have none.
  final int? patch;

  const AppVersion({this.build = compiledAppVersion, this.patch});

  /// One line for a person: `Version 1.2.0+17 · patch 3`.
  String get label {
    final base = build.isEmpty ? 'Development build' : 'Version $build';
    return patch == null ? base : '$base · patch $patch';
  }
}
