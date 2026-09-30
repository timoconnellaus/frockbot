/// The requests behind a hosted sign-in: an app's, which Setup and a Card's
/// `ConnectApp` open through the app, and an MCP server's; and the links a
/// sign-in comes back to the app on.
library;

import 'package:flutter/foundation.dart' show ValueNotifier;

import '../brand.dart';
import '../client/desktop_build.dart';
import '../client/ios_build.dart';

/// One request: where it goes, and what it carries.
class ConnectionRequestV1 {
  final String path;
  final Map<String, Object?> body;
  const ConnectionRequestV1(this.path, this.body);
}

Map<String, Object?> _input(Map<String, Object?> command) =>
    ((command['input'] as Map?) ?? const {}).cast<String, Object?>();

String _string(Map<String, Object?> input, String key) {
  final value = input[key];
  if (value is! String || value.isEmpty) {
    throw FormatException('This action names no $key.');
  }
  return value;
}

/// The Package a remote MCP server is added under.
const mcpPackageIdV1 = 'mcp';

/// The one Connection Type an MCP server is.
const mcpConnectionTypeIdV1 = 'mcp-server';

/// The sign-in to an MCP server already added: the server's own door, which
/// answers the address of its authorization server's sign-in, as a hosted
/// grant's door does. `returnClient` is as for [startConnectionRequestV1].
ConnectionRequestV1 mcpSignInRequestV1(Map<String, Object?> command) {
  final input = _input(command);
  final connectionId = Uri.encodeComponent(_string(input, 'connectionId'));
  final returnClient = input['returnClient'];
  return ConnectionRequestV1(
    '/api/plugins/$mcpPackageIdV1/connections/$connectionId/authorize',
    {
      'schemaVersion': 1,
      'type': 'connection/start',
      'commandId': command['commandId'],
      'connectionTypeId': mcpConnectionTypeIdV1,
      if (returnClient is String) 'returnClient': returnClient,
    },
  );
}

/// The `connection/start` command that opens a provider's hosted door.
///
/// `returnClient` names which return page this app can come back through
/// once the door closes: `android` for the verified link, `macos` or `ios`
/// (`macos-dev` or `ios-dev` from a FrockBot Dev build) for the app's scheme.
/// A browser tab names none and is told to return by hand.
ConnectionRequestV1 startConnectionRequestV1(Map<String, Object?> command) {
  final input = _input(command);
  final packageId = _string(input, 'packageId');
  final returnClient = input['returnClient'];
  return ConnectionRequestV1(
    '/api/plugins/${Uri.encodeComponent(packageId)}/connections',
    {
      'schemaVersion': 1,
      'type': 'connection/start',
      'commandId': command['commandId'],
      'connectionTypeId': _string(input, 'connectionTypeId'),
      if (returnClient is String) 'returnClient': returnClient,
    },
  );
}

/// The path a hosted door sends the person back to, under this app's own
/// segment; the page there is what the browser keeps once the app has opened.
const connectReturnPathV1 = '/api/connect/callback';

/// Whether a link the app was opened with is a hosted door closing. There
/// are exactly three such links: the verified App Link under this app's own
/// segment on Android, and the same page handed over on the app's scheme on
/// a Mac or an iPhone. The next settings read is what settles the Connection;
/// the one thing read from a link is an MCP server's sign-in answer, which
/// [mcpSignInCompletionV1] sends back.
///
/// The Mac and iPhone apps share a scheme, so each link is its scheme and its
/// segment together, never the scheme alone.
bool isConnectReturnV1(Uri uri) =>
    (uri.scheme == 'https' && uri.path == '$connectReturnPathV1/android') ||
    (uri.scheme == macosSchemeV1 &&
        uri.path == '$connectReturnPathV1/$macosReturnSegmentV1') ||
    (uri.scheme == iosSchemeV1 &&
        uri.path == '$connectReturnPathV1/$iosReturnSegmentV1');

/// Bumped each time a hosted door closes into the app, so the page that
/// opened it reads its frame again without waiting on a lifecycle resume.
final connectReturns = ValueNotifier<int>(0);

/// Why the door that last closed connected nothing, when the reason is not
/// on any Connection this account holds; set before [connectReturns] moves.
final connectReturnNotice = ValueNotifier<String?>(null);

/// Where the app finishes an MCP server's sign-in, under its own session.
const mcpSignInCompletePathV1 = '/api/mcp/oauth/complete';

/// The request that finishes the MCP server sign-in a return [uri] carries,
/// or `null` when it carries none — any connected app's return. The browser
/// that came back holds no session, so the server trades the code only for
/// this app's, and only when it is the account that started the sign-in.
ConnectionRequestV1? mcpSignInCompletionV1(Uri uri) {
  final query = uri.queryParameters;
  final state = query['mcp_state'];
  if (state == null || state.isEmpty) return null;
  return ConnectionRequestV1(mcpSignInCompletePathV1, {
    'schemaVersion': 1,
    'state': state,
    for (final name in const ['code', 'iss', 'error'])
      name: ?query['mcp_$name'],
  });
}

/// What the person reads when the server refused to finish a sign-in.
String mcpSignInRefusalV1(int? status) => status == 403
    ? 'That sign-in was started from another ${clientBrand.productName} account, so nothing was connected.'
    : 'That sign-in couldn’t finish. Sign in to the server again.';
