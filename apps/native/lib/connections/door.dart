/// An app's hosted sign-in, or an MCP server's, opened in the system browser.
///
/// Three things open one: Connect on a Marketplace or Connectors row, the
/// Connect button on a Card's `ConnectApp`, and Sign in on an MCP server.
/// They open it the same way, from here, so a door a Bot put in the thread is
/// exactly the door the person would have found in Settings.
library;

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;
import 'package:url_launcher/url_launcher.dart';

import '../client/desktop_build.dart';
import '../client/ios_build.dart';
import '../client/transport.dart';
import 'document.dart';

/// Which return page this app can come back through once a hosted door
/// closes: the verified link on Android, the app's scheme on a Mac or an
/// iPhone. A browser tab, and any other platform, is told to return by hand.
String? get connectReturnClientV1 {
  if (kIsWeb) return null;
  return switch (defaultTargetPlatform) {
    TargetPlatform.android => 'android',
    TargetPlatform.macOS => macosReturnSegmentV1,
    TargetPlatform.iOS => iosReturnSegmentV1,
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
}) => _openDoor(
  api,
  startConnectionRequestV1(_returningHere(command)),
  openBrowser,
);

/// Starts the sign-in to an MCP server a `sign-in` [command] names, and sends
/// the person to its authorization server in the system browser, checked the
/// same way.
Future<bool> openMcpSignInV1(
  NativeApi api,
  Map<String, Object?> command, {
  Future<bool> Function(Uri)? openBrowser,
}) => _openDoor(api, mcpSignInRequestV1(_returningHere(command)), openBrowser);

Map<String, Object?> _returningHere(Map<String, Object?> command) {
  final client = connectReturnClientV1;
  return client == null
      ? command
      : {
          ...command,
          'input': {
            ...((command['input'] as Map?) ?? const {}).cast<String, Object?>(),
            'returnClient': client,
          },
        };
}

Future<bool> _openDoor(
  NativeApi api,
  ConnectionRequestV1 request,
  Future<bool> Function(Uri)? openBrowser,
) async {
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
