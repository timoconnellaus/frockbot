import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/attachments.dart';
import 'package:frockbot_native/client/chat_controller.dart';
import 'package:frockbot_native/client/image_prep.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/shell/transcript_model.dart';

import 'widget_test.dart' show MemoryStore;

final _photo = MessageAttachment(
  uploadId: 'a' * 64,
  kind: 'image',
  name: 'beach.jpg',
  mediaType: 'image/jpeg',
  bytes: 482113,
);

final _report = MessageAttachment(
  uploadId: 'b' * 64,
  kind: 'document',
  name: 'Q3 report.pdf',
  mediaType: 'application/pdf',
  bytes: 1048576,
);

PickedFile _file(String name, [List<int> bytes = const [1, 2, 3]]) =>
    PickedFile(name: name, bytes: Uint8List.fromList(bytes));

/// Prepares a file as it is: the tests are about the tray, not the pixels.
Future<PreparedUpload> _asIs(PickedFile file) async => PreparedUpload(
  name: file.name,
  mediaType: mediaTypeForName(file.name),
  bytes: file.bytes,
  isImage: mediaTypeForName(file.name).startsWith('image/'),
);

class _Uploads implements UploadTransport {
  final uploaded = <String>[];
  final answers = <String, Completer<MessageAttachment>>{};
  bool hold = false;
  String? refuse;

  @override
  Future<MessageAttachment> upload(
    String botId, {
    required String name,
    required String mediaType,
    required Uint8List bytes,
  }) {
    uploaded.add(name);
    if (refuse != null) {
      return Future.error(RequestFailure(refuse!, 415));
    }
    final attachment = MessageAttachment(
      uploadId: name.codeUnitAt(0).toRadixString(16).padLeft(64, '0'),
      kind: mediaType.startsWith('image/') ? 'image' : 'document',
      name: name,
      mediaType: mediaType,
      bytes: bytes.length,
    );
    if (!hold) return Future.value(attachment);
    return (answers[name] = Completer<MessageAttachment>()).future;
  }

  @override
  Future<Uint8List> download(String botId, String uploadId) async =>
      Uint8List.fromList(const [9, 9, 9]);
}

class _Transport implements ChatTransport {
  final sent = <({String text, List<MessageAttachment> attachments})>[];
  RequestFailure? refusal;

  @override
  Future<Map<String, dynamic>> page(String botId, {String? before}) async => {
    'schemaVersion': 1,
    'runs': <Object>[],
    'page': {'truncated': false},
  };

  @override
  Future<void> send(
    String botId,
    String id,
    String text, {
    String? retryOf,
    List<MessageAttachment> attachments = const [],
  }) async {
    sent.add((text: text, attachments: attachments));
    if (refusal != null) throw refusal!;
  }

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

class _WireApi extends NativeApi {
  _WireApi(super.store);
  Map<String, Object?>? command;
  ({String path, Uint8List bytes, String contentType})? posted;

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    command = body as Map<String, Object?>;
    return {'schemaVersion': 1, 'runId': command!['commandId']};
  }

  @override
  Future<Object?> upload(
    String path, {
    required Uint8List bytes,
    required String contentType,
    int limit = 64000,
  }) async {
    posted = (path: path, bytes: bytes, contentType: contentType);
    return {'schemaVersion': 1, 'upload': _report.toJson()};
  }
}

void main() {
  group('the wire', () {
    test(
      'a message names its files by upload, and may be files alone',
      () async {
        final api = _WireApi(MemoryStore());
        addTearDown(api.close);
        final transport = BackendChatTransport(api);
        await transport.send('bot', 'command-1', '', attachments: [_photo]);
        expect(api.command, {
          'schemaVersion': 1,
          'commandId': 'command-1',
          'text': '',
          'attachments': [
            {'uploadId': _photo.uploadId},
          ],
        });
        // Neither words nor files is not a message the wire will carry.
        expect(
          () => wire.TurnCommand.fromJson({
            'schemaVersion': 1,
            'commandId': 'command-2',
            'text': '',
          }),
          throwsA(anything),
        );
      },
    );

    test('an upload posts the bytes with their name and type', () async {
      final api = _WireApi(MemoryStore());
      addTearDown(api.close);
      final uploaded = await BackendChatTransport(api).upload(
        'bot 1',
        name: 'Q3 report.pdf',
        mediaType: 'application/pdf',
        bytes: Uint8List.fromList(const [37, 80, 68, 70]),
      );
      expect(uploaded, _report);
      expect(uploaded.name, 'Q3 report.pdf');
      expect(api.posted!.path, '/api/bots/bot%201/uploads?name=Q3+report.pdf');
      expect(api.posted!.contentType, 'application/pdf');
    });

    test('a Run carrying files is one this client decodes', () {
      final page = wire.ConversationProjection.fromJson({
        'schemaVersion': 1,
        'runs': [
          {
            'schemaVersion': 4,
            'runId': 'run-1',
            'admittedAt': '2026-09-24T00:00:00.000Z',
            'messageRunId': 'run-1',
            'messageAdmittedAt': '2026-09-24T00:00:00.000Z',
            'canRetry': false,
            'input': '',
            'attachments': [_photo.toJson(), _report.toJson()],
            'status': 'running',
            'events': <Object>[],
          },
        ],
        'page': {'truncated': false},
      });
      final line = projectRuns([
        for (final run in page.runs) run.toJson() as Map<String, dynamic>,
      ]).firstWhere((line) => line.role == LineRole.user);
      expect(line.role, LineRole.user);
      expect(line.text, '');
      expect(line.attachments, [_photo, _report]);
    });
  });

  group('the tray', () {
    test(
      'uploads as files are attached, and holds Send until they land',
      () async {
        final uploads = _Uploads()..hold = true;
        final tray = AttachmentTray(
          upload: ({required name, required mediaType, required bytes}) =>
              uploads.upload(
                'bot',
                name: name,
                mediaType: mediaType,
                bytes: bytes,
              ),
          prepare: _asIs,
        );
        addTearDown(tray.dispose);
        tray.add([_file('beach.jpg'), _file('notes.md')]);
        await pumpEventQueue();
        expect(tray.busy, isTrue);
        expect(messageSendable('', tray), isFalse);
        expect(uploads.uploaded, ['beach.jpg', 'notes.md']);
        for (final answer in uploads.answers.values) {
          answer.complete(
            await _Uploads().upload(
              'bot',
              name: uploads
                  .uploaded[uploads.answers.values.toList().indexOf(answer)],
              mediaType: 'text/plain',
              bytes: Uint8List(1),
            ),
          );
        }
        await pumpEventQueue();
        expect(tray.busy, isFalse);
        expect(tray.ready, hasLength(2));
        expect(messageSendable('', tray), isTrue);
        expect(tray.take(), hasLength(2));
        expect(tray.isEmpty, isTrue);
      },
    );

    test('a sixth file is left out, and says so', () async {
      final tray = AttachmentTray(
        upload: ({required name, required mediaType, required bytes}) =>
            _Uploads().upload(
              'bot',
              name: name,
              mediaType: mediaType,
              bytes: bytes,
            ),
        prepare: _asIs,
      );
      addTearDown(tray.dispose);
      final notice = tray.add([
        for (final name in ['a', 'b', 'c', 'd', 'e', 'f']) _file('$name.txt'),
      ]);
      expect(notice, 'A message can carry 5 files. One was left out.');
      expect(tray.items, hasLength(5));
    });

    test(
      'a refused file carries the server’s sentence and can be tried again',
      () async {
        final uploads = _Uploads()..refuse = 'That kind of file can’t be sent.';
        final tray = AttachmentTray(
          upload: ({required name, required mediaType, required bytes}) =>
              uploads.upload(
                'bot',
                name: name,
                mediaType: mediaType,
                bytes: bytes,
              ),
          prepare: _asIs,
        );
        addTearDown(tray.dispose);
        tray.add([_file('setup.exe')]);
        await pumpEventQueue();
        final item = tray.items.single;
        expect(item.failed, isTrue);
        expect(item.error, 'That kind of file can’t be sent.');
        expect(messageSendable('', tray), isFalse);
        // Words still go; the failed file is not part of the message.
        expect(messageSendable('hello', tray), isTrue);
        uploads.refuse = null;
        tray.retry(item.id);
        await pumpEventQueue();
        expect(tray.items.single.status, AttachmentStatus.ready);
      },
    );
  });

  group('sending', () {
    ChatController controller(_Transport transport, _Uploads uploads) =>
        ChatController(
          transport: transport,
          uploads: uploads,
          prepare: _asIs,
          store: MemoryStore(),
          userId: 'user-1',
          botId: 'bot-1',
          nextId: () => 'send-1',
        );

    test('Send carries the tray’s files, alone or with words', () async {
      final transport = _Transport();
      final chat = controller(transport, _Uploads());
      addTearDown(chat.dispose);
      await chat.initialize();
      chat.attachments.add([_file('beach.jpg')]);
      await pumpEventQueue();
      await chat.send('');
      expect(transport.sent.single.text, '');
      expect(transport.sent.single.attachments.single.name, 'beach.jpg');
      expect(chat.attachments.isEmpty, isTrue);
      // The message is drawn with its file before the transcript has it.
      final run = chat.runs.single;
      expect(MessageAttachment.decodeList(run['attachments']), hasLength(1));
    });

    test('a refused message hands its files back to the tray', () async {
      final transport = _Transport()
        ..refusal = const RequestFailure(
          'One of the attached files is no longer available.',
          422,
        );
      final chat = controller(transport, _Uploads());
      addTearDown(chat.dispose);
      await chat.initialize();
      chat.attachments.add([_file('beach.jpg')]);
      await pumpEventQueue();
      await chat.send('look');
      expect(chat.draft, 'look');
      expect(chat.attachments.ready.single.name, 'beach.jpg');
      expect(chat.error, 'One of the attached files is no longer available.');
    });

    test('nothing is sent while a file is still uploading', () async {
      final transport = _Transport();
      final chat = controller(transport, _Uploads()..hold = true);
      addTearDown(chat.dispose);
      await chat.initialize();
      chat.attachments.add([_file('beach.jpg')]);
      await pumpEventQueue();
      await chat.send('look');
      expect(transport.sent, isEmpty);
    });
  });

  group('preparing a file', () {
    test('an image is known by its bytes, whatever it is called', () {
      expect(
        sniffImageType(Uint8List.fromList(const [0x89, 0x50, 0x4e, 0x47])),
        'image/png',
      );
      expect(
        sniffImageType(Uint8List.fromList(const [0xff, 0xd8, 0xff, 0xe0])),
        'image/jpeg',
      );
      expect(
        sniffImageType(
          Uint8List.fromList([0, 0, 0, 24, ...'ftypheic'.codeUnits]),
        ),
        'image/heic',
      );
      expect(sniffImageType(Uint8List.fromList('%PDF'.codeUnits)), isNull);
    });

    test('a document goes as it is', () async {
      final prepared = await prepareUploadV1(_file('report.pdf'));
      expect(prepared.isImage, isFalse);
      expect(prepared.mediaType, 'application/pdf');
      expect(prepared.name, 'report.pdf');
    });
  });

  testWidgets('the composer offers Send for files alone once they land', (
    tester,
  ) async {
    final uploads = _Uploads()..hold = true;
    final tray = AttachmentTray(
      upload: ({required name, required mediaType, required bytes}) =>
          uploads.upload('bot', name: name, mediaType: mediaType, bytes: bytes),
      prepare: _asIs,
    );
    addTearDown(tray.dispose);
    final editor = TextEditingController();
    final focus = FocusNode();
    addTearDown(editor.dispose);
    addTearDown(focus.dispose);
    var sends = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Composer(
            editor: editor,
            focus: focus,
            ready: true,
            stoppable: false,
            onSend: () async => sends += 1,
            onStop: () async {},
            onChanged: (_) {},
            skills: null,
            attachments: tray,
            onAttach: () {},
            onFiles: tray.add,
          ),
        ),
      ),
    );
    expect(find.byKey(const ValueKey('composer-attach')), findsOneWidget);
    tray.add([_file('notes.md')]);
    await tester.pump();
    expect(find.text('notes.md'), findsOneWidget);
    expect(find.text('Uploading…'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('send')));
    expect(sends, 0);

    uploads.answers['notes.md']!.complete(
      await _Uploads().upload(
        'bot',
        name: 'notes.md',
        mediaType: 'text/markdown',
        bytes: Uint8List(3),
      ),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('send')));
    expect(sends, 1);

    await tester.tap(
      find.byKey(const ValueKey('attachment-remove-attachment-0')),
    );
    await tester.pump();
    expect(find.text('notes.md'), findsNothing);
  });
}
