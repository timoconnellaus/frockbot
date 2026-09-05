import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/extensions/fallback.dart';

Map<String, Object?> fixture() {
  final hash = List.filled(64, 'a').join();
  return {
    'schemaVersion': 1,
    'appletId': 'user.counter',
    'userId': 'user-1',
    'generationId': '2026-09-05T00:52:26.826Z:e0e3ce78fabf9eca',
    'navigationEpoch': 'navigation_epoch_1234',
    'bootstrapUrl':
        'https://ui.bot.frockbot.com/native-fallback?artifact=$hash&epoch=navigation_epoch_1234',
    'artifactOrigin': artifactOrigin,
    'artifact': {
      'contentHash': hash,
      'size': 123,
      'mediaType': 'text/html',
      'bundlerVersion': '1',
    },
    'viewer': {
      'token': List.filled(64, 't').join(),
      'expiresAt': DateTime.fromMillisecondsSinceEpoch(
        DateTime.now().millisecondsSinceEpoch,
        isUtc: true,
      ).add(const Duration(minutes: 2)).toUtc().toIso8601String(),
      'socketUrl': 'wss://bot.frockbot.com/api/applets/user.counter/socket',
    },
  };
}

void main() {
  FallbackLease decode(Map<String, Object?> input) =>
      FallbackLease(input, 'user-1', 'user.counter', 'navigation_epoch_1234');
  test(
    'viewer is bound to exact User, Applet, origin and navigation epoch',
    () {
      final lease = decode(fixture());
      expect(lease.allows(lease.bootstrap.toString(), true), isTrue);
      expect(lease.allows(lease.artifactUrl, false), isTrue);
      expect(lease.allows(lease.artifactUrl, true), isFalse);
      expect(lease.allows('https://bot.frockbot.com', true), isFalse);
      expect(lease.init['tokenTransport'], 'subprotocol-v1');
      expect(lease.bootstrap.queryParameters.containsKey('token'), isFalse);
      for (final mutation in [
        {'userId': 'other-user'},
        {'appletId': 'other.counter'},
        {'navigationEpoch': 'another_epoch_1234'},
        {'artifactOrigin': 'https://evil.test'},
        {'bootstrapUrl': '${lease.bootstrap}&unexpected=true'},
        {
          'viewer': {
            ...fixture()['viewer'] as Map,
            'expiresAt': DateTime.fromMillisecondsSinceEpoch(
              DateTime.now().millisecondsSinceEpoch,
              isUtc: true,
            ).subtract(const Duration(seconds: 1)).toUtc().toIso8601String(),
          },
        },
        {
          'viewer': {
            ...fixture()['viewer'] as Map,
            'socketUrl': 'wss://evil.test/socket',
          },
        },
      ]) {
        expect(
          () => decode({...fixture(), ...mutation}),
          throwsFormatException,
        );
      }
    },
  );
}
