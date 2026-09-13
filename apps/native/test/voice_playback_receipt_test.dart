import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/protocol.dart';

import 'voice_fakes.dart';

void main() {
  late FakeVoiceSocket socket;
  late FakeVoicePlayer player;
  late AssistantSessionController controller;
  void frame(String type, [String id = 'request#1']) => socket.deliver(
    jsonEncode({'schemaVersion': 1, 'type': type, 'deliveryId': id}),
  );
  List<String> acknowledgements() =>
      socket.texts.where((s) => s.contains('voice/played')).toList();

  setUp(() async {
    socket = FakeVoiceSocket();
    player = FakeVoicePlayer();
    controller = AssistantSessionController(
      openSocket: () async => socket,
      capture: FakeVoiceCapture(),
      player: player,
    );
    await controller.start();
    socket.deliver('{"type":"welcome","protocol_version":1}');
    socket.deliver('{"type":"status","status":"listening"}');
    await settle();
  });
  tearDown(() async {
    await controller.end(reason: 'test');
    controller.dispose();
    await settle();
  });

  test(
    'silent PCM is pending until actual device drain after answer end',
    () async {
      frame('voice/answer');
      socket.deliver(Uint8List(2400));
      frame('voice/answer-end');
      await settle();
      expect(player.level, 0);
      expect(acknowledgements(), isEmpty);
      expect(socket.texts, contains(encodeVoiceSpeechV1(true)));
      player.finishPlayback();
      await settle();
      expect(acknowledgements(), [encodeVoicePlayedV1('request#1')]);
      expect(socket.texts, contains(encodeVoiceSpeechV1(false)));
      frame('voice/answer-end');
      await settle();
      expect(acknowledgements(), hasLength(1));
    },
  );

  test(
    'device draining between chunks does not finish an open answer',
    () async {
      frame('voice/answer');
      socket.deliver(Uint8List(20));
      await settle();
      player.finishPlayback();
      await settle();
      expect(acknowledgements(), isEmpty);
      socket.deliver(Uint8List(20));
      frame('voice/answer-end');
      await settle();
      expect(acknowledgements(), isEmpty);
      player.finishPlayback();
      await settle();
      expect(acknowledgements(), hasLength(1));
    },
  );

  test('no audio, empty audio and incomplete PCM never acknowledge', () async {
    for (final bytes in [0, 1]) {
      frame('voice/answer', 'request#$bytes');
      socket.deliver(Uint8List(bytes));
      frame('voice/answer-end', 'request#$bytes');
      await settle();
      player.finishPlayback();
      await settle();
    }
    expect(acknowledgements(), isEmpty);
  });

  test('interruption and a late answer-end leave the answer owed', () async {
    frame('voice/answer');
    socket.deliver(Uint8List(20));
    await settle();
    frame('playback_interrupt');
    frame('voice/answer-end');
    await settle();
    player.finishPlayback();
    await settle();
    expect(acknowledgements(), isEmpty);
  });

  test(
    'a replaced delivery and mismatched end cannot acknowledge old audio',
    () async {
      frame('voice/answer');
      socket.deliver(Uint8List(20));
      frame('voice/answer-end');
      await settle();
      frame('voice/answer', 'request#2');
      frame('voice/answer-end');
      await settle();
      player.finishPlayback();
      await settle();
      expect(acknowledgements(), isEmpty);
    },
  );

  test(
    'a disconnected call cannot send a delayed drain to the next socket',
    () async {
      frame('voice/answer');
      socket.deliver(Uint8List(20));
      frame('voice/answer-end');
      await settle();
      final old = socket;
      await socket.finish();
      await settle();
      socket = FakeVoiceSocket();
      await controller.start();
      await settle();
      player.finishPlayback();
      await settle();
      expect(old.texts.where((s) => s.contains('voice/played')), isEmpty);
      expect(acknowledgements(), isEmpty);
    },
  );

  test(
    'a quota or synthesis failure after audio does not acknowledge',
    () async {
      frame('voice/answer');
      socket.deliver(Uint8List(20));
      await settle();
      socket.deliver('{"type":"error","message":"Speech failed"}');
      frame('voice/answer-end');
      await settle();
      player.finishPlayback();
      await settle();
      expect(acknowledgements(), isEmpty);
    },
  );
}
