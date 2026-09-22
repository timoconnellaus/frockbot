/// The connect chime is the original recording, with the silent tail cut.
library;

import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('connect.wav is the original confirm, without the silent tail', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    final data = await rootBundle.load('assets/voice/connect.wav');
    final bytes = data.buffer.asUint8List(
      data.offsetInBytes,
      data.lengthInBytes,
    );
    expect(String.fromCharCodes(bytes.sublist(0, 4)), 'RIFF');
    final view = ByteData.sublistView(bytes);
    int? channels;
    int? rate;
    var offset = 12;
    while (offset + 8 <= bytes.length) {
      final id = String.fromCharCodes(bytes.sublist(offset, offset + 4));
      final size = view.getUint32(offset + 4, Endian.little);
      if (id == 'fmt ') {
        channels = view.getUint16(offset + 10, Endian.little);
        rate = view.getUint32(offset + 12, Endian.little);
      }
      if (id == 'data') {
        expect(channels, 2);
        expect(rate, 44100);
        expect(size / 4 / rate!, inInclusiveRange(0.4, 0.55));
        return;
      }
      offset += 8 + size + (size.isOdd ? 1 : 0);
    }
    fail('wav has no data chunk');
  });
}
