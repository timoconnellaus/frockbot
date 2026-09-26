import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/machines/device_host.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  setUp(() => debugDefaultTargetPlatformOverride = TargetPlatform.macOS);
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    messenger.setMockMethodCallHandler(DeviceHostController.channel, null);
  });

  Map<String, Object?> status(
    Object? arguments, {
    bool enrolled = false,
    bool declined = false,
  }) => {
    'userId': (arguments as Map)['userId'],
    'origin': hostedOrigin,
    'available': true,
    'running': true,
    'ready': true,
    'enrolled': enrolled,
    'connected': enrolled,
    'declined': declined,
    'modules': const [],
    'error': '',
  };

  test('a Mac the host reports unpaired pairs itself once', () async {
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(DeviceHostController.channel, (
      call,
    ) async {
      calls.add(call);
      return status(call.arguments, enrolled: call.method == 'pair');
    });
    final paths = <String>[];
    final api = SettingsApi(MemoryStore(), (path, _) async {
      paths.add(path);
      return {'code': 'pairing-code'};
    });
    final controller = DeviceHostController();
    await controller.configure('alice', api);
    await pumpEventQueue();
    expect(paths, ['/api/machines/pair']);
    expect(calls.map((call) => call.method), ['configure', 'pair']);
    expect(calls.last.arguments['code'], 'pairing-code');
    expect(calls.last.arguments['userId'], 'alice');
    expect(controller.enrolled, true);
    expect(controller.enrolling, false);
    controller.dispose();
  });

  test('a paired or forgotten Mac is left as it is', () async {
    for (final state in [
      (enrolled: true, declined: false),
      (enrolled: false, declined: true),
    ]) {
      final calls = <MethodCall>[];
      messenger.setMockMethodCallHandler(DeviceHostController.channel, (
        call,
      ) async {
        calls.add(call);
        return status(
          call.arguments,
          enrolled: state.enrolled,
          declined: state.declined,
        );
      });
      final paths = <String>[];
      final api = SettingsApi(MemoryStore(), (path, _) async {
        paths.add(path);
        return {'code': 'pairing-code'};
      });
      final controller = DeviceHostController();
      await controller.configure('alice', api);
      await pumpEventQueue();
      expect(paths, isEmpty);
      expect(calls.map((call) => call.method), ['configure']);
      controller.dispose();
    }
  });

  test('other platforms never reach the channel', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(DeviceHostController.channel, (
      call,
    ) async {
      calls.add(call);
      return null;
    });
    final controller = DeviceHostController();
    await controller.configure(
      'alice',
      SettingsApi(MemoryStore(), (_, _) async => null),
    );
    expect(calls, isEmpty);
    controller.dispose();
  });
}
