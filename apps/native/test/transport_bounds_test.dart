import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/update/app_version.dart';

void main() {
  test('this build speaks a protocol its own deployment serves', () {
    // The 426 "Update the app" gate reads exactly this hello. A wire change
    // that raises `protocolMin` without raising what the client speaks ships a
    // build the deployment refuses on every request.
    final hello = wire.ClientHello.fromJson(clientHello);
    expect(hello.protocolVersion, wire.clientProtocolVersion);
    expect(
      hello.protocolVersion,
      greaterThanOrEqualTo(wire.supportedProtocolMin),
    );
    expect(hello.protocolVersion, lessThanOrEqualTo(wire.supportedProtocolMax));
    expect(
      hello.nativeVersion,
      compiledRelease.isEmpty ? null : compiledRelease,
    );
  });

  test('a release names its tag, and a development build names none', () {
    final release = wire.ClientHello.fromJson(clientHelloForRelease('0.7.163'));
    expect(release.nativeVersion, '0.7.163');
    final prerelease = wire.ClientHello.fromJson(
      clientHelloForRelease('0.8.0-rc.1'),
    );
    expect(prerelease.nativeVersion, '0.8.0-rc.1');
    final development = wire.ClientHello.fromJson(clientHelloForRelease(''));
    expect(development.nativeVersion, isNull);
  });

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
