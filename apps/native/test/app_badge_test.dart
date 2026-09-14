import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/activity/badge.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'widget_test.dart' show MemoryStore;

/// A two-Bot account whose unread fan-out a test holds open, so it can act
/// inside the window the shell spends with a directory and no counts.
class _ShellApi extends NativeApi {
  _ShellApi(super.store, this.bots, this.fanOut, {this.directoryFails = false});
  final List<Map<String, Object?>> bots;
  final Completer<Object?> fanOut;
  int unreadRequests = 0;

  /// Whether `/api/bots` fails, leaving the shell with no directory at all
  /// while the fan-out still answers. A test flips it to bring the read back.
  bool directoryFails;

  /// Holds the next `/api/bots` answer open, so a test can act inside the
  /// window a directory read spends in flight.
  Completer<void>? directoryGate;
  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    if (path == '/api/bots') {
      if (directoryFails) throw const FormatException('directory unreachable');
      final answered = [...bots];
      final gate = directoryGate;
      if (gate != null) {
        directoryGate = null;
        await gate.future;
      }
      return {'schemaVersion': 1, 'revision': 1, 'bots': answered};
    }
    if (path == '/api/bots/lifecycles') {
      return {'schemaVersion': 1, 'lifecycles': const []};
    }
    if (path == '/api/bots/unread') {
      unreadRequests++;
      return fanOut.future;
    }
    throw const FormatException('offline fixture');
  }

  @override
  Future<WebSocketChannel> socket(String botId, String? cursor) async =>
      throw const FormatException('offline fixture');
}

Map<String, Object?> registration(String botId, String name) => {
  'schemaVersion': 1,
  'botId': botId,
  'registeredAt': '2026-09-05T00:00:00.000Z',
  'initialName': name,
  'sheep': {
    'schemaVersion': 1,
    'background': 'a',
    'upper': 'b',
    'middle': 'c',
    'lower': 'd',
  },
};

wire.UnreadView view(
  String botId, {
  int count = 0,
  bool capped = false,
  bool manual = false,
  bool notifications = true,
}) => wire.UnreadView.fromJson({
  'schemaVersion': 1,
  'botId': botId,
  'count': count,
  'capped': capped,
  'unread': count > 0 || manual,
  'manuallyUnread': manual,
  'notificationsEnabled': notifications,
});

Map<String, wire.UnreadView> directory(List<wire.UnreadView> views) => {
  for (final view in views) view.botId.value: view,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('the application badge counts', () {
    test('unread messages across eligible Bots', () {
      final badge = appBadgeFor(
        unread: directory([view('alpha', count: 2), view('beta', count: 3)]),
        botIds: ['alpha', 'beta'],
        focusedBotId: null,
      );
      expect(badge.total, 5);
      expect(badge.label, '5');
    });

    test('nothing from a muted Bot, and says it is silenced', () {
      final badge = appBadgeFor(
        unread: directory([
          view('alpha', count: 2),
          view('muted', count: 7, notifications: false),
        ]),
        botIds: ['alpha', 'muted'],
        focusedBotId: null,
      );
      expect(badge.label, '2');
      expect(badge.bots.keys, ['alpha']);
      expect(badge.silenced, {'muted'});
    });

    test('nothing from an archived Bot, or one outside the directory', () {
      final badge = appBadgeFor(
        unread: directory([
          view('alpha', count: 1),
          view('old', count: 4),
          view('stranger', count: 9),
        ]),
        botIds: ['alpha'],
        archived: {'old'},
        focusedBotId: null,
      );
      expect(badge.label, '1');
      expect(badge.silenced, {'old'});
      expect(badge.bots.containsKey('stranger'), isFalse);
    });

    test('nothing for a manual mark with no messages', () {
      final badge = appBadgeFor(
        unread: directory([view('alpha', manual: true)]),
        botIds: ['alpha'],
        focusedBotId: null,
      );
      expect(badge.total, 0);
      expect(badge.label, isNull);
    });

    test(
      'nothing for the focused chat while its read receipt is in flight',
      () {
        final badge = appBadgeFor(
          unread: directory([
            view('alpha', count: 3, capped: true),
            view('beta', count: 1),
          ]),
          botIds: ['alpha', 'beta'],
          focusedBotId: 'alpha',
        );
        expect(badge.label, '1');
        expect(badge.bots['alpha']?.launcherCount, 4);
        expect(badge.suppressed, {'alpha'});
      },
    );

    test('a focused chat at cloud zero still reports authoritative zero', () {
      final badge = appBadgeFor(
        unread: directory([view('beta')]),
        botIds: ['beta'],
        focusedBotId: 'beta',
      );
      expect(badge.launcherCounts, {'beta': 0});
      expect(badge.suppressed, isEmpty);
    });

    test('saturates at 99+ over the sum and over any capped Bot', () {
      expect(
        appBadgeFor(
          unread: directory([
            view('alpha', count: 60),
            view('beta', count: 40),
          ]),
          botIds: ['alpha', 'beta'],
          focusedBotId: null,
        ).label,
        '99+',
      );
      expect(
        appBadgeFor(
          unread: directory([view('alpha', count: 99)]),
          botIds: ['alpha'],
          focusedBotId: null,
        ).label,
        '99',
      );
      final capped = appBadgeFor(
        unread: directory([view('alpha', count: 99, capped: true)]),
        botIds: ['alpha'],
        focusedBotId: null,
      );
      expect(capped.label, '99+');
      expect(capped.bots['alpha']?.launcherCount, 100);
    });
  });

  group('the platform adapters', () {
    tearDown(() {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(
        const MethodChannel('com.frockbot/badge'),
        null,
      );
      messenger.setMockMethodCallHandler(
        const MethodChannel('frockbot/push'),
        null,
      );
    });

    List<MethodCall> record(String name) {
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(MethodChannel(name), (call) async {
            calls.add(call);
            return null;
          });
      return calls;
    }

    test('the dock draws the label, sends a change once, and clears', () async {
      final calls = record('com.frockbot/badge');
      final sync = AppBadgeSync(const DockBadgePresenter());
      final two = appBadgeFor(
        unread: directory([view('alpha', count: 2)]),
        botIds: ['alpha'],
        focusedBotId: null,
      );
      sync.update(two);
      sync.update(
        appBadgeFor(
          unread: directory([view('alpha', count: 2)]),
          botIds: ['alpha'],
          focusedBotId: null,
        ),
      );
      sync.update(AppBadge.empty);
      await sync.clear();
      sync.update(two);
      await sync.clear();
      expect(calls.map((call) => call.method), ['set', 'set', 'set']);
      expect(calls.map((call) => (call.arguments as Map)['label']), [
        '2',
        null,
        null,
      ]);
    });

    test('startup keeps the old badge until every Bot is known, then suppresses only the focused Bot', () async {
      final calls = record('com.frockbot/badge');
      final sync = AppBadgeSync(const DockBadgePresenter());

      // The shell's first build has no fan-out yet. That is unknown, not an
      // authoritative zero, so it must not clear the Dock badge.
      sync.reconcile(AppBadge.empty, authoritative: false);
      sync.reconcile(
        appBadgeFor(
          unread: directory([view('alpha', count: 2), view('beta', count: 3)]),
          botIds: ['alpha', 'beta'],
          focusedBotId: 'beta',
        ),
        authoritative: true,
      );
      await sync.clear();

      expect(calls.map((call) => (call.arguments as Map)['label']), [
        '2',
        null,
      ]);
    });

    test(
      'a replaced shell does not clear the badge its successor drew',
      () async {
        final calls = record('com.frockbot/badge');
        final previous = AppBadgeSync(const DockBadgePresenter());
        final next = AppBadgeSync(const DockBadgePresenter());
        previous.update(
          appBadgeFor(
            unread: directory([view('alpha', count: 1)]),
            botIds: ['alpha'],
            focusedBotId: null,
          ),
        );
        next.update(
          appBadgeFor(
            unread: directory([view('beta', count: 4)]),
            botIds: ['beta'],
            focusedBotId: null,
          ),
        );
        await previous.clear();
        await next.clear();
        expect(calls.map((call) => (call.arguments as Map)['label']), [
          '1',
          '4',
          null,
        ]);
      },
    );

    test(
      'the launcher hears per-Bot counts and silenced Bots once push is ready',
      () async {
        final calls = record('frockbot/push');
        var ready = false;
        final sync = AppBadgeSync(LauncherBadgePresenter(ready: () => ready));
        final badge = appBadgeFor(
          unread: directory([
            view('alpha', count: 99, capped: true),
            view('beta'),
            view('muted', count: 3, notifications: false),
          ]),
          botIds: ['alpha', 'beta', 'muted'],
          focusedBotId: null,
        );
        sync.update(badge);
        await Future<void>.delayed(Duration.zero);
        expect(calls, isEmpty);

        ready = true;
        sync.invalidate();
        sync.update(badge);
        await sync.clear();
        expect(calls.map((call) => call.method), ['badge']);
        expect(calls.single.arguments, {
          'bots': {'alpha': 100, 'beta': 0},
          'silenced': ['muted'],
          'suppressed': <String>[],
        });
      },
    );

    test(
      'the launcher receives focus suppression separately from counts',
      () async {
        final calls = record('frockbot/push');
        final badge = appBadgeFor(
          unread: directory([view('alpha', count: 2), view('beta', count: 3)]),
          botIds: ['alpha', 'beta'],
          focusedBotId: 'beta',
        );

        await LauncherBadgePresenter(ready: () => true).show(badge);

        expect(calls.single.arguments, {
          'bots': {'alpha': 2, 'beta': 3},
          'silenced': <String>[],
          'suppressed': ['beta'],
        });
      },
    );

    test(
      'the launcher sends focused cloud zero as authoritative zero',
      () async {
        final calls = record('frockbot/push');
        final badge = appBadgeFor(
          unread: directory([view('beta')]),
          botIds: ['beta'],
          focusedBotId: 'beta',
        );

        await LauncherBadgePresenter(ready: () => true).show(badge);

        expect(calls.single.arguments, {
          'bots': {'beta': 0},
          'silenced': <String>[],
          'suppressed': <String>[],
        });
      },
    );
  });

  group('the shell wires the badge to the cloud fan-out', () {
    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            const MethodChannel('com.frockbot/badge'),
            null,
          );
    });

    testWidgets('keeping the dock quiet until it arrives, then drawing it', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      tester.view.physicalSize = const Size(800, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(const MethodChannel('com.frockbot/badge'), (
            call,
          ) async {
            calls.add(call);
            return null;
          });

      final store = MemoryStore();
      store.values['selection.test-user'] = 'beta';
      final fanOut = Completer<Object?>();
      final api = _ShellApi(store, [
        registration('alpha', 'Alpha'),
        registration('beta', 'Beta'),
      ], fanOut);
      final sessions = BotSessions(api: api, store: store);
      final links = ValueNotifier<String?>(null);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: AppShell(
            api: api,
            store: store,
            sessions: sessions,
            userId: 'test-user',
            botLinks: links,
            onSignOut: () async {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The shell has drawn its directory, and still has no fan-out. That
      // empty local map is unknown, not an authoritative zero, so nothing may
      // cross the dock channel and take an existing badge away.
      expect(find.text('Alpha'), findsOneWidget);
      expect(find.text('Beta'), findsNWidgets(2));
      expect(calls, isEmpty);

      fanOut.complete({
        'schemaVersion': 1,
        'unread': [
          view('alpha', count: 2).toJson(),
          view('beta', count: 3).toJson(),
        ],
      });
      await tester.pumpAndSettle();
      expect(calls.map((call) => call.method), ['set']);
      expect((calls.single.arguments as Map)['label'], '2');

      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      sessions.clear();
      links.dispose();
      api.close();
      debugDefaultTargetPlatformOverride = null;
    });

    testWidgets('and keeping it quiet while the directory is unknown', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(const MethodChannel('com.frockbot/badge'), (
            call,
          ) async {
            calls.add(call);
            return null;
          });

      final store = MemoryStore();
      final fanOut = Completer<Object?>()
        ..complete({
          'schemaVersion': 1,
          'unread': [view('alpha', count: 2).toJson()],
        });
      final api = _ShellApi(
        store,
        [registration('alpha', 'Alpha')],
        fanOut,
        directoryFails: true,
      );
      final sessions = BotSessions(api: api, store: store);
      final links = ValueNotifier<String?>(null);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: AppShell(
            api: api,
            store: store,
            sessions: sessions,
            userId: 'test-user',
            botLinks: links,
            onSignOut: () async {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The directory read failed, so the shell has no Bots to count over.
      // The poll still reaches the fan-out; an account whose directory is
      // unknown is not an account with nothing unread, so the dock keeps
      // whatever it was already showing.
      await tester.pump(const Duration(seconds: 11));
      await tester.pumpAndSettle();
      expect(calls, isEmpty);

      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      sessions.clear();
      links.dispose();
      api.close();
      debugDefaultTargetPlatformOverride = null;
    });

    testWidgets('and while only a cached directory says who the Bots are', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(const MethodChannel('com.frockbot/badge'), (
            call,
          ) async {
            calls.add(call);
            return null;
          });

      final store = MemoryStore();
      // The cache holds `/api/bots` and nothing else. Alpha may have been
      // archived on another device since it was written, and only the
      // lifecycle read says so.
      store.values['directory/test-user'] = jsonEncode({
        'schemaVersion': 1,
        'revision': 1,
        'bots': [registration('alpha', 'Alpha')],
      });
      final fanOut = Completer<Object?>()
        ..complete({
          'schemaVersion': 1,
          'unread': [view('alpha', count: 2).toJson()],
        });
      final api = _ShellApi(
        store,
        [registration('alpha', 'Alpha')],
        fanOut,
        directoryFails: true,
      );
      final sessions = BotSessions(api: api, store: store);
      final links = ValueNotifier<String?>(null);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: AppShell(
            api: api,
            store: store,
            sessions: sessions,
            userId: 'test-user',
            botLinks: links,
            onSignOut: () async {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The sidebar draws the cached Bot, because a cached name is a name.
      // The badge does not count it: its archive state is unknown, so the
      // dock keeps whatever it was already showing.
      expect(find.text('Alpha'), findsOneWidget);
      await tester.pump(const Duration(seconds: 11));
      await tester.pumpAndSettle();
      expect(calls, isEmpty);

      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      sessions.clear();
      links.dispose();
      api.close();
      debugDefaultTargetPlatformOverride = null;
    });

    testWidgets('and draws it once a failed directory read comes back', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(const MethodChannel('com.frockbot/badge'), (
            call,
          ) async {
            calls.add(call);
            return null;
          });

      final store = MemoryStore();
      store.values['directory/test-user'] = jsonEncode({
        'schemaVersion': 1,
        'revision': 1,
        'bots': [registration('alpha', 'Alpha')],
      });
      final fanOut = Completer<Object?>()
        ..complete({
          'schemaVersion': 1,
          'unread': [view('alpha', count: 2).toJson()],
        });
      final api = _ShellApi(
        store,
        [registration('alpha', 'Alpha')],
        fanOut,
        directoryFails: true,
      );
      final sessions = BotSessions(api: api, store: store);
      final links = ValueNotifier<String?>(null);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: AppShell(
            api: api,
            store: store,
            sessions: sessions,
            userId: 'test-user',
            botLinks: links,
            onSignOut: () async {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(calls, isEmpty);

      // Connectivity returns. Nothing the User does asks for the directory
      // again, so the poll has to: until it lands the icon is frozen for the
      // rest of the session while the sidebar keeps counting.
      api.directoryFails = false;
      await tester.pump(const Duration(seconds: 11));
      await tester.pumpAndSettle();
      expect(calls.map((call) => call.method), ['set']);
      expect((calls.single.arguments as Map)['label'], '2');

      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      sessions.clear();
      links.dispose();
      api.close();
      debugDefaultTargetPlatformOverride = null;
    });

    testWidgets('and still serves a Retry asked for mid-poll', (tester) async {
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final store = MemoryStore();
      final fanOut = Completer<Object?>()
        ..complete({'schemaVersion': 1, 'unread': const []});
      final api = _ShellApi(
        store,
        [registration('alpha', 'Alpha')],
        fanOut,
        directoryFails: true,
      );
      final sessions = BotSessions(api: api, store: store);
      final links = ValueNotifier<String?>(null);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: AppShell(
            api: api,
            store: store,
            sessions: sessions,
            userId: 'test-user',
            botLinks: links,
            onSignOut: () async {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Retry'), findsOneWidget);

      // The poll's own retry is mid-read when the User asks for one too. The
      // read in flight cannot answer for them: it was issued before the Bot
      // they are waiting on existed.
      api.directoryFails = false;
      final gate = Completer<void>();
      api.directoryGate = gate;
      await tester.pump(const Duration(seconds: 11));
      await tester.pump();
      await tester.tap(find.text('Retry'));
      await tester.pump();
      api.bots.add(registration('beta', 'Beta'));
      gate.complete();
      await tester.pumpAndSettle();

      expect(find.text('Alpha'), findsOneWidget);
      expect(find.text('Beta'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      sessions.clear();
      links.dispose();
      api.close();
    });

    testWidgets('and reapplies focused suppression after native activity', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      tester.view.physicalSize = const Size(800, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final badges = <Map<Object?, Object?>>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(const MethodChannel('frockbot/push'), (
        call,
      ) async {
        if (call.method == 'configure') return 'token-1';
        if (call.method == 'focus') return true;
        if (call.method == 'badge') {
          badges.add(call.arguments as Map<Object?, Object?>);
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(
          const MethodChannel('frockbot/push'),
          null,
        ),
      );

      final store = MemoryStore();
      store.values['selection.test-user'] = 'beta';
      final fanOut = Completer<Object?>();
      final api = _ShellApi(store, [
        registration('alpha', 'Alpha'),
        registration('beta', 'Beta'),
      ], fanOut);
      final sessions = BotSessions(api: api, store: store);
      final links = ValueNotifier<String?>(null);
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: AppShell(
            api: api,
            store: store,
            sessions: sessions,
            userId: 'test-user',
            botLinks: links,
            onSignOut: () async {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(badges, isEmpty);
      fanOut.complete({
        'schemaVersion': 1,
        'unread': [
          view('alpha', count: 2).toJson(),
          view('beta', count: 3).toJson(),
        ],
      });
      await tester.pumpAndSettle();
      final expected = {
        'bots': {'alpha': 2, 'beta': 3},
        'silenced': <String>[],
        'suppressed': ['beta'],
      };
      expect(badges, [expected]);
      final requestsBeforeDelivery = api.unreadRequests;

      await messenger.handlePlatformMessage(
        'frockbot/push',
        const StandardMethodCodec().encodeMethodCall(
          const MethodCall('activity'),
        ),
        (_) {},
      );
      await tester.pumpAndSettle();
      expect(api.unreadRequests, requestsBeforeDelivery + 1);
      expect(badges, [expected, expected]);

      await messenger.handlePlatformMessage(
        'frockbot/push',
        const StandardMethodCodec().encodeMethodCall(
          const MethodCall('focus', true),
        ),
        (_) {},
      );
      await tester.pumpAndSettle();
      expect(badges, [expected, expected]);

      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      sessions.clear();
      links.dispose();
      api.close();
      debugDefaultTargetPlatformOverride = null;
    });

    testWidgets(
      'and reconciles the launcher once push is ready, not on every focus '
      'report',
      (tester) async {
        debugDefaultTargetPlatformOverride = TargetPlatform.android;
        tester.view.physicalSize = const Size(320, 800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final calls = <MethodCall>[];
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(
          const MethodChannel('frockbot/push'),
          (call) async {
            calls.add(call);
            if (call.method == 'configure') return 'token-1';
            if (call.method == 'focus') return true;
            return null;
          },
        );
        addTearDown(
          () => messenger.setMockMethodCallHandler(
            const MethodChannel('frockbot/push'),
            null,
          ),
        );

        final store = MemoryStore();
        final fanOut = Completer<Object?>()
          ..complete({
            'schemaVersion': 1,
            'unread': [view('alpha', count: 2).toJson()],
          });
        final api = _ShellApi(store, [registration('alpha', 'Alpha')], fanOut);
        final sessions = BotSessions(api: api, store: store);
        final links = ValueNotifier<String?>(null);
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(Brightness.dark),
            home: AppShell(
              api: api,
              store: store,
              sessions: sessions,
              userId: 'test-user',
              botLinks: links,
              onSignOut: () async {},
            ),
          ),
        );
        await tester.pumpAndSettle();

        final badges = calls.where((call) => call.method == 'badge').toList();
        expect(badges.length, 1);
        expect((badges.single.arguments as Map)['bots'], {'alpha': 2});
        calls.clear();

        // The platform reporting focus again changes nothing the badge counts,
        // so it must not be pushed back across the channel: on Android that
        // re-runs a whole native notification reconcile.
        for (final focused in [false, true]) {
          await messenger.handlePlatformMessage(
            'frockbot/push',
            const StandardMethodCodec().encodeMethodCall(
              MethodCall('focus', focused),
            ),
            (_) {},
          );
          await tester.pumpAndSettle();
        }
        expect(calls.where((call) => call.method == 'badge'), isEmpty);

        await tester.pumpWidget(const SizedBox());
        await tester.pumpAndSettle();
        sessions.clear();
        links.dispose();
        api.close();
        debugDefaultTargetPlatformOverride = null;
      },
    );
  });
}
