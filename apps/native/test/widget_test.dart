import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/chat_pane.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

class MemoryStore implements LocalStore {
  final values = <String, String>{};
  bool fail = false;
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    if (fail) throw StateError('storage unavailable');
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

/// A store whose durable write can be held open, so a test can act inside the
/// window a send spends waiting on it.
class GatedStore extends MemoryStore {
  Completer<void>? gate;
  @override
  Future<void> write(String key, String value) async {
    final held = gate;
    if (held != null) await held.future;
    await super.write(key, value);
  }
}

Map<String, dynamic> running() => {
  'runId': 'send-1',
  'admittedAt': '2026-09-05T01:00:00Z',
  'input': 'Hello',
  'status': 'running',
  'events': <Object>[],
};

class FakeTransport implements ChatTransport {
  final MemoryStore store;
  final calls = <String>[];
  final sentTexts = <String>[];
  final superseded = <String?>[];
  final completion = Completer<void>();
  Map<String, dynamic>? observed;
  bool loseReply = false;
  FakeTransport(this.store);
  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'runs': observed == null ? <Object>[] : [observed],
    'page': {'truncated': false},
  };
  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? supersedes,
  }) async {
    expect(
      (jsonDecode(store.values['chat/user-1/bot-1']!)['pending'] as List)
          .last['id'],
      id,
    );
    calls.add('send:$id');
    sentTexts.add(text);
    superseded.add(supersedes);
    await completion.future;
    if (loseReply) throw const RequestFailure('lost');
  }

  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) async {
    calls.add(fence ? 'fence:$id' : 'lookup:$id');
    return observed;
  }

  @override
  Future<Map<String, dynamic>> stop(
    String botId,
    String id,
    String commandId,
  ) async {
    expect(jsonDecode(store.values['chat/user-1/bot-1']!)['stopId'], commandId);
    calls.add('stop:$commandId');
    return {...running(), 'stopRequestedAt': '2026-09-05T01:01:00Z'};
  }
}

class PagedTransport extends FakeTransport {
  PagedTransport(super.store);
  Map<String, dynamic> row(int number) => {
    'runId': 'row-$number',
    'admittedAt': DateTime.utc(
      2026,
      9,
      5,
    ).add(Duration(minutes: number)).toIso8601String(),
    'input': 'Message $number',
    'status': 'completed',
    'events': <Object>[],
  };
  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'runs': List.generate(
      20,
      (index) => row(index + (before == null ? 20 : 0)),
    ),
    'page': before == null
        ? {'nextCursor': 'older', 'truncated': true}
        : {'truncated': false},
  };
}

void main() {
  testWidgets('initial Bot synchronization is quiet until it actually fails', (
    tester,
  ) async {
    final store = MemoryStore();
    final controller = ChatController(
      transport: FakeTransport(store),
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: ChatPane(controller: controller, onReconnect: () async {}),
        ),
      ),
    );

    expect(controller.connection, ConnectionState.initializing);
    expect(find.byType(MaterialBanner), findsNothing);
    expect(find.text('Connecting…'), findsNothing);
    expect(find.byKey(const ValueKey('reconnect')), findsNothing);

    controller.connection = ConnectionState.disconnected;
    controller.changed();
    await tester.pump();
    expect(find.byType(MaterialBanner), findsOneWidget);
    expect(
      find.text('You’re offline. Your Bot can keep working.'),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('reconnect')), findsOneWidget);

    controller.connection = ConnectionState.reconnecting;
    controller.changed();
    await tester.pump();
    expect(find.byType(MaterialBanner), findsNothing);

    controller.connection = ConnectionState.paused;
    controller.changed();
    await tester.pump();
    expect(find.byType(MaterialBanner), findsOneWidget);
    expect(find.text('Conversation paused on this device.'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });

  testWidgets(
    'chat opens on the latest row and earlier pages preserve the reading position',
    (tester) async {
      final store = MemoryStore();
      final controller = ChatController(
        transport: PagedTransport(store),
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
      );
      await controller.initialize();
      controller.connection = ConnectionState.connected;
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: ChatPane(controller: controller, onReconnect: () async {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Message 39'), findsOneWidget);
      expect(find.text('Message 20'), findsNothing);
      await tester.scrollUntilVisible(
        find.text('Earlier messages'),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      final before = tester.getTopLeft(find.text('Message 20'));
      await tester.tap(find.text('Earlier messages'));
      await tester.pumpAndSettle();
      expect(
        tester.getTopLeft(find.text('Message 20')).dy,
        closeTo(before.dy, 1),
      );
      expect(controller.runs.length, 40);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );

  testWidgets(
    'chat states preserve controls at 200% text with reduced motion',
    (tester) async {
      tester.view.physicalSize = const Size(390, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      for (final state in [
        'empty',
        'loading',
        'offline',
        'uncertain',
        'running',
        'failed',
      ]) {
        final store = MemoryStore();
        final transport = FakeTransport(store);
        if (state == 'running' || state == 'failed') {
          transport.observed = {...running(), 'status': state};
        }
        final controller = ChatController(
          transport: transport,
          store: store,
          userId: 'user-1',
          botId: 'bot-1',
        );
        await controller.initialize();
        controller.connection = state == 'offline'
            ? ConnectionState.disconnected
            : ConnectionState.connected;
        controller.loading = state == 'loading';
        if (state == 'uncertain') {
          controller.pending = const [
            PendingSend('pending-1', 'Keep my draft'),
          ];
          controller.draft = 'Keep my draft';
          controller.error =
              'Couldn’t confirm your message. Reconnect or check again.';
        }
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(Brightness.dark),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(
                textScaler: const TextScaler.linear(2),
                disableAnimations: true,
              ),
              child: child!,
            ),
            home: Scaffold(
              body: ChatPane(controller: controller, onReconnect: () async {}),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: state);
        expect(find.byKey(const ValueKey('composer')), findsOneWidget);
        expect(find.byKey(const ValueKey('send')), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsNothing);
        if (state == 'uncertain') {
          expect(find.byKey(const ValueKey('check-delivery')), findsOneWidget);
        }
        if (state == 'running') {
          expect(find.byKey(const ValueKey('stop')), findsOneWidget);
        }
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      }
    },
  );

  testWidgets(
    'send persists identity; Stop is explicit and remains until terminal',
    (tester) async {
      final store = MemoryStore();
      final t = FakeTransport(store);
      var ids = 0;
      final c = ChatController(
        transport: t,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => ++ids == 1 ? 'send-1' : 'stop-1',
      );
      await c.initialize();
      c.connection = ConnectionState.connected;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ChatPane(controller: c, onReconnect: () async {}),
          ),
        ),
      );
      await tester.enterText(find.byKey(const ValueKey('composer')), 'Hello');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('send')));
      await tester.pump();
      expect(t.calls, ['send:send-1']);
      await tester.tap(find.byKey(const ValueKey('stop')));
      await tester.pump();
      expect(find.text('Stopping…'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('stop')));
      await tester.pump();
      expect(t.calls.where((x) => x.startsWith('stop:')), [
        'stop:stop-1',
        'stop:stop-1',
      ]);
      t.observed = {...running(), 'status': 'cancelled'};
      t.completion.complete();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('stop')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    },
  );
  testWidgets('Send admits composed Gboard text without needing a newline', (
    tester,
  ) async {
    final store = MemoryStore();
    final transport = FakeTransport(store);
    var sends = 0;
    final controller = ChatController(
      transport: transport,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
      nextId: () => 'send-${sends += 1}',
    );
    await controller.initialize();
    controller.connection = ConnectionState.connected;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ChatPane(controller: controller, onReconnect: () async {}),
        ),
      ),
    );
    final composer = find.byKey(const ValueKey('composer'));
    await tester.tap(composer);
    await tester.pump();
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'Hello',
        selection: TextSelection.collapsed(offset: 5),
        composing: TextRange(start: 0, end: 5),
      ),
    );
    await tester.pump();

    final editor = tester.widget<TextField>(composer).controller!;

    await tester.tap(find.byKey(const ValueKey('send')));
    await tester.pump();

    expect(transport.calls, ['send:send-1']);
    expect(transport.sentTexts, ['Hello']);
    expect(editor.text, isEmpty);
    expect(jsonDecode(store.values[controller.key]!)['draft'], '');

    // A second tap on the same composer must not re-send the same words.
    await tester.tap(find.byKey(const ValueKey('send')));
    await tester.pump();
    expect(transport.calls, ['send:send-1']);

    // Committing with Enter and then deleting that newline must not be a
    // prerequisite for Send. Gboard resumes composing the last word after the
    // deletion, which is the exact sequence seen on the physical phone.
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'Hello\n',
        selection: TextSelection.collapsed(offset: 6),
      ),
    );
    await tester.pump();
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'Hello',
        selection: TextSelection.collapsed(offset: 5),
        composing: TextRange(start: 0, end: 5),
      ),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('send')));
    await tester.pump();
    expect(transport.calls, ['send:send-1', 'send:send-2']);
    expect(transport.sentTexts, ['Hello', 'Hello']);
    expect(editor.text, isEmpty);

    // Real multiline content is preserved; only the IME composing metadata is
    // reconciled after the full text has entered the send path.
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'Hello\nworld',
        selection: TextSelection.collapsed(offset: 11),
        composing: TextRange(start: 6, end: 11),
      ),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('send')));
    await tester.pump();
    expect(transport.calls, ['send:send-1', 'send:send-2', 'send:send-3']);
    expect(transport.sentTexts, ['Hello', 'Hello', 'Hello\nworld']);
    expect(editor.text, isEmpty);

    transport.completion.complete();
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });
  testWidgets(
    'an IME resuming composition mid-send cannot leave the words to be sent twice',
    (tester) async {
      final store = GatedStore();
      final transport = FakeTransport(store);
      var sends = 0;
      final controller = ChatController(
        transport: transport,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-${sends += 1}',
      );
      await controller.initialize();
      controller.connection = ConnectionState.connected;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ChatPane(controller: controller, onReconnect: () async {}),
          ),
        ),
      );
      final composer = find.byKey(const ValueKey('composer'));
      await tester.tap(composer);
      await tester.pump();
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'Hello',
          selection: TextSelection.collapsed(offset: 5),
          composing: TextRange(start: 0, end: 5),
        ),
      );
      await tester.pump();
      final editor = tester.widget<TextField>(composer).controller!;

      // Hold the durable write open: everything below happens inside the
      // window the send spends waiting on it.
      final persisting = Completer<void>();
      store.gate = persisting;
      await tester.tap(find.byKey(const ValueKey('send')));
      await tester.pump();

      // The IME re-establishes a composing range over the composer as it
      // stands, without changing its text, so no `onChanged` follows it and
      // `_update`'s composing guard is the only thing that can see it. On a
      // composer Send has already emptied there is nothing left for that
      // guard to strand; on one Send left full, these are the words a second
      // tap sent again.
      tester.testTextInput.updateEditingValue(
        editor.value.copyWith(
          composing: TextRange(start: 0, end: editor.text.length),
        ),
      );
      await tester.pump();

      store.gate = null;
      persisting.complete();
      await tester.pump();
      await tester.pump();

      expect(editor.text, isEmpty);
      expect(jsonDecode(store.values[controller.key]!)['draft'], '');

      await tester.tap(find.byKey(const ValueKey('send')));
      await tester.pump();
      expect(transport.calls, ['send:send-1']);
      expect(transport.sentTexts, ['Hello']);

      transport.completion.complete();
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );
  testWidgets(
    'a send that could not be saved hands the words back to the composer even '
    'with an IME range over it',
    (tester) async {
      final store = GatedStore();
      final transport = FakeTransport(store);
      final controller = ChatController(
        transport: transport,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-1',
      );
      await controller.initialize();
      controller.connection = ConnectionState.connected;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ChatPane(controller: controller, onReconnect: () async {}),
          ),
        ),
      );
      final composer = find.byKey(const ValueKey('composer'));
      await tester.tap(composer);
      await tester.pump();
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'Hello',
          selection: TextSelection.collapsed(offset: 5),
          composing: TextRange(start: 0, end: 5),
        ),
      );
      await tester.pump();
      final editor = tester.widget<TextField>(composer).controller!;

      final persisting = Completer<void>();
      store.gate = persisting;
      await tester.tap(find.byKey(const ValueKey('send')));
      await tester.pump();
      expect(editor.text, isEmpty);

      // The IME lays a composing range over the emptied composer, as Gboard
      // does over whatever it can still see. Nothing here changes the text,
      // so this range is all the pane has to go on when the words come back.
      tester.testTextInput.updateEditingValue(
        editor.value.copyWith(composing: const TextRange(start: 0, end: 0)),
      );
      await tester.pump();

      // The durable write fails, so the send is refused before it reaches the
      // transport and the words are handed back to the draft.
      store.fail = true;
      store.gate = null;
      persisting.complete();
      await tester.pump();
      await tester.pump();

      expect(transport.calls, isEmpty);
      expect(editor.text, 'Hello');
      expect(controller.draft, 'Hello');

      // The keyboard is still up on the restored words, so typing has to carry
      // on after them rather than at an offset the IME picks for itself.
      expect(editor.selection, const TextSelection.collapsed(offset: 5));

      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );
  testWidgets('send clears the draft and reconciles the pending bubble by ID', (
    tester,
  ) async {
    final store = MemoryStore();
    final transport = FakeTransport(store);
    final controller = ChatController(
      transport: transport,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
      nextId: () => 'send-1',
    );
    await controller.initialize();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ChatPane(controller: controller, onReconnect: () async {}),
        ),
      ),
    );
    final composer = find.byKey(const ValueKey('composer'));
    String draft() => tester.widget<TextField>(composer).controller!.text;
    Finder bubbles() => find.byWidgetPredicate(
      (widget) =>
          (widget is SelectableText && widget.data == 'Hello') ||
          (widget is Text && widget.data == 'Hello'),
    );
    await tester.enterText(composer, 'Hello');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('send')));
    await tester.pump();
    expect(draft(), isEmpty);
    expect(bubbles(), findsOneWidget);
    expect(jsonDecode(store.values[controller.key]!)['draft'], '');
    expect(
      (jsonDecode(store.values[controller.key]!)['pending'] as List)
          .last['text'],
      'Hello',
    );

    // Identical text from another Turn must not hide this submission.
    transport.observed = {...running(), 'runId': 'other'};
    await controller.invalidate();
    await tester.pump();
    expect(bubbles(), findsNWidgets(2));
    expect(controller.visiblePendingText, 'Hello');
    expect(transport.calls, ['send:send-1']);

    // A new draft may even repeat the submitted text.
    await tester.enterText(composer, 'Hello');
    transport.observed = running();
    await controller.invalidate();
    await tester.pump(const Duration(seconds: 1));
    expect(bubbles(), findsNWidgets(2));
    expect(controller.visiblePendingText, isNull);
    expect(draft(), 'Hello');
    expect(transport.calls, ['send:send-1']);

    transport.completion.complete();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(draft(), 'Hello');
    expect(controller.pending, isEmpty);
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });

  /// The composer never closes over a running Turn.
  ///
  /// "Do this instead" is a thing a person means, and the send route admits it
  /// on explicit supersede intent. The gate this replaces — no send while a
  /// submission was unconfirmed — kept the composer shut for the whole of a
  /// Turn, because the POST does not answer until the Turn settles. That made
  /// the one path with the intent unreachable from the one surface that has it.
  test('a second message may be sent while the first Turn runs', () async {
    final store = MemoryStore();
    final transport = FakeTransport(store)..observed = running();
    var next = 0;
    final controller = ChatController(
      transport: transport,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
      nextId: () => 'send-${next += 1}',
    );
    await controller.initialize();
    expect(controller.runningRunId, 'send-1');

    final first = controller.send('first');
    await Future<void>.delayed(Duration.zero);
    // Still open: a submission in flight is not a closed composer.
    expect(controller.sending, isTrue);
    expect(controller.canSend, isTrue);

    final second = controller.send('second');
    await Future<void>.delayed(Duration.zero);
    expect(
      [for (final entry in controller.pending) entry.text],
      ['first', 'second'],
    );
    // Both carry the run this client had observed, which is what makes the
    // Bot replace what it was doing rather than refuse.
    expect(transport.superseded, ['send-1', 'send-1']);

    transport.completion.complete();
    await first;
    await second;
    expect(controller.sending, isFalse);
    controller.dispose();
  });

  test(
    'failed delivery restores the submission without losing the next draft',
    () async {
      final store = MemoryStore();
      final transport = FakeTransport(store)..loseReply = true;
      final controller = ChatController(
        transport: transport,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-1',
      );
      await controller.initialize();
      final sending = controller.send('Hello');
      await Future<void>.delayed(Duration.zero);
      await controller.saveDraft('Next message');
      transport.completion.complete();
      await sending;
      expect(controller.draft, 'Hello\n\nNext message');
      expect(
        jsonDecode(store.values[controller.key]!)['draft'],
        controller.draft,
      );
      expect(controller.pending, isEmpty);
      controller.dispose();
    },
  );

  testWidgets('reconnect and widget disposal never send or stop work', (
    tester,
  ) async {
    final store = MemoryStore();
    final t = FakeTransport(store);
    final c = ChatController(
      transport: t,
      store: store,
      userId: 'user-1',
      botId: 'bot-1',
    );
    var reconnects = 0;
    c.connection = ConnectionState.disconnected;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ChatPane(
            controller: c,
            onReconnect: () async {
              reconnects++;
              await c.refresh();
            },
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('reconnect')));
    await tester.pumpAndSettle();
    expect(reconnects, 1);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    expect(t.calls, isEmpty);
  });
  test(
    'failed persistence prevents dispatch; a lost reply looks up then fences',
    () async {
      final store = MemoryStore()..fail = true;
      final t = FakeTransport(store);
      final c = ChatController(
        transport: t,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-1',
      );
      await c.initialize();
      await c.send('Hello');
      expect(t.calls, isEmpty);
      expect(c.draft, 'Hello');
      store.fail = false;
      t.loseReply = true;
      t.completion.complete();
      await c.send('Hello');
      expect(t.calls, ['send:send-1', 'lookup:send-1', 'fence:send-1']);
      expect(c.pending, isEmpty);
      expect(c.draft, 'Hello');
      c.dispose();
    },
  );
  test(
    'process reconstruction checks a saved command without retransmitting',
    () async {
      final store = MemoryStore();
      final first = FakeTransport(store);
      final c = ChatController(
        transport: first,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
        nextId: () => 'send-1',
      );
      await c.initialize();
      final send = c.send('Hello');
      await Future<void>.delayed(Duration.zero);
      c.dispose();
      final second = FakeTransport(store)..observed = running();
      final restored = ChatController(
        transport: second,
        store: store,
        userId: 'user-1',
        botId: 'bot-1',
      );
      await restored.initialize();
      expect(second.calls, ['lookup:send-1']);
      expect(restored.activeRunId, 'send-1');
      expect(restored.draft, '');
      first.observed = running();
      first.completion.complete();
      await send;
      restored.dispose();
    },
  );
}
