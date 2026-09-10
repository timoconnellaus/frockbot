import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart';

void main() {
  for (final validity in ['valid', 'invalid']) {
    final fixtures = jsonDecode(
      File('../../core/protocol-schemas/fixtures/$validity.json')
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

  test('a settings select carries the full bounded time-zone catalog', () {
    Map<String, Object?> field(int count) => {
      'id': 'timezone',
      'label': 'Time zone',
      'kind': 'select',
      'value': 'UTC',
      'editable': true,
      'choices': [
        for (var i = 0; i < count; i++)
          {'label': 'Zone $i', 'value': 'Area/Zone_$i'},
      ],
    };

    expect(isProtocolValue('SettingField', field(445)), isTrue);
    expect(isProtocolValue('SettingField', field(601)), isFalse);
  });
}
