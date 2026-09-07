/// Starting a new conversation, and reading an earlier one.
///
/// The Turns of the conversation just ended stay on disk and stay readable by
/// naming it, so the pane's job is only to offer both: the control that ends
/// this one, and the picker that reads back an earlier one.
library;

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/shell/chat_pane.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'widget_test.dart' show MemoryStore;

class ConversationTransport implements ChatTransport {
  final Map<String?, List<Map<String, dynamic>>> byConversation;
  final List<Object?> announcements;
  final read = <String?>[];
  ConversationTransport(this.byConversation, {this.announcements = const []});

  @override
  Future<Map<String, dynamic>> page(
    String botId, {
    String? before,
    String? conversationId,
  }) async {
    read.add(conversationId);
    return {
      'runs': byConversation[conversationId] ?? const [],
      'page': {'truncated': false},
      'announcements': announcements,
    };
  }

  @override
  Future<void> send(String botId, String id, String text) async {}
  @override
  Future<Map<String, dynamic>?> lookup(
    String botId,
    String id, {
    bool fence = false,
  }) async => null;
  @override
  Future<Map<String, dynamic>> stop(
    String botId,
    String id,
    String commandId,
  ) async => throw UnimplementedError();
}

Map<String, dynamic> turn(String runId, String input) => {
  'runId': runId,
  'admittedAt': '2026-09-05T01:00:00Z',
  'input': input,
  'status': 'completed',
  'events': <Object>[],
};

wire.Conversation conversation(String id, int ordinal) =>
    wire.Conversation.fromJson({
      'schemaVersion': 1,
      'conversationId': id,
      'ordinal': ordinal,
      'startedAt': '2026-09-05T00:00:00.000Z',
    });

Future<ChatController> pump(
  WidgetTester tester,
  ConversationTransport transport, {
  List<wire.Conversation> conversations = const [],
  Future<void> Function()? onNewConversation,
}) async {
  final store = MemoryStore();
  final controller = ChatController(
    transport: transport,
    store: store,
    userId: 'user-1',
    botId: 'bot-1',
  );
  addTearDown(controller.dispose);
  await tester.pumpWidget(
    MaterialApp(
      theme: FrockTheme.theme(Brightness.dark),
      home: Scaffold(
        body: ChatPane(
          controller: controller,
          onReconnect: () async {},
          conversations: conversations,
          onNewConversation: onNewConversation,
          onSelectConversation: (id) => controller.selectConversation(id),
        ),
      ),
    ),
  );
  await controller.initialize();
  await tester.pumpAndSettle();
  return controller;
}

void main() {
  testWidgets('New conversation is offered, and clears the transcript', (
    tester,
  ) async {
    final transport = ConversationTransport({
      null: [turn('run-1', 'The first conversation')],
    });
    var started = 0;
    ChatController? chat;
    chat = await pump(
      tester,
      transport,
      onNewConversation: () async {
        started += 1;
        transport.byConversation[null] = const [];
        await chat!.selectConversation(null);
      },
    );
    expect(find.text('The first conversation'), findsOneWidget);
    await tester.tap(find.text('New conversation'));
    await tester.pumpAndSettle();
    expect(started, 1);
    // The transcript is the conversation, so it shows the new one.
    expect(find.text('The first conversation'), findsNothing);
  });

  testWidgets('a refusal is said where the press was, and nothing is lost', (
    tester,
  ) async {
    final transport = ConversationTransport({
      null: [turn('run-1', 'still going')],
    });
    await pump(
      tester,
      transport,
      onNewConversation: () async => throw const RequestFailure(
        'This Bot is still working on a Turn.',
        409,
      ),
    );
    await tester.tap(find.text('New conversation'));
    await tester.pumpAndSettle();
    expect(find.text('This Bot is still working on a Turn.'), findsOneWidget);
    expect(find.text('still going'), findsOneWidget);
  });

  testWidgets('an earlier conversation is read back by naming it', (
    tester,
  ) async {
    final transport = ConversationTransport({
      null: [turn('run-2', 'the second conversation')],
      'c1': [turn('run-1', 'the first conversation')],
    });
    await pump(
      tester,
      transport,
      conversations: [conversation('c2', 2), conversation('c1', 1)],
      onNewConversation: () async {},
    );
    expect(find.text('the second conversation'), findsOneWidget);
    // The current conversation is the one with no name to select, so the
    // picker opens on its hint rather than on a row.
    expect(find.text('Current conversation'), findsOneWidget);
    await tester.tap(find.byType(DropdownButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Conversation 1').last);
    await tester.pumpAndSettle();
    expect(transport.read.last, 'c1');
    expect(find.text('the first conversation'), findsOneWidget);
  });

  testWidgets('the conversation\'s announcements are in the thread', (
    tester,
  ) async {
    final transport = ConversationTransport(
      {
        null: [turn('run-1', 'hello')],
      },
      announcements: [
        {
          'type': 'bot/renamed',
          'announcementId': 'announcement-1',
          'at': '2026-09-05T01:30:00.000Z',
          'from': 'Scout',
          'to': 'Test',
          'namedBy': 'user',
        },
      ],
    );
    await pump(tester, transport);
    expect(find.text('Renamed to Test by user'), findsOneWidget);
  });
}
