/// The speaker: what the level says when the device will not take audio.
///
/// The level is not decoration — the assistant reads it to decide whether the
/// person's microphone is being sent or silenced, so a level left above zero
/// after a failed feed makes the caller inaudible for the rest of the call.
library;

import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/player.dart';

const _channel = MethodChannel('flutter_pcm_sound/methods');

Uint8List _loud(int bytes) {
  final out = Uint8List(bytes);
  final view = ByteData.sublistView(out);
  for (var i = 0; i < bytes ~/ 2; i++) {
    view.setInt16(i * 2, 12000, Endian.host);
  }
  return out;
}

/// The device asking for the next slice, which is what drives playback.
Future<void> _askForMore() async {
  await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .handlePlatformMessage(
        _channel.name,
        const StandardMethodCodec().encodeMethodCall(
          const MethodCall('OnFeedSamples', {'remaining_frames': 0}),
        ),
        (_) {},
      );
  await Future<void>.delayed(Duration.zero);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
  });

  test('a feed the device rejects leaves the speaker idle, not busy', () async {
    var feedFails = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (call) async {
          if (call.method == 'feed' && feedFails) {
            throw PlatformException(code: 'feed-failed');
          }
          return null;
        });
    final player = PcmVoicePlayer();
    await player.configure(16000);
    player.write(_loud(32000));
    await Future<void>.delayed(Duration.zero);
    expect(player.level, greaterThan(0), reason: 'audio is being heard');

    feedFails = true;
    await _askForMore();
    expect(
      player.level,
      0,
      reason: 'a slice the device never took is heard by nobody',
    );

    // And the next chunk still plays: a failed feed is not the end of the
    // call, and nothing waits on a feed callback that may never come.
    feedFails = false;
    player.write(_loud(32000));
    await Future<void>.delayed(Duration.zero);
    expect(player.level, greaterThan(0));
    await player.close();
  });
}
