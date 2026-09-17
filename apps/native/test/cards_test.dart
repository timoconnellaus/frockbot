import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/cards/catalog.dart';
import 'package:frockbot_native/cards/chat_card.dart';
import 'package:frockbot_native/cards/client.dart';
import 'package:frockbot_native/cards/frock_catalog/frock_catalog.dart';
import 'package:frockbot_native/cards/frock_catalog/schemas.dart';
import 'package:frockbot_native/cards/surface.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/shell/transcript_model.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/view/embed.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// One card as the read route answers it: the email draft ADR 0030 opens with,
/// in the Frock catalog, with the standard catalog's Column holding it.
Map<String, Object?> cardJson({
  String surfaceId = 'draft-1',
  int revision = 1,
  List<Map<String, Object?>>? components,
  Map<String, Object?>? dataModel,
  String? refusal,
  bool deleted = false,
  bool sendDataModel = false,
}) => {
  'schemaVersion': 1,
  'surfaceId': surfaceId,
  'revision': revision,
  'components':
      components ??
      [
        {
          'id': 'root',
          'component': 'Column',
          'children': ['heading', 'rows', 'body', 'actions'],
        },
        {
          'id': 'heading',
          'component': 'StatusPill',
          'label': 'Ready to send',
          'tone': 'ready',
        },
        {
          'id': 'rows',
          'component': 'KeyValueRows',
          'rows': [
            {'label': 'To', 'value': 'nick@example.com'},
            {'label': 'Subject', 'value': 'Following up'},
          ],
        },
        {
          'id': 'body',
          'component': 'CollapsibleText',
          'text': {'path': '/body'},
          'collapsedLines': 2,
        },
        {'id': 'actions', 'component': 'ApprovalActions', 'approvalId': 'ap-1'},
      ],
  'dataModel': dataModel ?? {'body': 'Hi Nick — following up on the thread.'},
  'createdAt': '2026-09-17T00:00:00.000Z',
  'updatedAt': '2026-09-17T00:00:00.000Z',
  'catalogId': frockCatalogIdV1,
  'sendDataModel': sendDataModel,
  'deleted': ?(deleted ? true : null),
  'refusal': ?refusal,
};

/// A card the person types into: the standard catalog's `TextField` bound to
/// the data model, with the approval buttons under it. What is typed lives in
/// the renderer's data model and never in the record.
Map<String, Object?> replyCardJson({int revision = 1}) => cardJson(
  revision: revision,
  sendDataModel: true,
  components: [
    {
      'id': 'root',
      'component': 'Column',
      'children': ['reply', 'actions'],
    },
    {
      'id': 'reply',
      'component': 'TextField',
      'value': {'path': '/reply'},
      'label': 'Reply',
    },
    {'id': 'actions', 'component': 'ApprovalActions', 'approvalId': 'ap-1'},
  ],
  dataModel: {'reply': ''},
);

Widget host(SettingsApi api, {String surfaceId = 'draft-1'}) => MaterialApp(
  theme: FrockTheme.theme(Brightness.dark),
  home: Scaffold(
    body: CardChatScope(
      api: api,
      botId: 'bot-1',
      child: CardChatCard(surfaceId: surfaceId),
    ),
  ),
);

/// Optional review artifact, kept outside the repository:
/// `--dart-define=CARD_VISUAL_OUTPUT=<dir>`.
const cardVisualOutput = String.fromEnvironment('CARD_VISUAL_OUTPUT');

/// The app's own typeface, so a captured card is read rather than measured.
/// `flutter test` draws every glyph as a block otherwise.
Future<void> loadInter() async {
  final loader = FontLoader('Inter');
  for (final weight in [400, 500, 600, 700]) {
    loader.addFont(
      File('assets/fonts/inter-latin-$weight.ttf')
          .readAsBytes()
          .then((bytes) => ByteData.view(Uint8List.fromList(bytes).buffer)),
    );
  }
  await loader.load();
}

Future<void> capture(WidgetTester tester, String name) async {
  const output = cardVisualOutput;
  if (output.isEmpty) return;
  await tester.runAsync(() async {
    final boundary = tester.firstRenderObject(
      find.byType(RepaintBoundary),
    ) as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  group('the catalog', () {
    test('holds the standard eighteen and the Frock family', () {
      expect(cardComponentNamesV1, contains('Text'));
      expect(cardComponentNamesV1, contains('Button'));
      for (final name in frockCatalogSchemasV1.keys) {
        expect(cardComponentNamesV1, contains(name));
      }
      expect(cardCatalogV1.matchesId(frockCatalogIdV1), isTrue);
      // A surface created under the standard catalog still finds these.
      expect(
        cardCatalogV1.matchesId(
          'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
        ),
        isTrue,
      );
    });

    test('every Frock component states its schema once, in the Dart', () {
      expect(frockCatalogItemsV1.length, frockCatalogSchemasV1.length);
      for (final item in frockCatalogItemsV1) {
        final declared = frockCatalogSchemasV1[item.name]!;
        final built = item.dataSchema.value;
        expect(built['properties'], isA<Map<String, Object?>>());
        for (final property
            in (declared['properties']! as Map<String, Object?>).keys) {
          expect(
            (built['properties']! as Map<String, Object?>).keys,
            contains(property),
          );
        }
      }
    });
  });

  group('the translation', () {
    test('a 1.0 record becomes the three messages v0.9 speaks', () {
      final messages = cardMessagesV1(
        CardView.fromJson(
          cardJson()..['surfaceProperties'] = {'primaryColor': '#db4b6d'},
        ),
      );
      expect(messages.length, 3);
      for (final message in messages) {
        expect(message['version'], 'v0.9');
      }
      final create = messages.first['createSurface']! as Map<String, Object?>;
      expect(create['surfaceId'], 'draft-1');
      expect(create['catalogId'], frockCatalogIdV1);
      // 1.0 calls it `surfaceProperties`; the renderer calls it `theme`.
      expect(create['theme'], {'primaryColor': '#db4b6d'});
      expect(create.containsKey('surfaceProperties'), isFalse);
      // v0.9's createSurface carries no content at all.
      expect(create.containsKey('components'), isFalse);
      expect(create.containsKey('dataModel'), isFalse);
      expect(
        (messages[1]['updateComponents']! as Map)['components'],
        hasLength(5),
      );
      expect((messages[2]['updateDataModel']! as Map)['value'], {
        'body': 'Hi Nick — following up on the thread.',
      });
    });

    test(
      'a catalog this build does not register falls back to the Frock one',
      () {
        final messages = cardMessagesV1(
          CardView.fromJson(
            cardJson()..['catalogId'] = 'https://elsewhere/x.json',
          ),
        );
        expect(
          (messages.first['createSurface']! as Map)['catalogId'],
          frockCatalogIdV1,
        );
      },
    );
  });

  group('admission', () {
    void refuses(Map<String, Object?> json, String said) {
      expect(
        () => admitCardV1(CardView.fromJson(json)),
        throwsA(
          isA<CardRefusal>().having(
            (e) => e.message,
            'message',
            contains(said),
          ),
        ),
      );
    }

    test('a drawable card is admitted', () {
      expect(() => admitCardV1(CardView.fromJson(cardJson())), returnsNormally);
    });

    test('a refusal on the record is the words the host says', () {
      refuses(
        cardJson(refusal: 'this Session is full of cards'),
        'this Session is full of cards',
      );
    });

    test('a withdrawn surface is not drawn', () {
      refuses(cardJson(deleted: true), 'withdrawn');
    });

    test('a component this build has not compiled in refuses the surface', () {
      refuses(
        cardJson(
          components: [
            {'id': 'root', 'component': 'PaymentForm'},
          ],
        ),
        'PaymentForm',
      );
    });

    test('a surface past the component budget is refused whole', () {
      refuses(
        cardJson(
          components: [
            {
              'id': 'root',
              'component': 'Column',
              'children': [for (var i = 0; i < 128; i++) 'text-$i'],
            },
            for (var i = 0; i < 128; i++)
              {'id': 'text-$i', 'component': 'Text', 'text': 'x'},
          ],
        ),
        'more parts than',
      );
    });

    test('a surface past the action budget is refused whole', () {
      refuses(
        cardJson(
          components: [
            {
              'id': 'root',
              'component': 'Column',
              'children': [for (var i = 0; i < 33; i++) 'b-$i'],
            },
            for (var i = 0; i < 33; i++)
              {
                'id': 'b-$i',
                'component': 'Button',
                'child': 'root',
                // The renderer's own spelling, which is what raises a press.
                'action': {
                  'event': {'name': 'press-$i'},
                },
              },
          ],
        ),
        'more actions than',
      );
    });

    test('a data model past its budget is refused whole', () {
      refuses(cardJson(dataModel: {'body': 'x' * 16001}), 'more data than');
    });

    test('media over an insecure link refuses the surface', () {
      refuses(
        cardJson(
          components: [
            {'id': 'root', 'component': 'Image', 'url': 'http://example/a.png'},
          ],
        ),
        'insecure link',
      );
      expect(
        () => admitCardV1(
          CardView.fromJson(
            cardJson(
              components: [
                {
                  'id': 'root',
                  'component': 'Image',
                  'url': 'https://example/a.png',
                },
              ],
            ),
          ),
        ),
        returnsNormally,
      );
    });

    test('a surface with no root has nothing to mount', () {
      refuses(
        cardJson(
          components: [
            {'id': 'stem', 'component': 'Text', 'text': 'x'},
          ],
        ),
        'no root part',
      );
    });
  });

  group('the transcript', () {
    TranscriptLine line(String id, String surfaceId, String at) =>
        TranscriptLine(
          id: id,
          runId: id,
          role: LineRole.assistant,
          text: '',
          status: LineStatus.completed,
          at: at,
          sends: [
            SendPayloadLine({'type': 'card', 'surfaceId': surfaceId}),
          ],
        );

    test('a later send naming the same surface adds no second card', () {
      final ordered = orderTranscript([
        line('a', 'draft-1', '2026-09-17T00:00:00.000Z'),
        line('b', 'draft-1', '2026-09-17T00:01:00.000Z'),
        line('c', 'draft-2', '2026-09-17T00:02:00.000Z'),
      ], '2026-09-17T01:00:00.000Z');
      expect(ordered.length, 3);
      expect(ordered[0].sends, hasLength(1));
      // The card stays where it was first drawn; the second send has nothing
      // of its own left to draw.
      expect(ordered[1].sends, isEmpty);
      expect(ordered[1].empty, isTrue);
      expect(ordered[2].sends, hasLength(1));
    });

    test('other sends on the same line are kept', () {
      final mixed = TranscriptLine(
        id: 'a',
        runId: 'a',
        role: LineRole.assistant,
        text: '',
        status: LineStatus.completed,
        at: '2026-09-17T00:01:00.000Z',
        sends: [
          SendPayloadLine({'type': 'text', 'text': 'Here it is'}),
          SendPayloadLine({'type': 'card', 'surfaceId': 'draft-1'}),
        ],
      );
      final ordered = orderTranscript([
        line('z', 'draft-1', '2026-09-17T00:00:00.000Z'),
        mixed,
      ], '2026-09-17T01:00:00.000Z');
      expect(ordered[1].sends, hasLength(1));
      expect(ordered[1].sends.single.type, 'text');
    });
  });

  group('the card in the thread', () {
    testWidgets('draws the surface it read', (tester) async {
      final api = SettingsApi(MemoryStore(), (path, body) async {
        expect(path, '/api/bots/bot-1/cards/draft-1');
        return cardJson();
      });
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      expect(find.text('Ready to send'), findsOneWidget);
      expect(find.text('nick@example.com'), findsOneWidget);
      expect(find.text('Approve'), findsOneWidget);
      expect(find.byType(ViewRegion), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a refused record draws the host region, never half a card', (
      tester,
    ) async {
      final api = SettingsApi(
        MemoryStore(),
        (path, body) async => cardJson(
          components: [
            {'id': 'root', 'component': 'PaymentForm'},
          ],
        ),
      );
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      expect(find.byType(ViewRegion), findsOneWidget);
      expect(find.text('This card can’t be shown'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a press posts one command and redraws from the receipt', (
      tester,
    ) async {
      final posts = <Map<String, Object?>>[];
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) return cardJson();
        posts.add((body as Map).cast<String, Object?>());
        return {
          'schemaVersion': 1,
          'routed': 'approval',
          'card': cardJson(
            revision: 2,
            components: [
              {
                'id': 'root',
                'component': 'Receipt',
                'title': 'Following up',
                'status': 'Sent',
                'summary': 'Sent to nick@example.com',
              },
            ],
          ),
        };
      });
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(1));
      final sent = posts.single;
      expect(sent['surfaceId'], 'draft-1');
      expect(sent['revision'], 1);
      expect((sent['event']! as Map)['name'], 'approval/ap-1');
      // The kernel's own vocabulary: `cardAction` in app/cards/bot.ts refuses
      // any decision that is not literally `approved` or `denied`, the two
      // answers `ApprovalUserDecisionV1` records.
      expect(
        ((sent['event']! as Map)['context']! as Map)['decision'],
        'approved',
      );
      expect(sent['commandId'], isA<String>());
      // Not sent: the surface was not created with `sendDataModel`.
      expect(sent.containsKey('dataModel'), isFalse);
      expect(find.text('Sent'), findsOneWidget);
      expect(find.text('Sent to nick@example.com'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a stale press re-reads the card and says so', (tester) async {
      var revision = 1;
      var reads = 0;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) {
          reads++;
          return cardJson(revision: revision);
        }
        revision = 2;
        throw const RequestFailure('That action could not be completed.', 409);
      });
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      expect(reads, 1);
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(reads, 2);
      expect(
        find.text('This card changed. It has been refreshed.'),
        findsOneWidget,
      );
      // The card is still there, drawn at the revision it now holds.
      expect(find.text('Ready to send'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a press retried after a lost answer is the same command', (
      tester,
    ) async {
      final posts = <Map<String, Object?>>[];
      var deliver = false;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) return cardJson();
        posts.add((body as Map).cast<String, Object?>());
        if (!deliver) {
          throw const RequestFailure('The connection dropped.', 0);
        }
        return {
          'schemaVersion': 1,
          'routed': 'approval',
          'card': cardJson(revision: 2),
        };
      });
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(find.text('The connection dropped.'), findsOneWidget);
      deliver = true;
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(2));
      // The kernel sees one command, so a lost answer cannot record the
      // decision twice.
      expect(posts[1]['commandId'], posts[0]['commandId']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a re-read card starts the next press as its own command', (
      tester,
    ) async {
      final posts = <Map<String, Object?>>[];
      var revision = 1;
      var deliver = false;
      final invalidations = ValueNotifier<int>(0);
      addTearDown(invalidations.dispose);
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) return cardJson(revision: revision);
        posts.add((body as Map).cast<String, Object?>());
        if (!deliver) throw const RequestFailure('The connection dropped.', 0);
        return {
          'schemaVersion': 1,
          'routed': 'approval',
          'card': cardJson(revision: revision),
        };
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: CardChatScope(
              api: api,
              botId: 'bot-1',
              invalidations: invalidations,
              child: const CardChatCard(surfaceId: 'draft-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(find.text('The connection dropped.'), findsOneWidget);
      // The surface moved on: the card is read again at its new revision, so
      // the next press is a new decision and not a repeat of the lost one.
      revision = 2;
      invalidations.value++;
      await tester.pumpAndSettle();
      deliver = true;
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(2));
      expect(posts[1]['revision'], 2);
      expect(posts[1]['commandId'], isNot(posts[0]['commandId']));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a re-read that has not moved keeps the lost command id', (
      tester,
    ) async {
      final posts = <Map<String, Object?>>[];
      var deliver = false;
      final invalidations = ValueNotifier<int>(0);
      addTearDown(invalidations.dispose);
      final api = SettingsApi(MemoryStore(), (path, body) async {
        // The surface never moves: an input-routed press is enqueued against
        // its `pressId` and the card comes back unchanged.
        if (body == null) return cardJson();
        posts.add((body as Map).cast<String, Object?>());
        if (!deliver) throw const RequestFailure('The connection dropped.', 0);
        return {
          'schemaVersion': 1,
          'routed': 'approval',
          'card': cardJson(revision: 2),
        };
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: CardChatScope(
              api: api,
              botId: 'bot-1',
              invalidations: invalidations,
              child: const CardChatCard(surfaceId: 'draft-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(find.text('The connection dropped.'), findsOneWidget);
      // A notice re-reads the card at the revision it was already at, which
      // proves nothing about the lost press, so the id is still owed.
      invalidations.value++;
      await tester.pumpAndSettle();
      deliver = true;
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(2));
      expect(posts[1]['commandId'], posts[0]['commandId']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a different press after a lost answer is a new command', (
      tester,
    ) async {
      final posts = <Map<String, Object?>>[];
      var deliver = false;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) return cardJson();
        posts.add((body as Map).cast<String, Object?>());
        if (!deliver) throw const RequestFailure('The connection dropped.', 0);
        return {
          'schemaVersion': 1,
          'routed': 'approval',
          'card': cardJson(revision: 2),
        };
      });
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(find.text('The connection dropped.'), findsOneWidget);
      // Both buttons dispatch one action name and differ only by the decision
      // they carry. Deciding the other way is a different press, so it must
      // not borrow the lost id: the kernel drops a command id it has already
      // seen without reading it, which would lose this decision in silence.
      deliver = true;
      await tester.tap(find.text('Decline'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(2));
      expect(
        (posts[1]['event']! as Map)['context'],
        containsPair('decision', 'denied'),
      );
      expect(posts[1]['commandId'], isNot(posts[0]['commandId']));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a refused press says why, from the receipt', (tester) async {
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) return cardJson();
        return {
          'schemaVersion': 1,
          'routed': 'plugin',
          'card': cardJson(revision: 2),
          'failure': 'the plugin handler stopped without saying why',
        };
      });
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(
        find.text('the plugin handler stopped without saying why'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a surface that asked for its data model gets it', (
      tester,
    ) async {
      Map<String, Object?>? sent;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) return cardJson(sendDataModel: true);
        sent = (body as Map).cast<String, Object?>();
        return {
          'schemaVersion': 1,
          'routed': 'input',
          'card': cardJson(revision: 2, sendDataModel: true),
        };
      });
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(sent!['dataModel'], {
        'body': 'Hi Nick — following up on the thread.',
      });
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a state-channel notice re-reads the surface', (tester) async {
      var reads = 0;
      final invalidations = ValueNotifier<int>(0);
      addTearDown(invalidations.dispose);
      final api = SettingsApi(MemoryStore(), (path, body) async {
        reads++;
        return cardJson(revision: reads);
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: CardChatScope(
              api: api,
              botId: 'bot-1',
              invalidations: invalidations,
              child: const CardChatCard(surfaceId: 'draft-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(reads, 1);
      invalidations.value++;
      await tester.pumpAndSettle();
      expect(reads, 2);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a receipt carrying the record back unchanged frees the card', (
      tester,
    ) async {
      final posts = <Map<String, Object?>>[];
      var held = Completer<Object?>();
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) return cardJson();
        posts.add((body as Map).cast<String, Object?>());
        // Deciding an approval never folds the card, so the route answers with
        // the record exactly as it was drawn. Held open so that the card is
        // actually drawn frozen before the receipt lands.
        await held.future;
        return {'schemaVersion': 1, 'routed': 'approval', 'card': cardJson()};
      });
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(1));
      expect(find.text('Working\u2026'), findsOneWidget);
      held.complete();
      await tester.pumpAndSettle();
      // The card is given back to the person rather than left dimmed and
      // deaf: the buttons say what they are, and answer.
      expect(find.text('Working\u2026'), findsNothing);
      held = Completer<Object?>()..complete();
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(2));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a refusal at the drawn revision still stops the card', (
      tester,
    ) async {
      String? refused;
      final invalidations = ValueNotifier<int>(0);
      addTearDown(invalidations.dispose);
      final api = SettingsApi(
        MemoryStore(),
        (path, body) async => cardJson(refusal: refused),
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: CardChatScope(
              api: api,
              botId: 'bot-1',
              invalidations: invalidations,
              child: const CardChatCard(surfaceId: 'draft-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Ready to send'), findsOneWidget);
      // The shell writes a refusal onto the record without folding it, so it
      // comes back at the revision already drawn. A card that has stopped
      // updating still has to say so.
      refused = 'the card exceeds 128 components';
      invalidations.value++;
      await tester.pumpAndSettle();
      expect(find.text('Ready to send'), findsNothing);
      expect(find.byType(ViewRegion), findsOneWidget);
      expect(find.text('the card exceeds 128 components'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a read still in flight never redraws over a receipt', (
      tester,
    ) async {
      final held = Completer<Object?>();
      final invalidations = ValueNotifier<int>(0);
      addTearDown(invalidations.dispose);
      var reads = 0;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) {
          reads++;
          // The first read answers at once; the one a notice starts is held
          // open so the press below overtakes it.
          if (reads == 1) return cardJson();
          return held.future;
        }
        return {
          'schemaVersion': 1,
          'routed': 'plugin',
          'card': cardJson(
            revision: 2,
            components: [
              {
                'id': 'root',
                'component': 'Receipt',
                'title': 'Following up',
                'status': 'Held',
                'summary': 'Nothing was sent.',
              },
            ],
          ),
          'failure': 'the plugin handler stopped without saying why',
        };
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: CardChatScope(
              api: api,
              botId: 'bot-1',
              invalidations: invalidations,
              child: const CardChatCard(surfaceId: 'draft-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      invalidations.value++;
      await tester.pump();
      expect(reads, 2);
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(find.text('Following up'), findsOneWidget);
      // The read was started before the press and answers after it, carrying
      // the revision the press has already moved past.
      held.complete(cardJson());
      await tester.pumpAndSettle();
      expect(find.text('Following up'), findsOneWidget);
      expect(find.text('Approve'), findsNothing);
      expect(
        find.text('the plugin handler stopped without saying why'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a notice rebuilds the surface from the record it re-read', (
      tester,
    ) async {
      final invalidations = ValueNotifier<int>(0);
      addTearDown(invalidations.dispose);
      var reads = 0;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        reads++;
        return replyCardJson();
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: FrockTheme.theme(Brightness.dark),
          home: Scaffold(
            body: CardChatScope(
              api: api,
              botId: 'bot-1',
              invalidations: invalidations,
              child: const CardChatCard(surfaceId: 'draft-1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'actually, no');
      await tester.pumpAndSettle();
      // A notice says some durable state of the Bot's moved, never which
      // record, so the card re-reads and rebuilds from what came back. The
      // known cost of having one path: what only the renderer held — the text
      // in flight — goes with the renderer it was in.
      invalidations.value++;
      await tester.pumpAndSettle();
      expect(reads, 2);
      expect(find.text('actually, no'), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('Approve'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a press carries the data model the person edited', (
      tester,
    ) async {
      Map<String, Object?>? sent;
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) return replyCardJson();
        sent = (body as Map).cast<String, Object?>();
        return {
          'schemaVersion': 1,
          'routed': 'input',
          'card': replyCardJson(revision: 2),
        };
      });
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'actually, no');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      // The typed value lives in the renderer's data model and nowhere else,
      // so the press has to read it from there.
      expect(sent!['dataModel'], {'reply': 'actually, no'});
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('a Bot-authored card, at the widths it is read at', () {
    setUpAll(() async {
      if (cardVisualOutput.isNotEmpty) await loadInter();
    });
    for (final width in [390.0, 1280.0]) {
      testWidgets('draws in the thread at $width', (tester) async {
        tester.view.physicalSize = Size(width * 2, 900 * 2);
        tester.view.devicePixelRatio = 2;
        addTearDown(tester.view.reset);
        var settled = false;
        final api = SettingsApi(MemoryStore(), (path, body) async {
          if (body != null) {
            settled = true;
            return {
              'schemaVersion': 1,
              'routed': 'approval',
              'card': cardJson(
                revision: 2,
                components: [
                  {
                    'id': 'root',
                    'component': 'Receipt',
                    'title': 'Following up',
                    'status': 'Sent',
                    'summary': 'Sent to nick@example.com — Re: Following up',
                  },
                ],
              ),
            };
          }
          return cardJson(revision: settled ? 2 : 1);
        });
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(Brightness.dark),
            home: Scaffold(
              body: Center(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(16),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 680),
                    child: CardChatScope(
                      api: api,
                      botId: 'bot-1',
                      child: const CardChatCard(surfaceId: 'draft-1'),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Ready to send'), findsOneWidget);
        await capture(tester, 'card-draft-${width.toInt()}');
        await tester.tap(find.text('Approve'));
        await tester.pumpAndSettle();
        expect(find.text('Sent'), findsOneWidget);
        await capture(tester, 'card-receipt-${width.toInt()}');
        await tester.pumpWidget(const SizedBox());
      });
    }
  });

  group('the Frock components', () {
    Future<void> draw(
      WidgetTester tester,
      List<Map<String, Object?>> components, {
      Map<String, Object?>? dataModel,
    }) async {
      final api = SettingsApi(
        MemoryStore(),
        (path, body) async =>
            cardJson(components: components, dataModel: dataModel ?? {}),
      );
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
    }

    testWidgets('StatusPill says the state in the tone the host colours', (
      tester,
    ) async {
      await draw(tester, [
        {
          'id': 'root',
          'component': 'StatusPill',
          'label': 'Sent',
          'tone': 'success',
        },
      ]);
      expect(find.text('Sent'), findsOneWidget);
      final pill = tester.widget<FrockStatusPillView>(
        find.byType(FrockStatusPillView),
      );
      expect(pill.tone.name, 'success');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('KeyValueRows draws a row per label, bound values and all', (
      tester,
    ) async {
      await draw(
        tester,
        [
          {
            'id': 'root',
            'component': 'KeyValueRows',
            'rows': [
              {'label': 'To', 'value': 'nick@example.com'},
              {
                'label': 'Subject',
                'value': {'path': '/subject'},
              },
            ],
          },
        ],
        dataModel: {'subject': 'Following up'},
      );
      expect(find.text('To'), findsOneWidget);
      expect(find.text('nick@example.com'), findsOneWidget);
      expect(find.text('Following up'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets(
      'CollapsibleText opens and closes, and offers nothing when it fits',
      (tester) async {
        await draw(tester, [
          {
            'id': 'root',
            'component': 'CollapsibleText',
            'text': List.filled(20, 'a line of the draft').join('\n'),
            'collapsedLines': 2,
          },
        ]);
        expect(find.text('Show more'), findsOneWidget);
        await tester.tap(find.text('Show more'));
        await tester.pumpAndSettle();
        expect(find.text('Show less'), findsOneWidget);

        await draw(tester, [
          {'id': 'root', 'component': 'CollapsibleText', 'text': 'One line.'},
        ]);
        expect(find.text('Show more'), findsNothing);
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets('ApprovalActions names the kernel’s action, not the card’s', (
      tester,
    ) async {
      final posts = <Map<String, Object?>>[];
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) {
          return cardJson(
            components: [
              {
                'id': 'root',
                'component': 'ApprovalActions',
                'approvalId': 'ap-9',
                'approveLabel': 'Send it',
                'declineLabel': 'Discard',
              },
            ],
          );
        }
        posts.add((body as Map).cast<String, Object?>());
        return {
          'schemaVersion': 1,
          'routed': 'approval',
          'card': cardJson(revision: 2),
        };
      });
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      expect(find.text('Send it'), findsOneWidget);
      await tester.tap(find.text('Discard'));
      await tester.pumpAndSettle();
      expect((posts.single['event']! as Map)['name'], 'approval/ap-9');
      // Decline is `denied` on the wire: the kernel records the decision, so
      // the kernel names it. See app/cards/bot.ts's approval branch.
      expect(
        ((posts.single['event']! as Map)['context']! as Map)['decision'],
        'denied',
      );
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('only the pressed approval control says it is working', (
      tester,
    ) async {
      final held = Completer<Map<String, Object?>>();
      final api = SettingsApi(MemoryStore(), (path, body) async {
        if (body == null) {
          return cardJson(
            components: [
              {
                'id': 'root',
                'component': 'ApprovalActions',
                'approvalId': 'ap-9',
                'approveLabel': 'Send it',
                'declineLabel': 'Discard',
              },
            ],
          );
        }
        return held.future;
      });
      await tester.pumpWidget(host(api));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Discard'));
      await tester.pumpAndSettle();
      // The person refused: the control they pressed is the one that is
      // working, and the one they did not press keeps its own words.
      expect(
        find.descendant(
          of: find.byType(TextButton),
          matching: find.text('Working…'),
        ),
        findsOneWidget,
      );
      expect(find.text('Send it'), findsOneWidget);
      expect(find.text('Discard'), findsNothing);
      // Both stop responding while the press is in flight.
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      expect(
        tester.widget<TextButton>(find.byType(TextButton)).onPressed,
        isNull,
      );
      held.complete({
        'schemaVersion': 1,
        'routed': 'approval',
        'card': cardJson(revision: 2),
      });
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('Receipt is the settled state: title, pill, one line', (
      tester,
    ) async {
      await draw(tester, [
        {
          'id': 'root',
          'component': 'Receipt',
          'title': 'Following up',
          'status': 'Sent',
          'summary': 'Sent to nick@example.com',
        },
      ]);
      expect(find.text('Following up'), findsOneWidget);
      expect(find.text('Sent'), findsOneWidget);
      expect(find.text('Sent to nick@example.com'), findsOneWidget);
      final pill = tester.widget<FrockStatusPillView>(
        find.byType(FrockStatusPillView),
      );
      expect(pill.tone.name, 'success');
      await tester.pumpWidget(const SizedBox());
    });
  });
}
