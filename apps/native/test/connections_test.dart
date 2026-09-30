import 'package:flutter/foundation.dart'
    show TargetPlatform, debugDefaultTargetPlatformOverride;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/connections/document.dart';
import 'package:frockbot_client/connections/door.dart';

/// The `ConnectionsFrame` the server produces, written by hand so the Flutter
/// side is pinned to the frame's contract rather than to whatever the server
/// happens to emit today: one keyed model provider, one hosted-grant app.
Map<String, Object?> connectionsFrame({
  int revision = 1,
  List<Map<String, Object?>> accounts = const [],
  bool mayConnect = true,
  int connected = 0,
  bool twoApps = false,
}) => {
  'schemaVersion': 1,
  'ownerId': 'tim',
  'revision': revision,
  'accounts': [
    for (final account in accounts)
      {
        'id': account['id'],
        'label': account['label'],
        'state': account['state'] ?? 'ready',
        'packageId': account['packageId'] ?? 'provider-ollama-cloud',
        'connectionTypeId':
            account['connectionTypeId'] ?? 'ollama-cloud-account',
        'kind': account['kind'] ?? 'model',
        'authorization': account['authorization'] ?? 'api-key',
        if (account['detail'] != null) 'detail': account['detail'],
        if (account['failure'] != null) 'failure': account['failure'],
      },
  ],
  'providers': [
    {
      'packageId': 'provider-ollama-cloud',
      'connectionTypeId': 'ollama-cloud-account',
      'displayName': 'Ollama Cloud',
      'kind': 'model',
      'authorization': 'api-key',
      'connected': connected,
      'mayConnect': mayConnect,
      'installed': true,
      'settings': [
        {
          'id': 'api-base-url',
          'label': 'API base URL',
          'kind': 'text',
          'value': null,
          'editable': true,
        },
      ],
    },
    {
      'packageId': 'connect',
      'connectionTypeId': 'connect-gmail',
      'displayName': 'Gmail',
      'kind': 'connector',
      'authorization': 'grant',
      'connected': connected,
      'mayConnect': true,
      'installed': true,
      'description': 'Read, search, label and send email in a Gmail account.',
      'icon': 'gmail',
    },
    if (twoApps)
      {
        'packageId': 'connect',
        'connectionTypeId': 'connect-slack',
        'displayName': 'Slack',
        'kind': 'connector',
        'authorization': 'grant',
        'connected': 0,
        'mayConnect': true,
        'installed': true,
        'description': 'Read and post messages in Slack.',
        'icon': 'slack',
      },
  ],
};

void main() {
  test('each app names its own return page, and a browser tab none', () {
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    for (final (platform, client) in [
      (TargetPlatform.android, 'android'),
      (TargetPlatform.macOS, 'macos'),
      (TargetPlatform.iOS, 'ios'),
      (TargetPlatform.linux, null),
    ]) {
      debugDefaultTargetPlatformOverride = platform;
      expect(connectReturnClientV1, client, reason: platform.name);
    }
  });

  test('a return link is one of this app\'s return pages, and nothing else', () {
    for (final link in [
      'frockbot://bot.frockbot.com/api/connect/callback/android?status=success',
      // An Android development identity hands over on its own scheme.
      'frockbot-dev://bot.frockbot.com/api/connect/callback/android',
      'frockbot://bots.example.org/api/connect/callback/android',
      'frockbot://bot.frockbot.com/api/connect/callback/macos',
      'frockbot://bot.frockbot.com/api/connect/callback/ios',
    ]) {
      expect(isConnectReturnV1(Uri.parse(link)), isTrue, reason: link);
    }
    for (final link in [
      // The browser-tab page: it never opens the app.
      'https://bot.frockbot.com/api/connect/callback?status=success',
      // Each client's page only on the scheme that page hands over on, and
      // naming the server it came from.
      'https://bot.frockbot.com/api/connect/callback/android',
      'frockbot:///api/connect/callback/android',
      'https://bot.frockbot.com/api/connect/callback/macos',
      // The FrockBot Dev builds' pages belong to those apps alone.
      'frockbot-dev://bot.frockbot.com/api/connect/callback/macos-dev',
      'frockbot://bot.frockbot.com/api/connect/callback/macos-dev',
      'frockbot-dev://bot.frockbot.com/api/connect/callback/ios-dev',
      'frockbot://bot.frockbot.com/api/connect/callback/ios-dev',
      // The iPhone's page is handed over on its scheme, never claimed.
      'https://bot.frockbot.com/api/connect/callback/ios',
      // Anything else under the callback path.
      'frockbot://bot.frockbot.com/api/connect/callback/windows',
      'https://bot.frockbot.com/api/connect/callback/android/extra',
      'https://bot.frockbot.com/native/return/android?code=1&state=2',
      'https://bot.frockbot.com/?bot=primary',
      'https://bot.frockbot.com/api/connect/callbacks',
      'http://bot.frockbot.com/api/connect/callback/android',
    ]) {
      expect(isConnectReturnV1(Uri.parse(link)), isFalse, reason: link);
    }
  });

  group('an MCP server sign-in', () {
    test('a return link carrying a server\'s answer is sent back to finish', () {
      final completion = mcpSignInCompletionV1(
        Uri.parse(
          'https://bot.frockbot.com/api/connect/callback/android'
          '?mcp_state=s.1&mcp_code=c%2B1&mcp_iss=https%3A%2F%2Fauth.example'
          '&connectedAccountId=ca_1',
        ),
      )!;
      expect(completion.path, '/api/mcp/oauth/complete');
      expect(completion.body, {
        'schemaVersion': 1,
        'state': 's.1',
        'code': 'c+1',
        'iss': 'https://auth.example',
      });
      expect(
        mcpSignInCompletionV1(
          Uri.parse(
            'frockbot://bot.frockbot.com/api/connect/callback/macos'
            '?mcp_state=s.1&mcp_error=access_denied',
          ),
        )!.body,
        {'schemaVersion': 1, 'state': 's.1', 'error': 'access_denied'},
      );
      // A connected app's own return carries none, and finishes nothing.
      for (final link in [
        'https://bot.frockbot.com/api/connect/callback/android?status=success',
        'https://bot.frockbot.com/api/connect/callback/android?mcp_state=',
      ]) {
        expect(mcpSignInCompletionV1(Uri.parse(link)), isNull, reason: link);
      }
      expect(mcpSignInRefusalV1(403), contains('another FrockBot account'));
      expect(mcpSignInRefusalV1(400), contains('Sign in to the server again'));
    });

    test('is the server\'s own door', () {
      expect(
        mcpSignInRequestV1({
          'commandId': 'c1',
          'input': {
            'kind': 'sign-in',
            'connectionId': 'conn/1',
            'returnClient': 'android',
          },
        }).path,
        '/api/plugins/mcp/connections/conn%2F1/authorize',
      );
      expect(
        mcpSignInRequestV1({
          'commandId': 'c1',
          'input': {'kind': 'sign-in', 'connectionId': 'conn-1'},
        }).body,
        {
          'schemaVersion': 1,
          'type': 'connection/start',
          'commandId': 'c1',
          'connectionTypeId': 'mcp-server',
        },
      );
    });
  });
}
