/// What a server is, read before anyone signs in to it.
///
/// A person adds a server by typing its address. The app reads the server's
/// public `/.well-known/frockbot.json`, shows which server it is about to sign
/// in to, and says plainly when that server is too old for this app or needs
/// a newer one. The document is read loosely: a field this build does not
/// know is ignored, so a newer server stays addable.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../brand.dart';
import '../protocol/client_wire.generated.dart' as wire;
import 'transport.dart';

const serverDiscoveryPathV1 = '/.well-known/frockbot.json';

/// A server this app can sign in to.
class ServerDiscovery {
  final String origin;

  /// The product the server says it is.
  final String name;

  /// The release the server was deployed from, where it said.
  final String? version;
  const ServerDiscovery({
    required this.origin,
    required this.name,
    this.version,
  });

  String get host => Uri.parse(origin).host;
}

/// Why a server cannot be added, in a sentence for the person.
class ServerRefused implements Exception {
  final String message;
  const ServerRefused(this.message);
  @override
  String toString() => message;
}

/// The origin an address names, or null for one that names none.
///
/// A bare host is taken as HTTPS, and whatever path was pasted with it is
/// dropped: a server is its origin. Plain HTTP is refused except for the
/// local stack a development build talks to.
String? serverOriginV1(String address) {
  final trimmed = address.trim();
  if (trimmed.isEmpty || trimmed.contains(RegExp(r'\s'))) return null;
  final Uri uri;
  try {
    uri = Uri.parse(trimmed.contains('://') ? trimmed : 'https://$trimmed');
  } on FormatException {
    return null;
  }
  if (uri.host.isEmpty || uri.userInfo.isNotEmpty) return null;
  final host = uri.host.toLowerCase();
  if (uri.scheme == 'http') {
    if (!localDevelopment && !developmentOrigin(host)) return null;
  } else if (uri.scheme != 'https') {
    return null;
  }
  if (!host.contains('.') && host != 'localhost') return null;
  return Uri(
    scheme: uri.scheme,
    host: host,
    port: uri.hasPort ? uri.port : null,
  ).origin;
}

/// The loopback addresses a development build's local stack answers on.
bool developmentOrigin(String host) =>
    const {'127.0.0.1', '10.0.2.2', 'localhost'}.contains(host);

/// Reads what the server at [address] is, or throws [ServerRefused] saying
/// why this app cannot sign in to it.
Future<ServerDiscovery> discoverServerV1(
  String address, {
  http.Client? client,
  int clientProtocol = wire.clientProtocolVersion,
  String? scheme,
}) async {
  final origin = serverOriginV1(address);
  if (origin == null) {
    throw const ServerRefused(
      'Enter the server’s address, like bot.example.com.',
    );
  }
  final host = Uri.parse(origin).host;
  final product = clientBrand.productName;
  final http.Response response;
  final owned = client == null;
  final http.Client using = client ?? http.Client();
  try {
    // No hello and no credential: the document is public, and it is read
    // ahead of the compatibility gate precisely by an app it may not serve.
    response = await using
        .get(Uri.parse('$origin$serverDiscoveryPathV1'))
        .timeout(const Duration(seconds: 15));
  } on Exception {
    throw ServerRefused(
      'Couldn’t reach $host. Check the address and your connection.',
    );
  } finally {
    if (owned) using.close();
  }
  final notAServer = ServerRefused(
    '$host isn’t a $product server, or it runs a version too old to add. '
    'If it is yours, update it and try again.',
  );
  if (response.statusCode != 200 || response.bodyBytes.length > 16384) {
    throw notAServer;
  }
  final Object? body;
  try {
    body = jsonDecode(utf8.decode(response.bodyBytes));
  } on FormatException {
    throw notAServer;
  }
  if (body is! Map || body['schemaVersion'] != 1) throw notAServer;
  final name = body['name'];
  final protocol = body['protocol'];
  final signIn = body['signIn'];
  if (name is! String ||
      name.isEmpty ||
      name.length > 80 ||
      protocol is! Map ||
      protocol['min'] is! int ||
      protocol['max'] is! int ||
      signIn is! Map) {
    throw notAServer;
  }
  final version = body['version'];
  final discovery = ServerDiscovery(
    origin: origin,
    name: name,
    version: version is String && version.length <= 64 ? version : null,
  );
  if ((protocol['max'] as int) < clientProtocol) {
    throw ServerRefused(
      '$host runs an older version of $name that this app no longer '
      'supports. Ask whoever runs it to update it.',
    );
  }
  if ((protocol['min'] as int) > clientProtocol) {
    throw ServerRefused(
      '$host needs a newer version of this app. Update $product, then add '
      'the server again.',
    );
  }
  if (signIn['method'] != 'browser-pkce') {
    throw ServerRefused(
      '$host doesn’t let apps sign in yet. Whoever runs it can turn app '
      'sign-in on.',
    );
  }
  if (signIn['scheme'] != (scheme ?? clientBrand.nativeScheme)) {
    throw ServerRefused('$host is a $name server, which has its own app.');
  }
  return discovery;
}
