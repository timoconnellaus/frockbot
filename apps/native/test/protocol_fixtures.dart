// Run from the repo root: dart apps/native/test/protocol_fixtures.dart
import 'dart:convert';
import 'dart:io';

import '../lib/protocol/client_wire.generated.dart';

void main() {
  final valid = jsonDecode(
    File('packages/protocol-schemas/fixtures/valid.json').readAsStringSync(),
  ) as List;
  Map<String, dynamic> fixture(String name) =>
      valid.firstWhere((row) => row['schema'] == name)['value']
          as Map<String, dynamic>;
  final turnJson = fixture('TurnCommand');
  final turn = TurnCommand.fromJson(turnJson);
  if (turn.schemaVersion != 1 ||
      turn.commandId.value != turnJson['commandId'] ||
      turn.text != turnJson['text'])
    throw StateError('Typed Turn fields changed the wire values');
  final helloJson = fixture('ClientHello');
  final hello = ClientHello.fromJson(helloJson);
  if (hello.nativeVersion != helloJson['nativeVersion'] ||
      hello.protocolVersion != helloJson['protocolVersion'])
    throw StateError('Typed compatibility fields changed the wire values');
  try {
    hello.catalogs.clear();
    throw StateError('Catalog collection was mutable');
  } on UnsupportedError {
    /* Collections cannot mutate a decoded DTO. */
  }
  final authJson = fixture('AuthIdentity');
  final auth = AuthIdentity.fromJson(authJson);
  authJson['userId'] = 'changed-after-decode';
  if (auth.userId.value == authJson['userId'])
    throw StateError('DTO retained mutable caller state');
  var count = 0;
  for (final validity in ['valid', 'invalid']) {
    final rows = jsonDecode(
      File('packages/protocol-schemas/fixtures/$validity.json')
          .readAsStringSync(),
    ) as List;
    for (final row in rows) {
      final actual = isProtocolValue(row['schema'] as String, row['value']);
      if (actual != (validity == 'valid'))
        throw StateError('$validity fixture failed: ${row['name']}');
      if (actual &&
          jsonEncode(decodeProtocol(row['schema'] as String, row['value'])) !=
              jsonEncode(row['value']))
        throw StateError('Round trip changed ${row['name']}');
      count++;
    }
  }
  print('$count shared Dart protocol fixtures passed');
}
