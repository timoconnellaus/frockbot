import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart';

void main() {
  for (final validity in ['valid', 'invalid']) {
    final fixtures = jsonDecode(
      File('../../packages/protocol-schemas/fixtures/$validity.json')
          .readAsStringSync(),
    ) as List;
    for (final f in fixtures) {
      test('$validity: ${f['name']}', () {
        expect(
          isProtocolValue(f['schema'] as String, f['value']),
          validity == 'valid',
        );
        if (validity == 'valid') {
          expect(decodeProtocol(f['schema'] as String, f['value']), f['value']);
        }
      });
    }
  }
}
