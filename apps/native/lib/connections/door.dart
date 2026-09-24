/// An app's hosted sign-in, opened in the system browser.
///
/// Two things open one: Connect on a Marketplace or Connectors row, and the
/// Connect button on a Card's `ConnectApp`. They open it the same way, from
/// here, so a door a Bot put in the thread is exactly the door the person
/// would have found in Settings.
library;

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;
import 'package:url_launcher/url_launcher.dart';

import '../client/desktop_build.dart';
import '../client/transport.dart';
import 'document.dart';

/// Which return page this app can come back through once a hosted door
/// closes: the verified link on Android, the app's scheme on a Mac. A browser
/// tab, and any other platform, is told to return by hand.
String? get connectReturnClientV1 {
  if (kIsWeb) return null;
  return switch (defaultTargetPlatform) {
    TargetPlatform.android => 'android',
    TargetPlatform.macOS => macosReturnSegmentV1,
    _ => null,
  };
}

/// Starts a hosted grant for an `authorize` [command] and sends the person to
/// it in the system browser. The destination is checked before it is opened,
/// so a tampered answer cannot send them somewhere else wearing our name.
///
/// Answers `false` when the Connection was ready without a door to open, and
/// `true` once the browser has it. A refusal is a [FormatException] carrying
/// the sentence to show.
Future<bool> openConnectionDoorV1(
  NativeApi api,
  Map<String, Object?> command, {
  Future<bool> Function(Uri)? openBrowser,
}) async {
  final client = connectReturnClientV1;
  final request = startConnectionRequestV1(
    client == null
        ? command
        : {
            ...command,
            'input': {
              ...((command['input'] as Map?) ?? const {})
                  .cast<String, Object?>(),
              'returnClient': client,
            },
          },
  );
  final answer =
      ((await api.request(request.path, body: request.body) as Map?) ??
              const {})
          .cast<String, Object?>();
  if (answer['status'] == 'ready') return false;
  final url = answer['redirectUrl'];
  if (url is! String) throw const FormatException('No authorization door');
  final uri = Uri.parse(url);
  if (uri.scheme != 'https' || uri.host.isEmpty || uri.userInfo.isNotEmpty) {
    throw const FormatException('Invalid authorization destination');
  }
  final opened =
      await (openBrowser?.call(uri) ??
          launchUrl(uri, mode: LaunchMode.externalApplication));
  if (!opened) throw const FormatException('Browser unavailable');
  return true;
}
