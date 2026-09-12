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

  test('a device that will not set up is tried again, holding five seconds '
      'of the newest audio', () async {
    var setupFails = true;
    var setups = 0;
    var fedBytes = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (call) async {
          if (call.method == 'setup') {
            setups += 1;
            if (setupFails) throw PlatformException(code: 'no-device');
          }
          if (call.method == 'feed') {
            fedBytes +=
                ((call.arguments as Map)['buffer'] as Uint8List).length;
          }
          return null;
        });
    final player = PcmVoicePlayer();
    // The first setup fails, as it does on a platform without the plugin or a
    // track another app is holding.
    await player.configure(16000);
    expect(setups, 1);
    expect(player.level, 0);

    // Ten seconds of reply arrives with nowhere to play it. Nothing is tried
    // again inside the retry window, and only the newest five seconds is kept.
    for (var second = 0; second < 10; second++) {
      player.write(_loud(16000 * 2));
    }
    await Future<void>.delayed(Duration.zero);
    expect(setups, 1, reason: 'not retried inside the window');

    // Past the window the next chunk tries the device again, and this time it
    // takes: the reply is heard rather than written off for the call.
    setupFails = false;
    await Future<void>.delayed(
      PcmVoicePlayer.retryAfter + const Duration(milliseconds: 100),
    );
    player.write(_loud(16000 * 2));
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(setups, 2);
    expect(player.level, greaterThan(0), reason: 'playing again');
    for (var i = 0; i < 400; i++) {
      await _askForMore();
    }
    // Five seconds is all that survived the wait: the older six were dropped
    // rather than queued, so what plays is the reply, not its beginning.
    expect(fedBytes, 16000 * 2 * 5);
    await player.close();
  });
}
