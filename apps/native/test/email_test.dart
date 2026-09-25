import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/email/page.dart';
import 'package:frockbot_native/email/username.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/shell/transcript.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

const _address = 'fox.tim@frock.test';

/// The shape `inboundEmailViewV1` answers, by hand, so the page is pinned to
/// the server's contract.
Map<String, Object?> view({
  bool available = true,
  String? username = 'tim',
  bool enabled = false,
  List<Map<String, Object?>> senders = const [
    {'address': 'tim@example.com', 'status': 'sign-in'},
  ],
}) => {
  'schemaVersion': 1,
  'available': available,
  'username': ?username,
  'address': ?(available && username != null
      ? 'fox.$username@frock.test'
      : null),
  'enabled': enabled,
  'senders': senders,
};

/// What `GET /api/email/username` answers.
Map<String, Object?> usernameView({String? username, bool available = true}) =>
    {
      'schemaVersion': 1,
      'available': available,
      if (available) 'domain': 'frock.test',
      'username': ?username,
    };

Finder byId(String id) => find.bySemanticsIdentifier(id);

Future<void> pumpPage(WidgetTester tester, SettingsApi api) async {
  // A phone held upright: the whole page, the sender field included, on one
  // screen.
  tester.view.physicalSize = const Size(800, 1400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: BotEmailPage(api: api, botId: 'fox'),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('turns the Bot’s email on, and copies its address', (
    tester,
  ) async {
    final calls = <List<Object?>>[];
    var enabled = false;
    final api = SettingsApi(MemoryStore(), (path, body) async {
      calls.add([path, body]);
      if (path == '/api/bots/fox/email/switch') {
        enabled = (body as Map)['enabled'] == true;
      }
      return view(enabled: enabled);
    });
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied.add((call.arguments as Map)['text'] as String);
        }
        return null;
      },
    );
    await pumpPage(tester, api);
    expect(find.text(_address), findsOneWidget);
    expect(
      find.text('Off: mail to this address is refused and the Bot sends none'),
      findsOneWidget,
    );
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);

    await tester.tap(byId(EmailIds.enabled));
    await tester.pumpAndSettle();
    expect(calls.last, [
      '/api/bots/fox/email/switch',
      {'enabled': true},
    ]);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
    expect(
      find.text('The Bot receives and sends mail at this address'),
      findsOneWidget,
    );

    await tester.tap(find.text('Copy'));
    await tester.pumpAndSettle();
    expect(copied, [_address]);
    expect(find.text('Address copied.'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    api.close();
  });

  testWidgets(
    'without a username there is no address, and it says where to choose one',
    (tester) async {
      String? username;
      final posted = <List<Object?>>[];
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (path == '/api/email/username') {
          if (body != null) {
            posted.add([path, body]);
            username = (body as Map)['username'] as String?;
          }
          return usernameView(username: username);
        }
        return view(username: username);
      });
      await pumpPage(tester, api);
      expect(byId(EmailIds.noUsername), findsOneWidget);
      expect(find.text('Copy'), findsNothing);

      await tester.tap(find.text('Choose a username'));
      await tester.pumpAndSettle();
      expect(byId(EmailIds.usernamePage), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'Tim');
      await tester.pumpAndSettle();
      expect(find.textContaining('fox.tim@frock.test'), findsOneWidget);
      // The first username changes no address, so nothing asks first.
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(posted, [
        [
          '/api/email/username',
          {'username': 'tim'},
        ],
      ]);

      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.text(_address), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      api.close();
    },
  );

  testWidgets('adds a sender and shows the code to send back from it', (
    tester,
  ) async {
    final posted = <List<Object?>>[];
    var senders = <Map<String, Object?>>[
      {'address': 'tim@example.com', 'status': 'sign-in'},
    ];
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (body != null) {
        posted.add([path, body]);
        final command = body as Map;
        if (command['action'] == 'add') {
          senders = [
            ...senders,
            {
              'address': command['address'],
              'status': 'pending',
              'code': 'FROCK-7K3P-9QXM',
              'expiresAt': '2026-09-25T10:00:00.000Z',
            },
          ];
        } else {
          senders = [
            for (final sender in senders)
              if (sender['address'] != command['address']) sender,
          ];
        }
      }
      return view(senders: senders);
    });
    await pumpPage(tester, api);
    expect(find.text('The address you sign in with'), findsOneWidget);

    await tester.enterText(find.byType(TextField), ' tim@work.example ');
    await tester.tap(find.text('Add'));
    await tester.pumpAndSettle();
    expect(posted.single, [
      '/api/bots/fox/email/senders',
      {'action': 'add', 'address': 'tim@work.example'},
    ]);
    expect(find.text('FROCK-7K3P-9QXM'), findsOneWidget);
    expect(
      find.textContaining('send this code from tim@work.example to $_address'),
      findsOneWidget,
    );
    // Added: the field is ready for the next one.
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      '',
    );

    await tester.tap(find.byTooltip('Remove tim@work.example'));
    await tester.pumpAndSettle();
    expect(posted.last, [
      '/api/bots/fox/email/senders',
      {'action': 'remove', 'address': 'tim@work.example'},
    ]);
    expect(find.text('FROCK-7K3P-9QXM'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    api.close();
  });

  testWidgets('says why a command was refused', (tester) async {
    final api = SettingsApi(MemoryStore(), (path, body) async {
      if (body != null) {
        throw const RequestFailure(
          'Up to 10 addresses can email your Bots. Remove one first.',
          409,
        );
      }
      return view();
    });
    await pumpPage(tester, api);
    await tester.enterText(find.byType(TextField), 'one@more.example');
    await tester.tap(find.text('Add'));
    await tester.pumpAndSettle();
    expect(
      find.text('Up to 10 addresses can email your Bots. Remove one first.'),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
    api.close();
  });

  testWidgets('a deployment without email says so and offers no address', (
    tester,
  ) async {
    final api = SettingsApi(
      MemoryStore(),
      (path, body) async => view(available: false),
    );
    await pumpPage(tester, api);
    expect(find.text('Email isn’t set up on this deployment.'), findsOneWidget);
    expect(find.byType(Switch), findsNothing);
    expect(byId(EmailIds.unavailable), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    api.close();
  });

  group('the account’s username', () {
    Future<void> pumpUsername(WidgetTester tester, SettingsApi api) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: EmailUsernamePage(api: api),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('asks before a change moves every Bot’s address', (
      tester,
    ) async {
      var username = 'tim';
      final posted = <Object?>[];
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body != null) {
          posted.add(body);
          username = (body as Map)['username'] as String;
        }
        return usernameView(username: username);
      });
      await pumpUsername(tester, api);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller?.text,
        'tim',
      );
      expect(
        find.textContaining('changes every Bot’s address'),
        findsOneWidget,
      );

      await tester.enterText(find.byType(TextField), 'timo');
      await tester.pumpAndSettle();
      expect(find.textContaining('fox.timo@frock.test'), findsOneWidget);
      await tester.tap(find.text('Change username'));
      await tester.pumpAndSettle();
      expect(byId(EmailIds.usernameConfirm), findsOneWidget);
      expect(find.textContaining('.timo@frock.test'), findsWidgets);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(posted, isEmpty);

      await tester.tap(find.text('Change username'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Change'));
      await tester.pumpAndSettle();
      expect(posted, [
        {'username': 'timo'},
      ]);
      await tester.pumpWidget(const SizedBox());
      api.close();
    });

    testWidgets('says why a username was refused', (tester) async {
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body != null) {
          throw const RequestFailure(
            'That username is taken. Choose another.',
            409,
          );
        }
        return usernameView();
      });
      await pumpUsername(tester, api);
      await tester.enterText(find.byType(TextField), 'tim');
      await tester.pump();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(
        find.text('That username is taken. Choose another.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      api.close();
    });

    testWidgets('gives the username up once asked', (tester) async {
      String? username = 'tim';
      final posted = <Object?>[];
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body != null) {
          posted.add(body);
          username = null;
        }
        return usernameView(username: username);
      });
      await pumpUsername(tester, api);
      await tester.tap(find.text('Remove'));
      await tester.pumpAndSettle();
      expect(byId(EmailIds.usernameRemoveConfirm), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
      await tester.pumpAndSettle();
      expect(posted, [
        {'username': null},
      ]);
      expect(find.text('Remove'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      api.close();
    });
  });

  group('a message written by email', () {
    Map<String, dynamic> run({Map<String, Object?>? via}) => {
      'runId': 'em-1',
      'input': 'Subject: Agenda\n\nDraft it, please.',
      'status': 'completed',
      'admittedAt': '2026-09-24T01:00:00.000Z',
      'via': ?via,
      'events': const [],
    };

    test('is the person’s own message, marked where it came from', () {
      final mine = projectRuns([
        run(via: {'kind': 'email'}),
      ]).singleWhere((line) => line.role == LineRole.user);
      expect(mine.via, 'email');
      expect(mine.exchange, isNull);
    });

    testWidgets('says so under the bubble', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: TranscriptView(
              lines: projectRuns([
                run(via: {'kind': 'email'}),
              ]),
              loading: false,
              hasEarlier: false,
              background: 'hot-pink',
              onRefresh: ({older = false}) async {},
              onOpenRun: (_) {},
              storageKey: 'email-caption',
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('via email'), findsOneWidget);
    });
  });
}
