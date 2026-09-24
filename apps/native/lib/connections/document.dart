/// The Connection command one view action means.
///
/// This is the request vocabulary for the host-drawn Connectors page: the page
/// assembles an action from a `ConnectionsFrame` row, and this turns it back
/// into the command the existing routes already take. Two conventions:
///
/// - Every action's declared input names a `kind` from the closed vocabulary
///   below, because an action id is opaque and the command a press means is
///   not derivable from the label a person reads.
/// - A connect form's field ids are `c<provider>.label`, `c<provider>.key` and
///   `c<provider>.s.<setting>`, so two Packages that named a setting the same
///   thing do not collide and the host knows which part of the create command
///   each answered value is.
///
/// The key is the one value that never travels back: it goes out on the create
/// command and nowhere else.
library;

import 'package:flutter/foundation.dart' show ValueNotifier;

import '../client/desktop_build.dart';

/// The action kinds a Connectors press can mean.
const connectionActionKindsV1 = <String>{
  'connect-api-key',
  'authorize',
  'enable-connection',
  'set-enabled',
  'disconnect',
  'revoke',
  'refresh-models',
};

/// The kind an action names, or nothing when it names none.
String? connectionActionKindV1(Map<String, Object?> command) {
  final kind = ((command['input'] as Map?)?['kind']) as String?;
  return connectionActionKindsV1.contains(kind) ? kind : null;
}

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

/// The connect form's answered values, split back into the create command's
/// parts by the segment convention above.
({String? label, String? apiKey, Map<String, Object?> settings}) _form(
  Map<String, Object?> input,
) {
  String? label;
  String? apiKey;
  final settings = <String, Object?>{};
  for (final entry in input.entries) {
    final split = entry.key.indexOf('.');
    if (split < 1) continue;
    final rest = entry.key.substring(split + 1);
    if (rest == 'label') {
      label = entry.value as String?;
    } else if (rest == 'key') {
      apiKey = entry.value as String?;
    } else if (rest.startsWith('s.')) {
      final value = entry.value;
      // An untouched optional setting is not part of the command: sending an
      // empty string would overwrite the Connection Type's own default.
      if (value == null || value == '') continue;
      settings[rest.substring(2)] = value;
    } else {
      throw const FormatException('This action carries an unknown value.');
    }
  }
  return (label: label, apiKey: apiKey, settings: settings);
}

/// The Connection request one view action becomes, for every kind but
/// `authorize` — which is a hosted door rather than a command, and belongs to
/// the surface that can open a browser.
ConnectionRequestV1 connectionRequestV1(Map<String, Object?> command) {
  final input = _input(command);
  final kind = connectionActionKindV1(command);
  final commandId = command['commandId'];
  switch (kind) {
    case 'connect-api-key':
    case 'enable-connection':
      final form = _form(input);
      final label = form.label ?? (input['label'] as String?);
      if (label == null || label.trim().isEmpty) {
        throw const FormatException('This account still needs a name.');
      }
      final apiKey = form.apiKey;
      if (kind == 'connect-api-key' && (apiKey == null || apiKey.isEmpty)) {
        throw const FormatException('This account still needs a key.');
      }
      return ConnectionRequestV1('/api/connections', {
        'schemaVersion': 1,
        'type': kind == 'connect-api-key'
            ? 'connection/create-api-key'
            : 'connection/create',
        'commandId': commandId,
        'packageId': _string(input, 'packageId'),
        'connectionTypeId': _string(input, 'connectionTypeId'),
        'label': label.trim(),
        if (kind == 'connect-api-key') 'apiKey': apiKey,
        if (form.settings.isNotEmpty) 'settings': form.settings,
      });
    case 'set-enabled':
      return ConnectionRequestV1('/api/connections', {
        'schemaVersion': 1,
        'type': 'connection/set-enabled',
        'commandId': commandId,
        'connectionId': _string(input, 'connectionId'),
        'enabled': input['enabled'] == true,
      });
    case 'disconnect':
      return ConnectionRequestV1('/api/connections', {
        'schemaVersion': 1,
        'type': 'connection/disconnect',
        'commandId': commandId,
        'connectionId': _string(input, 'connectionId'),
        // Removing the account here removes this Bot's use of it. Revoking it
        // upstream is the provider's own surface, not ours to press.
        'revokeUpstream': false,
      });
    case 'refresh-models':
      return ConnectionRequestV1('/api/connections', {
        'schemaVersion': 1,
        'type': 'connection/refresh-models',
        'commandId': commandId,
        'connectionId': _string(input, 'connectionId'),
      });
    case 'revoke':
      final packageId = Uri.encodeComponent(_string(input, 'packageId'));
      final connectionId = Uri.encodeComponent(_string(input, 'connectionId'));
      return ConnectionRequestV1(
        '/api/plugins/$packageId/connections/$connectionId/revoke',
        {'schemaVersion': 1, 'type': 'connection/revoke'},
      );
    default:
      throw const FormatException('This action is not one Connectors takes.');
  }
}

/// The Package a remote MCP server is added under. Its one way in is a form
/// of its own — an address first, a token only when the server asks for one —
/// rather than the key form every other keyed provider draws.
const mcpPackageIdV1 = 'mcp';

/// The Connection setting an MCP server's address travels in.
const mcpUrlSettingV1 = 'url';

/// An MCP server address as a person typed it, or the sentence that says
/// why it is not one. The server holds it to the same rule and says more;
/// this only saves a round trip on the obvious mistakes.
({Uri? uri, String? problem}) mcpServerAddressV1(String typed) {
  final text = typed.trim();
  if (text.isEmpty) {
    return (uri: null, problem: 'Enter the server’s address.');
  }
  final uri = Uri.tryParse(text);
  if (uri == null ||
      uri.scheme != 'https' ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty) {
    return (
      uri: null,
      problem: 'Enter the server’s full https address, like https://mcp.example.com/mcp.',
    );
  }
  return (uri: uri, problem: null);
}

/// The action an MCP server form's answer becomes: a server added with a
/// token is a keyed Connection, one without is a plain one, and both carry
/// the address as the Connection's setting. The name defaults to the host.
Map<String, Object?> mcpServerActionV1({
  required String commandId,
  required int index,
  required String connectionTypeId,
  required Uri address,
  required String name,
  required String token,
}) {
  final prefix = 'c$index';
  final label = name.trim().isEmpty ? address.host : name.trim();
  return {
    'commandId': commandId,
    'input': {
      'kind': token.isEmpty ? 'enable-connection' : 'connect-api-key',
      'packageId': mcpPackageIdV1,
      'connectionTypeId': connectionTypeId,
      '$prefix.label': label.length > 120 ? label.substring(0, 120) : label,
      '$prefix.s.$mcpUrlSettingV1': address.toString(),
      if (token.isNotEmpty) '$prefix.key': token,
    },
  };
}

/// The `connection/start` command that opens a provider's hosted door.
///
/// `returnClient` names which return page this app can come back through
/// once the door closes: `android` for the verified link, `macos` (or
/// `macos-dev` from the local FrockBot Dev build) for the app's scheme. A browser tab names none and is told to return by hand.
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
/// are exactly two such links: the verified App Link under this app's own
/// segment on Android, and the same page handed over on the app's scheme on
/// a Mac. Nothing on the link is read — the next settings read is what
/// settles the Connection.
bool isConnectReturnV1(Uri uri) => switch (uri.scheme) {
  'https' => uri.path == '$connectReturnPathV1/android',
  macosSchemeV1 => uri.path == '$connectReturnPathV1/$macosReturnSegmentV1',
  _ => false,
};

/// Bumped each time a hosted door closes into the app, so the page that
/// opened it reads its frame again without waiting on a lifecycle resume.
final connectReturns = ValueNotifier<int>(0);
