// Run from the repo root: dart apps/native/test/protocol_fixtures.dart
import 'dart:convert';
import 'dart:io';
import '../lib/protocol/client_wire.generated.dart';

void main() {
  var count = 0;
  for (final validity in ['valid', 'invalid']) {
    final rows = jsonDecode(File('packages/protocol-schemas/fixtures/$validity.json').readAsStringSync()) as List;
    for (final row in rows) {
      final actual = isProtocolValue(row['schema'] as String, row['value']);
      if (actual != (validity == 'valid')) throw StateError('$validity fixture failed: ${row['name']}');
      if (actual && jsonEncode(decodeProtocol(row['schema'] as String, row['value'])) != jsonEncode(row['value'])) throw StateError('Round trip changed ${row['name']}');
      count++;
    }
  }
  print('$count shared Dart protocol fixtures passed');
}
