import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/client/transport.dart';
import 'package:frockbot_client/machines/device_host.dart';

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
    'label': 'Studio Mac',
    'version': '1.2.3',
  };

  Map<String, Object?> receipt(Object? body) => {
    'schemaVersion': 1,
    'machineId': (body as Map)['machineId'],
    'token': 'machine-token',
    'keyVersion': 1,
  };

  test('an account on another server never reaches the host', () async {
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(DeviceHostController.channel, (
      call,
    ) async {
      calls.add(call);
      return status(call.arguments);
    });
    final api = NativeApi(MemoryStore(), origin: 'https://bots.example.org');
    final controller = DeviceHostController();
    // A server supplies module code and its sandbox's reach, so one the
    // person merely signed in to cannot pair this Mac.
    await controller.configure('mallory', api);
    await pumpEventQueue();
    expect(calls, isEmpty);
    expect(controller.enrolled, false);
    api.close();
    controller.dispose();
  });

  test('a Mac the host reports unpaired enrolls itself once', () async {
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(DeviceHostController.channel, (
      call,
    ) async {
      calls.add(call);
      return status(call.arguments, enrolled: call.method == 'adopt');
    });
    final posted = <(String, Object?)>[];
    final api = SettingsApi(MemoryStore(), (path, body) async {
      posted.add((path, body));
      return receipt(body);
    });
    final controller = DeviceHostController();
    await controller.configure('alice', api);
    await pumpEventQueue();
    expect(posted.map((entry) => entry.$1), ['/api/machines/enroll']);
    final body = posted.single.$2 as Map;
    expect(body['label'], 'Studio Mac');
    expect(body['agentVersion'], '1.2.3');
    expect(body['platform'], 'macos');
    expect(body['capabilities'], isEmpty);
    expect(body.containsKey('code'), false);
    expect(calls.map((call) => call.method), ['configure', 'adopt']);
    expect(calls.last.arguments['receipt'], receipt(body));
    expect(calls.last.arguments['userId'], 'alice');
    expect(controller.enrolled, true);
    expect(controller.enrolling, false);
    controller.dispose();
  });

  test('a retry after a lost answer names the same machine', () async {
    messenger.setMockMethodCallHandler(DeviceHostController.channel, (
      call,
    ) async {
      return status(call.arguments, enrolled: call.method == 'adopt');
    });
    final machineIds = <Object?>[];
    final api = SettingsApi(MemoryStore(), (path, body) async {
      machineIds.add((body as Map)['machineId']);
      if (machineIds.length == 1) throw const RequestFailure('offline');
      return receipt(body);
    });
    final controller = DeviceHostController();
    await controller.configure('alice', api);
    await pumpEventQueue();
    expect(controller.error, isNotEmpty);
    await controller.enrol();
    expect(machineIds, hasLength(2));
    expect(machineIds.last, machineIds.first);
    expect(controller.enrolled, true);
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
      final api = SettingsApi(MemoryStore(), (path, body) async {
        paths.add(path);
        return receipt(body);
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
