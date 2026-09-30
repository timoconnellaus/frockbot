import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/client/transport.dart';
import 'package:frockbot_client/setup/page.dart';
import 'package:frockbot_client/theme/frock_theme.dart';

import 'native_session.dart' show NativeSessionApi;
import 'widget_test.dart' show MemoryStore;

const minted = 'https://bot.frockbot.com/setup/ai#reader=payload.signature';

/// The frame, as a test sees it: the address it was given, a way to speak as
/// the page, and everything the app said back.
class FakeFrame {
  String? url;
  Future<void> Function(Map<String, Object?>)? say;
  final heard = <Map<String, Object?>>[];

  Widget build(
    String url,
    Future<void> Function(Map<String, Object?>) onMessage,
    Stream<Map<String, Object?>> outbox,
  ) {
    this.url = url;
    say = onMessage;
    outbox.listen(heard.add);
    return const Text('framed');
  }
}

void main() {
  test('the credential is read only out of a minted fragment', () {
    expect(setupReaderOfV1(minted), 'payload.signature');
    expect(setupReaderOfV1('https://bot.frockbot.com/setup'), isNull);
    expect(
      setupReaderOfV1('https://bot.frockbot.com/setup#reader=<script>'),
      isNull,
    );
  });

  test('the page may ask the app to open only an https page', () {
    expect(
      setupOutboundUriV1('https://checkout.stripe.com/c/1')?.host,
      'checkout.stripe.com',
    );
    expect(setupOutboundUriV1('http://checkout.stripe.com/c/1'), isNull);
    expect(setupOutboundUriV1('javascript:alert(1)'), isNull);
    expect(setupOutboundUriV1('https://user:pass@example.com/'), isNull);
    expect(setupOutboundUriV1(42), isNull);
  });

  testWidgets('Setup mints a reader for the page it opens and frames it', (
    tester,
  ) async {
    final requests = <(String, Object?)>[];
    final frame = FakeFrame();
    final api = NativeSessionApi(MemoryStore(), (path, body) async {
      requests.add((path, body));
      return {'schemaVersion': 1, 'url': minted, 'expiresAt': 1};
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: SetupPage(
          api: api,
          page: SetupPageId.ai,
          frameBuilder: frame.build,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(requests.single.$1, '/api/setup/frame');
    expect(requests.single.$2, {'schemaVersion': 1, 'page': 'ai'});
    expect(frame.url, minted);
    expect(find.text('framed'), findsOneWidget);
  });

  testWidgets('an expired reader is replaced when the page asks', (
    tester,
  ) async {
    final frame = FakeFrame();
    var mints = 0;
    final api = NativeSessionApi(MemoryStore(), (path, body) async {
      mints += 1;
      return {
        'schemaVersion': 1,
        'url': 'https://bot.frockbot.com/setup#reader=fresh.$mints',
      };
    });
    await tester.pumpWidget(
      MaterialApp(
        home: SetupPage(api: api, frameBuilder: frame.build),
      ),
    );
    await tester.pumpAndSettle();
    await frame.say!({'frockbotSetup': 1, 'type': 'renew'});
    await tester.pumpAndSettle();
    expect(frame.heard.last, {
      'frockbotSetupHost': 1,
      'type': 'reader',
      'token': 'fresh.2',
    });
  });

  testWidgets(
    'an app’s sign-in is opened by the app, checked, and answered to the page',
    (tester) async {
      final frame = FakeFrame();
      final opened = <Uri>[];
      final api = NativeSessionApi(MemoryStore(), (path, body) async {
        if (path == '/api/setup/frame') {
          return {'schemaVersion': 1, 'url': minted};
        }
        expect(path, '/api/plugins/connect/connections');
        expect((body! as Map)['connectionTypeId'], 'gmail');
        return {'redirectUrl': 'https://connect.example.com/start'};
      });
      await tester.pumpWidget(
        MaterialApp(
          home: SetupPage(
            api: api,
            frameBuilder: frame.build,
            openBrowser: (uri) async {
              opened.add(uri);
              return true;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      await frame.say!({
        'frockbotSetup': 1,
        'type': 'connect',
        'packageId': 'connect',
        'connectionTypeId': 'gmail',
        'commandId': 'c-1',
      });
      await tester.pumpAndSettle();
      expect(opened.single.toString(), 'https://connect.example.com/start');
      expect(frame.heard.last, {
        'frockbotSetupHost': 1,
        'type': 'door',
        'ok': true,
      });
    },
  );

  testWidgets('Done leaves Setup, and a message not from Setup is ignored', (
    tester,
  ) async {
    final frame = FakeFrame();
    var closed = 0;
    final api = NativeSessionApi(
      MemoryStore(),
      (path, body) async => {'schemaVersion': 1, 'url': minted},
    );
    await tester.pumpWidget(
      MaterialApp(
        home: SetupPage(
          api: api,
          frameBuilder: frame.build,
          onClose: () => closed += 1,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await frame.say!({'type': 'close'});
    expect(closed, 0);
    await frame.say!({'frockbotSetup': 1, 'type': 'close'});
    expect(closed, 1);
  });

  testWidgets('a mint that fails says so and offers another try', (
    tester,
  ) async {
    var fail = true;
    final frame = FakeFrame();
    final api = NativeSessionApi(MemoryStore(), (path, body) async {
      if (fail) throw const RequestFailure('offline');
      return {'schemaVersion': 1, 'url': minted};
    });
    await tester.pumpWidget(
      MaterialApp(
        home: SetupPage(api: api, frameBuilder: frame.build),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Setup couldn’t open'), findsOneWidget);
    fail = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(frame.url, minted);
  });
}
