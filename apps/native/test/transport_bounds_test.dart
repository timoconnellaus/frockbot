import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;

/// `a.b.c` ordering, the same comparison the deployment gates on.
bool atLeast(String version, String minimum) {
  final parts = version.split('.').map(int.parse).toList();
  final floor = minimum.split('.').map(int.parse).toList();
  for (var index = 0; index < 3; index++) {
    if (parts[index] != floor[index]) return parts[index] > floor[index];
  }
  return true;
}

void main() {
  test('this build announces a version its own deployment still serves', () {
    // The 426 "Update the app" gate reads exactly this hello. A wire change
    // that raises the minimum without raising the app's own version ships a
    // build the deployment refuses on every request.
    final hello = wire.ClientHello.fromJson(clientHello);
    expect((hello.toJson() as Map)['nativeVersion'], wire.nativeAppVersion);
    expect(
      atLeast(
        (hello.toJson() as Map)['nativeVersion'] as String,
        wire.minimumNativeVersion,
      ),
      isTrue,
    );
  });

  test(
    'a newer build keeps its identity when the deployment floor advances',
    () {
      // Release 1.7 while 1.6 remains the grace-period floor, then enforce 1.7.
      // The already-updated client must still identify as 1.7 at both stages.
      final hello = wire.ClientHello.fromJson(clientHelloForVersion('1.7.0'));
      final nativeVersion = (hello.toJson() as Map)['nativeVersion'] as String;
      expect(atLeast(nativeVersion, '1.6.0'), isTrue);
      expect(atLeast(nativeVersion, '1.7.0'), isTrue);
      expect(nativeVersion, '1.7.0');
    },
  );

  test('JSON transport bounds depth before decoding, including escaped strings and UTF-8', () {
    final sixteen =
        '${List.filled(16, '[').join()}0${List.filled(16, ']').join()}';
    expect(decodeBoundedJson(sixteen), isA<List>());
    expect(() => decodeBoundedJson('[$sixteen]'), throwsFormatException);
    expect(decodeBoundedJson(r'{"text":"[\"{"}'), {'text': '["{'});
    expect(() => decodeBoundedJson('"日"', maxBytes: 4), throwsFormatException);
    expect(() => decodeBoundedJson('}'), throwsFormatException);
  });
}
