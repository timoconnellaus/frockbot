import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/voice/player.dart';

const channel = MethodChannel('com.frockbot/pcm');

Future<void> receipt(
  Map<Object?, Object?> args, {
  String method = 'played',
}) async {
  await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(MethodCall(method, args)),
        (_) {},
      );
  await Future<void>.delayed(Duration.zero);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late List<Map<Object?, Object?>> fed;
  late List<int> configuredRates;
  bool failSetup = false;
  bool failFeed = false;
  bool failDuringSetup = false;
  setUp(() {
    fed = [];
    configuredRates = [];
    failSetup = failFeed = failDuringSetup = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'setup' && failSetup) {
            throw PlatformException(code: 'no-device');
          }
          if (call.method == 'setup') {
            configuredRates.add((call.arguments as Map)['sampleRate'] as int);
            if (failDuringSetup) {
              failDuringSetup = false;
              await receipt({
                'epoch': (call.arguments as Map)['epoch'],
              }, method: 'failed');
            }
          }
          if (call.method == 'feed') {
            if (failFeed) throw PlatformException(code: 'rejected');
            fed.add(Map<Object?, Object?>.from(call.arguments as Map));
          }
          return null;
        });
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null),
  );

  test(
    'handing all silent samples to the device is not a playback receipt',
    () async {
      final player = PcmVoicePlayer();
      await player.configure(24000);
      player.write(Uint8List(1600));
      await Future<void>.delayed(Duration.zero);
      expect(fed, hasLength(1));
      expect(player.playing, isTrue);
      expect(player.level, 0);
      bool? drained;
      final pending = player.drain().then((value) => drained = value);
      await Future<void>.delayed(Duration.zero);
      expect(drained, isNull);
      await receipt(fed.single);
      await pending;
      expect(drained, isTrue);
      expect(player.playing, isFalse);
      await player.close();
    },
  );

  test('every device receipt is required, including the queued tail', () async {
    final player = PcmVoicePlayer();
    await player.configure(24000);
    player.write(Uint8List(16000));
    await Future<void>.delayed(Duration.zero);
    bool? drained;
    final pending = player.drain().then((value) => drained = value);
    expect(fed, hasLength(10));
    for (var i = 0; i < 9; i++) {
      await receipt(fed[i]);
      expect(drained, isNull);
    }
    await receipt(fed[9]);
    await pending;
    expect(drained, isTrue);
    await player.close();
  });

  test(
    'interruption invalidates drains and stale receipts after rebuilding',
    () async {
      final player = PcmVoicePlayer();
      await player.configure(24000);
      player.write(Uint8List(1600));
      await Future<void>.delayed(Duration.zero);
      final old = fed.single;
      final pending = player.drain();
      await player.interrupt();
      expect(await pending, isFalse);
      player.write(Uint8List(1600));
      await Future<void>.delayed(Duration.zero);
      bool? next;
      final nextDrain = player.drain().then((value) => next = value);
      await receipt(old);
      expect(next, isNull);
      await receipt(fed.last);
      await nextDrain;
      expect(next, isTrue);
      await player.close();
    },
  );

  test(
    'a device failure while an interrupt rebuild is pending still plays',
    () async {
      final player = PcmVoicePlayer();
      await player.configure(24000);
      player.write(Uint8List(1600));
      await Future<void>.delayed(Duration.zero);
      expect(fed, hasLength(1));
      failDuringSetup = true;
      await player.interrupt();
      fed.clear();
      player.write(Uint8List(1600));
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(fed, isNotEmpty);
      bool? played;
      final pending = player.drain().then((value) => played = value);
      await receipt(fed.last);
      await pending;
      expect(played, isTrue);
      await player.close();
    },
  );

  test(
    'failed feeds and dropped held samples invalidate the delivery',
    () async {
      final player = PcmVoicePlayer();
      await player.configure(24000);
      final before = player.lossCount;
      failFeed = true;
      player.write(Uint8List(1600));
      await Future<void>.delayed(Duration.zero);
      expect(player.lossCount, greaterThan(before));
      expect(await player.drain(), isFalse);
      expect(player.playing, isFalse);
      failFeed = false;
      failSetup = true;
      player.write(Uint8List(24000 * 2 * 6));
      await Future<void>.delayed(Duration.zero);
      expect(await player.drain(), isFalse);
      await player.close();
    },
  );

  test(
    'odd sample carry prevents success until its other byte arrives',
    () async {
      final player = PcmVoicePlayer();
      await player.configure(24000);
      player.write(Uint8List(3));
      await Future<void>.delayed(Duration.zero);
      expect(await player.drain(), isFalse);
      player.write(Uint8List(1));
      await Future<void>.delayed(Duration.zero);
      final pending = player.drain();
      for (final data in fed) {
        await receipt(data);
      }
      expect(await pending, isTrue);
      await player.close();
    },
  );
  test(
    'changing rate discards old audio and rebuilds only at the new rate',
    () async {
      final player = PcmVoicePlayer();
      await player.configure(24000);
      player.write(Uint8List(1600));
      await Future<void>.delayed(Duration.zero);
      final pending = player.drain();
      await player.configure(16000);
      expect(await pending, isFalse);
      expect(configuredRates, [24000, 16000]);
      await player.close();
    },
  );

  test(
    'a receipt from a closed player cannot finish its replacement',
    () async {
      final oldPlayer = PcmVoicePlayer();
      await oldPlayer.configure(24000);
      oldPlayer.write(Uint8List(1600));
      await Future<void>.delayed(Duration.zero);
      final oldReceipt = fed.single;
      await oldPlayer.close();
      final player = PcmVoicePlayer();
      await player.configure(24000);
      player.write(Uint8List(1600));
      await Future<void>.delayed(Duration.zero);
      bool? result;
      final pending = player.drain().then((value) => result = value);
      await receipt(oldReceipt);
      expect(result, isNull);
      await receipt(fed.last);
      await pending;
      expect(result, isTrue);
      await player.close();
    },
  );
}
