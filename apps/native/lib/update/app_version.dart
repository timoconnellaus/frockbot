/// What this running program is, said once at the foot of the Profile page.
library;

/// The version tag this Dart was built from, without its `v`, from
/// `--dart-define=FROCKBOT_RELEASE=…`: the number on the GitHub release.
///
/// The tag is the app's one version. `release.yml` passes it to every build it
/// ships, and an Android patch carries its own tag, so it always names the code
/// that is running. Any other build carries none and says so instead of
/// claiming a version it was never given.
const compiledRelease = String.fromEnvironment('FROCKBOT_RELEASE');

class AppVersion {
  /// The version tag this program was built from, or empty outside a release.
  final String release;

  /// The Shorebird patch the engine booted, when it booted one. A release
  /// running its own Dart, the web app and the desktop app have none.
  final int? patch;

  const AppVersion({this.release = compiledRelease, this.patch});

  /// One line for a person: `Version 0.7.163 · patch 3`.
  String get label {
    final base = release.isEmpty ? 'Development build' : 'Version $release';
    return patch == null ? base : '$base · patch $patch';
  }
}
