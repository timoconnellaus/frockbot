import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:frockbot_native/client/transport.dart';

class MemoryStore implements LocalStore {
  @override
  Future<String?> read(String key) async => null;
  @override
  Future<void> write(String key, String value) async {}
  @override
  Future<void> delete(String key) async {}
}

void main() {
  test(
    'development identity is confined to the fixed local build target',
    () async {
      final api = NativeApi(MemoryStore());
      addTearDown(api.close);
      final headers = await api.headers();
      expect(headers['authorization'], isNull);
      expect(
        headers['x-frockbot-user-id'],
        localDevelopment ? 'development' : isNull,
      );
      // The client names no deployment of its own: a build that passes neither
      // switch has no origin to talk to, and says so rather than guessing one.
      const configured = String.fromEnvironment('FROCKBOT_ORIGIN');
      if (localDevelopment) {
        expect(hostedOrigin, 'http://127.0.0.1:8787');
      } else if (configured.isNotEmpty) {
        expect(hostedOrigin, configured);
      } else {
        expect(() => hostedOrigin, throwsStateError);
      }
    },
  );

  test(
    'local HTTP and state channel use the same development identity',
    () async {
      if (!localDevelopment) return;
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 8787);
      addTearDown(() => server.close(force: true));
      final seen = <String>[];
      server.listen((request) async {
        expect(request.headers.value('x-frockbot-user-id'), 'development');
        expect(request.headers.value('x-frockbot-client'), isNotNull);
        seen.add(request.uri.path);
        if (WebSocketTransformer.isUpgradeRequest(request)) {
          final socket = await WebSocketTransformer.upgrade(request);
          await socket.close();
        } else {
          request.response.write('{"ok":true}');
          await request.response.close();
        }
      });
      final api = NativeApi(MemoryStore());
      addTearDown(api.close);
      expect(await api.request('/api/identity'), {'ok': true});
      final socket = await api.socket('example', null);
      await socket.sink.close();
      expect(seen, ['/api/identity', '/api/bots/example/state-channel']);
    },
  );
}
