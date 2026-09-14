// Run in a disposable macOS host against the local e2e gateway. The host must
// supply FROCKBOT_ORIGIN, FROCKBOT_DEV_AUTH and an isolated ACCEPTANCE_STATE.
// This entrypoint never opens the installed app's store or platform keystore.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:frockbot_native/client/auth_io.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/plain_store_io.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

class DelayedDirectoryApi extends NativeApi {
  Completer<void>? releaseDirectory;
  bool directoryRequested = false;
  DelayedDirectoryApi(super.store);

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    if (path == '/api/bots' && body == null && releaseDirectory != null) {
      directoryRequested = true;
      await releaseDirectory!.future;
    }
    return super.request(
      path,
      body: body,
      limit: limit,
      authenticated: authenticated,
    );
  }
}

Future<String> signIn(NativeApi api, PlainStore store) async {
  final signIn = NativeSignIn(api, store);
  final verifier = '${randomId()}${randomId()}';
  final state = randomId();
  await store.write('sign-in', jsonEncode({
    'version': 1,
    'verifier': verifier,
    'state': state,
    'returnUri': signIn.returnUri,
    'exchangeId': randomId(),
  }));
  final start = await api.request('/api/auth/native/start', body: {
    'schemaVersion': 1,
    'commandId': randomId(),
    'state': state,
    'codeChallenge': base64Url.encode(sha256.convert(utf8.encode(verifier)).bytes)
        .replaceAll('=', ''),
    'codeChallengeMethod': 'S256',
    'returnUri': signIn.returnUri,
  }, authenticated: false) as Map;
  final client = http.Client();
  try {
    final response = await client.send(http.Request(
      'GET', Uri.parse(start['authorizationUrl'] as String),
    )..followRedirects = false);
    expect(response.statusCode, 302);
    await response.stream.drain<void>();
    expect(await signIn.accept(Uri.parse(response.headers['location']!)), isTrue);
  } finally {
    client.close();
  }
  return (jsonDecode((await store.read('session'))!) as Map)['userId'] as String;
}

Future<void> until(WidgetTester tester, bool Function() ready) async {
  final deadline = DateTime.now().add(const Duration(seconds: 30));
  while (!ready()) {
    if (DateTime.now().isAfter(deadline)) fail('Native shell did not settle');
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final origin = Uri.parse(hostedOrigin);
  final statePath = Platform.environment['ACCEPTANCE_STATE'];
  if (origin.scheme != 'http' || origin.host != '127.0.0.1' ||
      statePath == null || !Directory(statePath).existsSync()) {
    throw StateError('A loopback gateway and disposable state are required');
  }
  binding.allTestsPassed.future.then((passed) => exit(passed ? 0 : 1));

  testWidgets('native sign-in opens General; pending Bot links take precedence', (
    tester,
  ) async {
    Future<PlainStore> newStore(String name) async {
      final store = PlainStore(location: () async => Directory(statePath), name: name);
      await store.load();
      expect(await store.read('session'), isNull);
      return store;
    }

    Future<void> mount(
      DelayedDirectoryApi api,
      PlainStore store,
      BotSessions sessions,
      String userId,
      ValueNotifier<String?> links,
    ) => tester.pumpWidget(MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: AppShell(
        api: api,
        store: store,
        sessions: sessions,
        userId: userId,
        botLinks: links,
        onSignOut: () async {},
      ),
    ));

    final store = await newStore('first-sign-in.json');
    final api = DelayedDirectoryApi(store);
    final userId = await signIn(api, store);
    final directory = await api.request('/api/bots') as Map;
    expect(directory['bots'], hasLength(1));
    final generalId = (await api.request('/api/bots/bootstrap') as Map)['generalBotId'] as String;
    expect((directory['bots'] as List).single['botId'], generalId);
    final sessions = BotSessions(api: api, store: store);
    final links = ValueNotifier<String?>(null);
    await mount(api, store, sessions, userId, links);
    await until(tester, () => find.widgetWithText(AppBar, 'General').evaluate().isNotEmpty);
    expect(await store.read('selection.$userId'), generalId);
    expect(find.byType(BottomSheet), findsNothing);
    final starter = find.byWidgetPredicate((widget) =>
      widget is Semantics && widget.properties.identifier == StarterIds.suggestion('project'));
    await until(tester, () => starter.evaluate().isNotEmpty);
    await tester.tap(starter);
    await tester.pump(const Duration(milliseconds: 300));
    final composer = find.descendant(
      of: find.byWidgetPredicate((widget) => widget is Semantics &&
          widget.properties.identifier == ShellIds.composer),
      matching: find.byType(EditableText),
    );
    expect(composer, findsOneWidget);
    expect(tester.widget<EditableText>(composer).controller.text, isNotEmpty);
    await tester.enterText(composer, 'Plan my garden project');
    expect(tester.widget<EditableText>(composer).controller.text, 'Plan my garden project');
    expect((await api.request('/api/bots/$generalId/turns') as Map)['runs'], isEmpty);
    print('NATIVE_ACCEPTANCE: real native sign-in opened General; starter is an unsent draft');

    final created = await api.request('/api/bots', body: {
      'schemaVersion': 1,
      'type': 'bot/create',
      'commandId': randomId(),
      'expectedRevision': directory['revision'],
      'botId': 'rosemary',
      'name': 'Rosemary',
    }) as Map;
    expect(created['status'], 'applied');
    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    await store.checkpoint();
    api.close();
    links.dispose();

    for (final pendingAtMount in [true, false]) {
      final linkedStore = await newStore('link-$pendingAtMount.json');
      final linkedApi = DelayedDirectoryApi(linkedStore);
      final linkedUser = await signIn(linkedApi, linkedStore);
      expect(linkedUser, userId);
      linkedApi.releaseDirectory = Completer<void>();
      final linkedSessions = BotSessions(api: linkedApi, store: linkedStore);
      final pending = ValueNotifier<String?>(pendingAtMount ? 'rosemary' : null);
      await mount(linkedApi, linkedStore, linkedSessions, linkedUser, pending);
      await until(tester, () => linkedApi.directoryRequested);
      if (!pendingAtMount) pending.value = 'rosemary';
      await tester.pump(const Duration(milliseconds: 300));
      expect(pending.value, 'rosemary');
      expect(await linkedStore.read('selection.$linkedUser'), isNull);
      linkedApi.releaseDirectory!.complete();
      await until(tester, () => find.widgetWithText(AppBar, 'Rosemary').evaluate().isNotEmpty);
      expect(find.widgetWithText(AppBar, 'General'), findsNothing);
      expect(await linkedStore.read('selection.$linkedUser'), 'rosemary');
      expect(pending.value, isNull);
      expect(find.textContaining('That Bot isn’t available'), findsNothing);
      print('NATIVE_ACCEPTANCE: pending link ${pendingAtMount ? 'at mount' : 'during loading'} opened Rosemary before General');
      await tester.pumpWidget(const SizedBox());
      linkedSessions.clear();
      await linkedStore.checkpoint();
      linkedApi.close();
      pending.dispose();
    }
  });
}
