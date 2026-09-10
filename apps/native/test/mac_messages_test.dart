import 'dart:async';

import 'package:flutter/material.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/machines/mac_messages.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
  });
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    messenger.setMockMethodCallHandler(MacMessagesController.channel, null);
  });
  test(
    'Mac sharing begins disabled and is bound to the signed-in account',
    () async {
      final calls = <MethodCall>[];
      messenger.setMockMethodCallHandler(MacMessagesController.channel, (
        call,
      ) async {
        calls.add(call);
        return {
          'userId': call.arguments['userId'],
          'origin': hostedOrigin,
          'consent': false,
          'paired': false,
          'busy': false,
          'status': 'Stopped',
          'error': '',
        };
      });
      final controller = MacMessagesController();
      await controller.configure('alice');
      expect(calls.single.method, 'configure');
      expect(calls.single.arguments['userId'], 'alice');
      expect(controller.consent, false);
      await controller.stop('bob');
      expect(calls, hasLength(1));
      await controller.stop('alice');
      expect(calls.last.method, 'stop');
      controller.dispose();
    },
  );
  test('phone clients do not invoke the Mac bridge', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(MacMessagesController.channel, (
      call,
    ) async {
      calls.add(call);
      return null;
    });
    final controller = MacMessagesController();
    await controller.configure('alice');
    await controller.command('consent', {'allowed': true});
    expect(calls, isEmpty);
    expect(controller.supported, false);
    controller.dispose();
  });
  test(
    'a missing native bridge is a visible error, not a silent connection',
    () async {
      messenger.setMockMethodCallHandler(MacMessagesController.channel, (
        _,
      ) async {
        throw PlatformException(code: 'unavailable');
      });
      final controller = MacMessagesController();
      await controller.configure('alice');
      expect(controller.error, isNotEmpty);
      expect(controller.paired, false);
      expect(controller.busy, false);
      controller.dispose();
    },
  );
  test(
    'a delayed pairing code cannot cross a sign-out and account switch',
    () async {
      final calls = <MethodCall>[];
      messenger.setMockMethodCallHandler(MacMessagesController.channel, (
        call,
      ) async {
        calls.add(call);
        return {
          'userId': call.arguments['userId'],
          'origin': hostedOrigin,
          'consent': true,
          'paired': false,
          'busy': false,
          'status': 'Ready',
          'error': '',
        };
      });
      final controller = MacMessagesController();
      final offer = Completer<Object?>();
      final api = SettingsApi(MemoryStore(), (_, _) => offer.future);
      await controller.configure('alice');
      final connecting = controller.connect(api);
      await controller.stop('alice');
      await controller.configure('bob');
      offer.complete({'code': 'alice-code'});
      await connecting;
      expect(calls.where((call) => call.method == 'pair'), isEmpty);
      expect(controller.consent, true);
      expect(controller.busy, false);
      controller.dispose();
    },
  );

  testWidgets('Mac controls require explicit consent before connecting', (
    tester,
  ) async {
    messenger.setMockMethodCallHandler(MacMessagesController.channel, (
      call,
    ) async {
      return {
        'userId': 'alice',
        'origin': hostedOrigin,
        'consent':
            call.method == 'consent' && call.arguments['allowed'] == true,
        'paired': false,
        'busy': false,
        'status': 'Ready',
        'error': '',
      };
    });
    final controller = MacMessagesController();
    await controller.configure('alice');
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: SingleChildScrollView(
            child: MacMessagesCard(
              api: SettingsApi(MemoryStore(), (_, _) async => null),
              controller: controller,
            ),
          ),
        ),
      ),
    );
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Connect this Mac'),
          )
          .onPressed,
      isNull,
    );
    await tester.tap(find.byType(CheckboxListTile));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Connect this Mac'),
          )
          .onPressed,
      isNotNull,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    controller.dispose();
    debugDefaultTargetPlatformOverride = null;
  });
}
