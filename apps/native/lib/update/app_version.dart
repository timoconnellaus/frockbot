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

/// The version tag this Dart was built from, without its `v`, from
/// `--dart-define=FROCKBOT_RELEASE=…`: the number on the GitHub release.
///
/// `pubspec.yaml` names the native build, which moves only when the native
/// client must, because the compatibility gate and Shorebird key on it. Every
/// tag ships Dart, so the tag is what says which code is running. Only
/// `release.yml` passes it.
const compiledRelease = String.fromEnvironment('FROCKBOT_RELEASE');

class AppVersion {
  /// The version tag this program was built from, or empty outside a release.
  final String release;

  /// The native build this program was built as, or empty for a development
  /// build.
  final String build;

  /// The Shorebird patch the engine booted, when it booted one. A release
  /// running its own Dart, the web app and the desktop app have none.
  final int? patch;

  const AppVersion({
    this.release = compiledRelease,
    this.build = compiledAppVersion,
    this.patch,
  });

  /// One line for a person: `Version 0.7.162 · patch 3`.
  String get label {
    final name = release.isNotEmpty ? release : build;
    final base = name.isEmpty ? 'Development build' : 'Version $name';
    return patch == null ? base : '$base · patch $patch';
  }
}
