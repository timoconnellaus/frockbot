/// Shorebird update discovery, the lifecycle signal that repeats it, and the
/// compact restart affordance shown once the downloaded patch is ready.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/client/plain_store.dart';
import 'package:frockbot_native/client/store.dart';
import 'package:frockbot_native/update/update_ready.dart';

class FakeUpdateService implements MobileUpdateService {
  final List<MobileUpdateStatus> statuses;
  final List<String> events;
  Completer<void>? checkGate;
  bool restartSucceeds;
  bool downloadStages;
  int checks = 0;
  int downloads = 0;
  int restarts = 0;

  FakeUpdateService({
    this.statuses = const [MobileUpdateStatus.upToDate],
    this.events = const [],
    this.restartSucceeds = true,
    this.downloadStages = true,
  });

  @override
  Future<MobileUpdateStatus> check() async {
    checks++;
    await checkGate?.future;
    return statuses[(checks - 1).clamp(0, statuses.length - 1)];
  }

  @override
  Future<bool> download() async {
    downloads++;
    return downloadStages;
  }

  @override
  Future<bool> restart() async {
    events.add('restart');
    restarts++;
    return restartSucceeds;
  }
}

Widget host(MobileUpdateController controller, {double textScale = 1}) =>
    MaterialApp(
      theme: ThemeData.dark(useMaterial3: true),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: UpdateReadyFrame(controller: controller, child: child!),
      ),
      home: const Scaffold(body: Text('conversation')),
    );

Finder byIdentifier(String identifier) => find.byWidgetPredicate(
  (widget) => widget is Semantics && widget.properties.identifier == identifier,
);

void main() {
  test('an available patch downloads on the cold-start check', () async {
    final service = FakeUpdateService(
      statuses: const [MobileUpdateStatus.outdated],
    );
    final controller = MobileUpdateController(service: service);
    addTearDown(controller.dispose);

    await controller.check();

    expect(service.checks, 1);
    expect(service.downloads, 1);
    expect(controller.restartRequired, isTrue);
  });

  test('a download that stages no patch leaves the header hidden', () async {
    final service = FakeUpdateService(
      statuses: const [MobileUpdateStatus.outdated],
      downloadStages: false,
    );
    final controller = MobileUpdateController(service: service);
    addTearDown(controller.dispose);

    await controller.check();

    expect(service.downloads, 1);
    expect(controller.restartRequired, isFalse);
  });

  test('a downloaded patch is ready without another download', () async {
    final service = FakeUpdateService(
      statuses: const [MobileUpdateStatus.restartRequired],
    );
    final controller = MobileUpdateController(service: service);
    addTearDown(controller.dispose);

    await controller.check();

    expect(service.downloads, 0);
    expect(controller.restartRequired, isTrue);
  });

  testWidgets('cold start and returning from away both check for updates', (
    tester,
  ) async {
    final service = FakeUpdateService();
    final controller = MobileUpdateController(service: service);
    addTearDown(controller.dispose);

    await tester.pumpWidget(host(controller));
    await tester.pump();
    expect(service.checks, 1);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(service.checks, 1);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(service.checks, 2);
  });

  test('overlapping lifecycle checks share one updater operation', () async {
    final service = FakeUpdateService()..checkGate = Completer<void>();
    final controller = MobileUpdateController(service: service);
    addTearDown(controller.dispose);

    final first = controller.check();
    final second = controller.check();
    expect(service.checks, 1);
    service.checkGate!.complete();
    await Future.wait([first, second]);
    expect(service.checks, 1);
  });

  testWidgets(
    'the ready header is compact, accessible, and fits a narrow phone',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 640);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final service = FakeUpdateService(
        statuses: const [MobileUpdateStatus.restartRequired],
      );
      final controller = MobileUpdateController(service: service);
      addTearDown(controller.dispose);

      await tester.pumpWidget(host(controller, textScale: 2));
      await tester.pump();

      expect(find.text('Restart now'), findsOneWidget);
      expect(find.text('Your bots keep working'), findsOneWidget);
      expect(byIdentifier(ShellIds.updateReady), findsOneWidget);
      expect(byIdentifier(ShellIds.updateRestart), findsOneWidget);
      expect(tester.takeException(), isNull);
      expect(
        tester.getTopLeft(find.text('Your bots keep working')).dx,
        greaterThan(tester.getTopRight(find.text('Restart now')).dx),
      );
      expect(
        tester.getSize(byIdentifier(ShellIds.updateReady)).height,
        lessThan(200),
      );

      await tester.pumpWidget(host(controller));
      await tester.pump();
      expect(
        tester.getSize(byIdentifier(ShellIds.updateReady)).height,
        lessThan(80),
      );
    },
  );

  testWidgets('restart preserves local state before relaunching', (
    tester,
  ) async {
    final events = <String>[];
    final service = FakeUpdateService(
      statuses: const [MobileUpdateStatus.restartRequired],
      events: events,
    );
    final controller = MobileUpdateController(
      service: service,
      beforeRestart: () async => events.add('saved'),
    );
    addTearDown(controller.dispose);

    await tester.pumpWidget(host(controller));
    await tester.pump();
    await tester.tap(find.text('Restart now'));
    await tester.pump();

    expect(events, ['saved', 'restart']);
    expect(service.restarts, 1);
  });

  testWidgets('a restart refusal stays actionable and is announced', (
    tester,
  ) async {
    final service = FakeUpdateService(
      statuses: const [MobileUpdateStatus.restartRequired],
      events: <String>[],
      restartSucceeds: false,
    );
    final controller = MobileUpdateController(service: service);
    addTearDown(controller.dispose);

    await tester.pumpWidget(host(controller));
    await tester.pump();
    await tester.tap(find.text('Restart now'));
    await tester.pump();

    expect(find.text('Couldn’t restart. Try again.'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).enabled,
      isTrue,
    );
  });

  /// The relaunch has to be a native one: a full process restart on Android
  /// and a new Flutter engine on iOS. This drives the real service down to the
  /// `restart_app` platform boundary and reads the mode the plugin is asked for.
  group('the native relaunch asked of the platform', () {
    const channel = MethodChannel('restart');
    late List<MethodCall> calls;

    setUp(() {
      calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            return {'success': true, 'mode': (call.arguments as Map)['mode']};
          });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
      debugDefaultTargetPlatformOverride = null;
    });

    test('is a full process restart on Android', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      expect(await ShorebirdMobileUpdateService().restart(), isTrue);
      expect(calls.single.method, 'restartApp');
      expect((calls.single.arguments as Map)['mode'], 'process');
    });

    test('is a Flutter engine replacement on iOS', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      expect(await ShorebirdMobileUpdateService().restart(), isTrue);
      expect((calls.single.arguments as Map)['mode'], 'flutterEngine');
    });

    test('is refused off mobile instead of restarting the host', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      expect(await ShorebirdMobileUpdateService().restart(), isFalse);
      expect(calls, isEmpty);
    });
  });

  test('the restart checkpoint commits an accepted draft write', () async {
    final directory = await Directory.systemTemp.createTemp(
      'frockbot-update-checkpoint',
    );
    addTearDown(() => directory.delete(recursive: true));
    final store = PlainStore(location: () async => directory);

    unawaited(store.write('chat/user-1/bot-1', '{"draft":"still here"}'));
    await checkpointStore(store);

    final reopened = PlainStore(location: () async => directory);
    expect(await reopened.read('chat/user-1/bot-1'), '{"draft":"still here"}');
  });
}
