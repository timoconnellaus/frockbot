import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/app.dart';
import 'package:frockbot_client/brand.dart';
import 'package:frockbot_client/client/accounts.dart';
import 'package:frockbot_client/client/discovery.dart';
import 'package:frockbot_client/client/plain_store.dart';
import 'package:frockbot_client/client/transport.dart';
import 'package:frockbot_client/shell/semantics.dart';
import 'package:frockbot_native/brand.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'app_auth_recovery_test.dart' show answer, withoutDeepLinks;
import 'navigation_test.dart' show identifiedBy;
import 'widget_test.dart' show MemoryStore;

/// A store that deletes by prefix, as the app's own does.
class AccountsMemoryStore extends MemoryStore implements AccountsStore {
  @override
  Future<void> deletePrefix(String prefix) async =>
      values.removeWhere((key, _) => key.startsWith(prefix));

  @override
  Future<void> deleteUnscoped(Set<String> keep) async => values.removeWhere(
    (key, _) => !key.startsWith(accountKeyPrefixV1) && !keep.contains(key),
  );
}

/// One account's server: its own User and its own Bots.
class AccountApi extends NativeApi {
  final String userId;
  final List<Map<String, Object?>> bots;
  final int unread;
  final List<String> paths;
  AccountApi(
    super.store, {
    required super.origin,
    required this.userId,
    required this.bots,
    required this.paths,
    this.unread = 0,
    this.rejected = false,
  });

  /// Whether the server has stopped accepting this account's session.
  final bool rejected;

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    paths.add('${Uri.parse(origin).host}$path');
    if (rejected) throw const RequestFailure('Please sign in again.', 401);
    if (path == '/api/identity') {
      return {'schemaVersion': 1, 'userId': userId, 'isAdmin': false};
    }
    if (path == '/api/bots') {
      return {'schemaVersion': 1, 'revision': 1, 'bots': bots};
    }
    if (path == '/api/bots/lifecycles') {
      return {'schemaVersion': 1, 'lifecycles': const []};
    }
    if (path == '/api/bots/unread') {
      return {
        'schemaVersion': 1,
        'unread': [
          for (final bot in bots)
            {
              'schemaVersion': 1,
              'botId': bot['botId'],
              'count': unread,
              'capped': false,
              'unread': unread > 0,
              'manuallyUnread': false,
              'notificationsEnabled': true,
            },
        ],
      };
    }
    if (path == '/api/auth/native/revoke') {
      return {'schemaVersion': 1, 'status': 'signed-out'};
    }
    throw const FormatException('offline fixture');
  }

  @override
  Future<WebSocketChannel> socket(
    String botId, {
    String? cursor,
    String? epoch,
  }) async => throw const FormatException('offline fixture');
}

String session(String userId) => jsonEncode({
  'schemaVersion': 1,
  'sessionId': 'session-$userId',
  'userId': userId,
  'expiresAt': '2036-09-05T00:00:00.000Z',
  'sessionToken': 'token-$userId',
});

Map<String, Object?> registration(String botId, String name) => {
  'schemaVersion': 1,
  'botId': botId,
  'registeredAt': '2026-09-05T00:00:00.000Z',
  'initialName': name,
  'avatar': {'schemaVersion': 1, 'characterId': 'pixel', 'primary': '#fc85ae'},
};

http.Response json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

Map<String, Object?> discovery({
  int min = 2,
  int max = 4,
  String method = 'browser-pkce',
  String scheme = 'frockbot',
}) => {
  'schemaVersion': 1,
  'name': 'FrockBot',
  'protocol': {'min': min, 'max': max},
  'signIn': {'method': method, 'scheme': scheme},
  'version': 'v1.2.3',
  'somethingNewer': true,
};

void main() {
  setUp(() => installClientBrand(frockbotBrand));

  group('a server address', () {
    test('is its HTTPS origin', () {
      expect(serverOriginV1('bots.example.org'), 'https://bots.example.org');
      expect(
        serverOriginV1(' https://Bots.Example.org/some/page?x=1 '),
        'https://bots.example.org',
      );
      expect(
        serverOriginV1('bots.example.org:8443'),
        'https://bots.example.org:8443',
      );
    });

    test('names nothing else', () {
      for (final address in [
        '',
        'bots',
        'http://bots.example.org',
        'ftp://bots.example.org',
        'someone@bots.example.org',
        'bots example.org',
      ]) {
        expect(serverOriginV1(address), isNull, reason: address);
      }
    });
  });

  group('reading a server', () {
    Future<Object> read(
      http.Response Function(http.Request) answer, {
      int clientProtocol = 4,
    }) async {
      try {
        return await discoverServerV1(
          'bots.example.org',
          clientProtocol: clientProtocol,
          client: MockClient((request) async {
            expect(request.url.path, '/.well-known/frockbot.json');
            expect(request.headers.containsKey('authorization'), isFalse);
            expect(request.headers.containsKey('x-frockbot-client'), isFalse);
            return answer(request);
          }),
        );
      } on ServerRefused catch (refused) {
        return refused.message;
      }
    }

    test('says which server it is, ignoring what it does not know', () async {
      final found = await read((_) => json(discovery())) as ServerDiscovery;
      expect(found.origin, 'https://bots.example.org');
      expect(found.name, 'FrockBot');
      expect(found.version, 'v1.2.3');
    });

    test('says plainly when the server is too old', () async {
      expect(
        await read((_) => json(discovery(max: 3))),
        contains('runs an older version'),
      );
      // A server from before the discovery file.
      expect(
        await read((_) => http.Response('Not found', 404)),
        contains('too old to add'),
      );
    });

    test('says plainly when the app is too old', () async {
      expect(
        await read((_) => json(discovery(min: 5))),
        contains('needs a newer version of this app'),
      );
    });

    test('refuses a server the app cannot sign in to', () async {
      expect(
        await read((_) => json(discovery(method: 'unavailable'))),
        contains('doesn’t let apps sign in'),
      );
      expect(
        await read((_) => json(discovery(scheme: 'walletpal'))),
        contains('has its own app'),
      );
      expect(
        await read((_) => http.Response('<html>', 200)),
        contains('isn’t a FrockBot server'),
      );
    });

    test('says when it cannot be reached', () async {
      expect(
        await read((_) => throw http.ClientException('offline')),
        contains('Couldn’t reach bots.example.org'),
      );
    });
  });

  group('the account directory', () {
    test('each account reads and writes under its own prefix', () async {
      final root = AccountsMemoryStore();
      final a = ScopedStore(root, 'a');
      final b = ScopedStore(root, 'b');
      await a.write('session', 'one');
      await b.write('session', 'two');
      expect(await a.read('session'), 'one');
      expect(await b.read('session'), 'two');
      expect(
        root.values.keys,
        containsAll(['account/a/session', 'account/b/session']),
      );
      // The keystore still holds each account's session and nothing else.
      expect(SplitStore.secret('account/a/session'), isTrue);
      expect(SplitStore.secret('account/a/sign-in'), isTrue);
      expect(SplitStore.secret('account/a/revoke/s-1'), isTrue);
      expect(SplitStore.secret('account/a/directory/user-1'), isFalse);
    });

    test('the first run clears what the single-account build left', () async {
      final root = AccountsMemoryStore()
        ..values['session'] = session('user-1')
        ..values['directory/user-1'] = '{}';
      final directory = AccountDirectory(root);
      await directory.load();
      expect(directory.accounts, isEmpty);
      expect(root.values.keys, [AccountDirectory.key]);
      // And never again: an account's keys survive every later load.
      root.values['account/a/session'] = session('user-1');
      await AccountDirectory(root).load();
      expect(root.values, contains('account/a/session'));
    });

    test('adds, switches and removes accounts, keeping the rest', () async {
      final root = AccountsMemoryStore();
      final directory = AccountDirectory(root);
      await directory.load();
      final hosted = await directory.begin(hostedOrigin, 'FrockBot');
      expect(directory.accounts, isEmpty);
      await directory.storeFor(hosted).write('session', session('user-1'));
      await directory.complete(hosted, 'user-1');
      final own = await directory.begin('https://bots.example.org', 'FrockBot');
      await directory.storeFor(own).write('session', session('user-2'));
      await directory.complete(own, 'user-2');
      expect(directory.accounts.map((a) => a.userId), ['user-1', 'user-2']);
      expect(directory.active?.origin, 'https://bots.example.org');
      expect(directory.active?.serverLabel, 'bots.example.org');
      expect(directory.accounts.first.serverLabel, 'frockbot.com');

      await directory.activate(directory.accounts.first);
      final reloaded = AccountDirectory(root);
      await reloaded.load();
      expect(reloaded.active?.userId, 'user-1');

      await directory.remove(directory.accounts.first);
      expect(directory.accounts.map((a) => a.userId), ['user-2']);
      expect(directory.active?.userId, 'user-2');
      expect(await directory.storeFor(hosted).read('session'), isNull);
      expect(
        await directory.storeFor(directory.active!).read('session'),
        isNotNull,
      );
    });

    test('signing in again as a listed account replaces it', () async {
      final root = AccountsMemoryStore();
      final directory = AccountDirectory(root);
      await directory.load();
      final first = await directory.begin(hostedOrigin, 'FrockBot');
      await directory.complete(first, 'user-1');
      await directory.storeFor(first).write('selection.user-1', 'bot-a');
      final again = await directory.begin(hostedOrigin, 'FrockBot');
      await directory.complete(again, 'user-1');
      expect(directory.accounts.map((a) => a.id), [again.id]);
      expect(await directory.storeFor(first).read('selection.user-1'), isNull);
    });

    test('an abandoned sign-in leaves nothing behind', () async {
      final root = AccountsMemoryStore();
      final directory = AccountDirectory(root);
      await directory.load();
      final pending = await directory.begin(hostedOrigin, 'FrockBot');
      await directory.storeFor(pending).write('sign-in', '{}');
      // A process started afresh still knows which account a return is for.
      final restarted = AccountDirectory(root);
      await restarted.load();
      expect(restarted.pending?.id, pending.id);
      await restarted.abandon();
      expect(root.values.keys, [AccountDirectory.key]);
    });
  });

  testWidgets(
    'two accounts on two servers keep their own Bots, and signing out of one '
    'leaves the other',
    (tester) async {
      withoutDeepLinks(tester);
      tester.view.physicalSize = const Size(1400, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final paths = <String>[];
      final store = AccountsMemoryStore()
        ..values[AccountDirectory.key] = jsonEncode({
          'version': 1,
          'active': 'hosted',
          'accounts': [
            {
              'id': 'hosted',
              'origin': hostedOrigin,
              'name': 'FrockBot',
              'userId': 'user-hosted',
            },
            {
              'id': 'own',
              'origin': 'https://bots.example.org',
              'name': 'FrockBot',
              'userId': 'user-own',
            },
          ],
        })
        ..values['account/hosted/session'] = session('user-hosted')
        ..values['account/own/session'] = session('user-own');
      final revoked = <String>[];
      await tester.pumpWidget(
        FrockBotApp(
          store: store,
          apiFor: (account, scoped) {
            final hosted = account.origin == hostedOrigin;
            return AccountApi(
              scoped,
              origin: account.origin,
              userId: hosted ? 'user-hosted' : 'user-own',
              bots: [
                hosted
                    ? registration('bot-rose', 'Rosemary')
                    : registration('bot-clem', 'Clementine'),
              ],
              unread: hosted ? 0 : 3,
              paths: paths,
            );
          },
        ),
      );
      await answer(tester);

      expect(find.text('Rosemary'), findsWidgets);
      expect(find.text('Clementine'), findsNothing);
      // The switcher names where the account is, and counts the other's.
      expect(find.text('frockbot.com'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
      expect(paths, contains('bots.example.org/api/bots/unread'));

      await tester.tap(identifiedBy(AccountIds.switcher));
      await answer(tester);
      await tester.tap(find.text('bots.example.org'));
      await answer(tester);
      expect(find.text('Clementine'), findsWidgets);
      expect(find.text('Rosemary'), findsNothing);
      expect(paths, contains('bots.example.org/api/bots'));

      // Sign out of the account not on screen, from the switcher.
      await tester.tap(identifiedBy(AccountIds.switcher));
      await answer(tester);
      await tester.tap(
        find.descendant(
          of: identifiedBy(AccountIds.signOut('hosted')),
          matching: find.byType(IconButton),
        ),
      );
      await answer(tester);
      await tester.tap(find.text('Sign out of frockbot.com'));
      await answer(tester);
      revoked.addAll(paths.where((path) => path.endsWith('/revoke')));
      expect(revoked, [
        '${Uri.parse(hostedOrigin).host}/api/auth/native/revoke',
      ]);
      expect(store.values.containsKey('account/hosted/session'), isFalse);
      expect(store.values['account/own/session'], isNotNull);
      expect(find.text('Clementine'), findsWidgets);
      final directory = AccountDirectory(store);
      await directory.load();
      expect(directory.accounts.map((a) => a.id), ['own']);

      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    },
  );

  testWidgets('a session a server stops accepting ends that account alone', (
    tester,
  ) async {
    withoutDeepLinks(tester);
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final store = AccountsMemoryStore()
      ..values[AccountDirectory.key] = jsonEncode({
        'version': 1,
        'active': 'own',
        'accounts': [
          {
            'id': 'hosted',
            'origin': hostedOrigin,
            'name': 'FrockBot',
            'userId': 'user-hosted',
          },
          {
            'id': 'own',
            'origin': 'https://bots.example.org',
            'name': 'FrockBot',
            'userId': 'user-own',
          },
        ],
      })
      ..values['account/hosted/session'] = session('user-hosted')
      ..values['account/own/session'] = session('user-own');
    await tester.pumpWidget(
      FrockBotApp(
        store: store,
        apiFor: (account, scoped) {
          final hosted = account.origin == hostedOrigin;
          return AccountApi(
            scoped,
            origin: account.origin,
            userId: hosted ? 'user-hosted' : 'user-own',
            bots: [registration('bot-rose', 'Rosemary')],
            paths: [],
            rejected: !hosted,
          );
        },
      ),
    );
    await answer(tester);
    expect(find.text('Rosemary'), findsWidgets);
    expect(find.text('frockbot.com'), findsOneWidget);
    expect(
      find.text('bots.example.org: Please sign in again.'),
      findsOneWidget,
    );
    expect(store.values.containsKey('account/own/session'), isFalse);
    expect(store.values['account/hosted/session'], isNotNull);
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  });

  testWidgets('another server is read before anyone signs in to it', (
    tester,
  ) async {
    withoutDeepLinks(tester);
    final store = AccountsMemoryStore();
    final asked = <String>[];
    await tester.pumpWidget(
      FrockBotApp(
        store: store,
        discover: (address) async {
          asked.add(address);
          if (address == 'old.example.org') {
            throw const ServerRefused(
              'old.example.org runs an older version of FrockBot that this '
              'app no longer supports. Ask whoever runs it to update it.',
            );
          }
          return const ServerDiscovery(
            origin: 'https://bots.example.org',
            name: 'FrockBot',
            version: 'v1.2.3',
          );
        },
      ),
    );
    await answer(tester);
    await tester.tap(identifiedBy(SignInIds.otherServer));
    await answer(tester);
    await tester.enterText(
      find.descendant(
        of: identifiedBy(SignInIds.serverAddress),
        matching: find.byType(TextField),
      ),
      'old.example.org',
    );
    await tester.tap(identifiedBy(SignInIds.serverCheck));
    await answer(tester);
    expect(find.textContaining('runs an older version'), findsOneWidget);

    await tester.enterText(
      find.descendant(
        of: identifiedBy(SignInIds.serverAddress),
        matching: find.byType(TextField),
      ),
      'bots.example.org',
    );
    await tester.tap(identifiedBy(SignInIds.serverCheck));
    await answer(tester);
    expect(asked, ['old.example.org', 'bots.example.org']);
    // The sign-in page now names the server, and no provider it cannot know.
    expect(find.text('bots.example.org'), findsOneWidget);
    expect(find.text('FrockBot v1.2.3'), findsOneWidget);
    expect(find.text('Continue to sign in'), findsOneWidget);
    expect(find.textContaining('Google'), findsNothing);
    expect(find.text('Use a different server'), findsOneWidget);
  });
}
