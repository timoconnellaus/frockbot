/// The close reason the server logs, cut to fit the wire.
///
/// A WebSocket close reason may be at most 123 bytes, and the reason is the
/// one record of which path on this device ended the call — so an oversized
/// reason that the platform refuses would cost exactly the diagnostic the
/// telemetry exists to produce.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/socket.dart';

void main() {
  group('voiceCloseReasonV1', () {
    test('a reason within the limit is sent as written', () {
      const reason = 'lifecycle:paused';
      expect(voiceCloseReasonV1(reason), reason);
      expect(voiceCloseReasonV1(''), '');
      expect(voiceCloseReasonV1('a' * 120), 'a' * 120);
    });

    test('a long reason of multibyte characters still fits the wire', () {
      for (final character in ['é', '☃', '😀']) {
        for (var pad = 0; pad < 5; pad++) {
          final reason = 'a' * pad + character * 60;
          final cut = voiceCloseReasonV1(reason);
          expect(
            utf8.encode(cut).length,
            lessThanOrEqualTo(120),
            reason: 'over the wire limit for $character with $pad leading',
          );
          expect(
            reason.startsWith(cut),
            isTrue,
            reason: 'not a prefix for $character with $pad leading',
          );
          expect(
            utf8.decode(utf8.encode(cut)),
            cut,
            reason: 'not valid utf-8 for $character with $pad leading',
          );
          expect(cut.contains('�'), isFalse);
        }
      }
    });

    test('a long ascii reason keeps as much as fits', () {
      final cut = voiceCloseReasonV1('a' * 300);
      expect(cut, 'a' * 120);
    });
  });
}
