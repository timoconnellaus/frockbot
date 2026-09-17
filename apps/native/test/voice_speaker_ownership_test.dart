
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/player.dart';

import 'voice_fakes.dart';

const channel = MethodChannel('com.frockbot/pcm');

/// Mirrors the shared speaker both platform hosts expose on
/// `com.frockbot/pcm`: one device at a time, owned by the epoch of the most
/// recent `setup`. A command that names an epoch the host no longer owns is
/// ignored; a command that names none releases whatever device is current,
/// which is what an unqualified release did.
class FakeNativeSpeaker {
  int? owner;
  bool device = false;
  int releases = 0;
  final List<Map<Object?, Object?>> fed = [];

  Future<Object?> handle(MethodCall call) async {
    final args = Map<Object?, Object?>.from(
      (call.arguments as Map?) ?? const <Object?, Object?>{},
    );
    switch (call.method) {
      case 'setup':
        device = true;
        owner = args['epoch'] as int;
      case 'feed':
        if (args['epoch'] != owner) return null;
        if (!device) throw PlatformException(code: 'speaker');
        fed.add(args);
      case 'release':
        final epoch = args['epoch'];
        if (epoch != null && epoch != owner) return null;
        device = false;
        releases++;
    }
    return null;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FakeNativeSpeaker native;

  Future<void> played(Map<Object?, Object?> feed) async {
    await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall('played', {
              'epoch': feed['epoch'],
              'sequence': feed['sequence'],
            }),
          ),
          (_) {},
        );
    await settle();
  }

  setUp(() {
    native = FakeNativeSpeaker();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, native.handle);
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null),
  );

  test('a superseded player closing leaves the new speaker playing', () async {
    final old = PcmVoicePlayer();
    await old.configure(24000);
    // The person ends the call and the app builds the next session's player
    // while the old one's teardown is still running.
    final next = PcmVoicePlayer();
    await next.configure(24000);
    expect(native.device, isTrue);

    await old.close();

    expect(
      native.device,
      isTrue,
      reason: 'the newer owner still holds a device',
    );
    next.write(Uint8List(1600));
    await settle();
    expect(native.fed, hasLength(1));
    bool? drained;
    final pending = next.drain().then((value) => drained = value);
    await played(native.fed.single);
    await pending;
    expect(drained, isTrue);
    expect(next.lossCount, 0);
    await next.close();
  });

  test('a disposed session sends no speaker command for late audio', () async {
    final socket = FakeVoiceSocket();
    final player = PcmVoicePlayer();
    final controller = AssistantSessionController(
      openSocket: () async => socket,
      capture: FakeVoiceCapture(),
      player: player,
    );
    await controller.start();
    socket.deliver('{"type":"welcome","protocol_version":1}');
    socket.deliver('{"type":"status","status":"listening"}');
    await settle();

    controller.dispose();
    final next = PcmVoicePlayer();
    await next.configure(24000);
    final owner = native.owner;

    // Audio still in flight when the app moved on must not reach the speaker.
    socket.deliver(Uint8List(1600));
    await settle();

    expect(native.owner, owner, reason: 'no setup from the disposed session');
    expect(native.device, isTrue);
    next.write(Uint8List(1600));
    await settle();
    expect(native.fed, hasLength(1));
    await next.close();
  });
}
