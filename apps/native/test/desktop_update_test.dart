/// The desktop update: one press beside the profile takes an available release
/// through download, verification and a checkpointed restart, and every normal
/// failure leaves the running app usable and the press available again.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/shell/semantics.dart';
import 'package:frockbot_client/shell/sidebar.dart';
import 'package:frockbot_client/theme/frock_theme.dart';
import 'package:frockbot_client/update/desktop_update.dart';

class FakeDesktopUpdater implements DesktopUpdater {
  final _changes = StreamController<DesktopUpdateSnapshot>.broadcast(
    sync: true,
  );
  final List<String> events;
  DesktopUpdateSnapshot initial;
  bool installs;
  Object? installFailure;
  int checks = 0;
  int downloads = 0;
  int installCalls = 0;

  FakeDesktopUpdater({
    List<String>? events,
    this.initial = const DesktopUpdateSnapshot(),
    this.installs = true,
  }) : events = events ?? <String>[];

  void emit(
    DesktopUpdatePhase phase, {
    String? version = '1.4.0',
    bool downloaded = false,
    int received = 0,
    int? expected,
  }) => _changes.add(
    DesktopUpdateSnapshot(
      phase: phase,
      version: version,
      downloaded: downloaded,
      received: received,
      expected: expected,
    ),
  );

  @override
  Stream<DesktopUpdateSnapshot> get changes => _changes.stream;

  @override
  Future<DesktopUpdateSnapshot> current() async => initial;

  @override
  Future<void> check() async => checks++;

  @override
  Future<void> download() async {
    downloads++;
    events.add('download');
  }

  @override
  Future<bool> install() async {
    installCalls++;
    events.add('install');
    if (installFailure != null) throw installFailure!;
    return installs;
  }
}

Finder byIdentifier(String identifier) => find.byWidgetPredicate(
  (widget) => widget is Semantics && widget.properties.identifier == identifier,
);

Widget sidebar(
  DesktopUpdateController? controller, {
  VoidCallback? onProfile,
  bool phone = false,
  double width = 640,
}) {
  final list = ShellSidebar(
    phone: phone,
    bots: const [],
    profiles: const {},
    unread: const {},
    archived: const {},
    activeBotId: null,
    focusedBotId: null,
    workingBotId: null,
    loaded: true,
    showHidden: false,
    onSelect: (_) {},
    onCreateBot: () {},
    onSearch: () {},
    onProfile: onProfile ?? () {},
    onMarketplace: () {},
    onToggleHidden: () {},
    onRetry: () async {},
  );
  return MaterialApp(
    theme: FrockTheme.theme(Brightness.dark),
    home: Scaffold(
      body: SizedBox(
        width: width,
        child: controller == null
            ? list
            : DesktopUpdateScope(controller: controller, child: list),
      ),
    ),
  );
}

Future<void> settle() => Future<void>.delayed(Duration.zero);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('the update flow', () {
    test(
      'one press downloads, verifies, checkpoints and then installs',
      () async {
        final events = <String>[];
        final updater = FakeDesktopUpdater(events: events);
        final controller = DesktopUpdateController(
          updater: updater,
          beforeRestart: () async => events.add('checkpoint'),
        );
        addTearDown(controller.dispose);
        await controller.start();
        expect(controller.state, isA<NoDesktopUpdate>());
        expect(updater.checks, 1);

        updater.emit(DesktopUpdatePhase.available);
        expect(controller.state, isA<UpdateAvailable>());

        await controller.update();
        expect(updater.downloads, 1);
        updater.emit(
          DesktopUpdatePhase.downloading,
          received: 30,
          expected: 120,
        );
        final downloading = controller.state as UpdateDownloading;
        expect(downloading.progress, 0.25);

        updater.emit(DesktopUpdatePhase.preparing);
        expect(controller.state, isA<UpdatePreparing>());
        expect(events, ['download']);

        updater.emit(DesktopUpdatePhase.ready, downloaded: true);
        await settle();
        expect(events, ['download', 'checkpoint', 'install']);
        expect(controller.state, isA<UpdateRestarting>());
      },
    );

    test('a failed download is retryable and changes nothing else', () async {
      final updater = FakeDesktopUpdater();
      final controller = DesktopUpdateController(updater: updater);
      addTearDown(controller.dispose);
      await controller.start();
      updater.emit(DesktopUpdatePhase.available);
      await controller.update();
      updater.emit(DesktopUpdatePhase.downloading, received: 5, expected: 10);
      updater.emit(DesktopUpdatePhase.failed);
      expect(controller.state, isA<UpdateFailed>());
      expect(updater.installCalls, 0);

      await controller.update();
      expect(updater.downloads, 2);
      expect(controller.state, isA<UpdateDownloading>());
    });

    test('a checkpoint that fails never lets the app exit', () async {
      final updater = FakeDesktopUpdater();
      var failCheckpoint = true;
      final controller = DesktopUpdateController(
        updater: updater,
        beforeRestart: () async {
          if (failCheckpoint) throw StateError('disk full');
        },
      );
      addTearDown(controller.dispose);
      await controller.start();
      updater.emit(DesktopUpdatePhase.available);
      await controller.update();
      updater.emit(DesktopUpdatePhase.ready, downloaded: true);
      await settle();

      expect(updater.installCalls, 0);
      final ready = controller.state as UpdateReadyToRestart;
      expect(ready.restartFailed, isTrue);

      failCheckpoint = false;
      await controller.update();
      expect(updater.installCalls, 1);
      expect(updater.downloads, 1, reason: 'the staged update is reused');
    });

    test(
      'an app that did not quit offers the restart again without looping',
      () async {
        final updater = FakeDesktopUpdater();
        final controller = DesktopUpdateController(updater: updater);
        addTearDown(controller.dispose);
        await controller.start();
        updater.emit(DesktopUpdatePhase.available);
        await controller.update();
        updater.emit(DesktopUpdatePhase.ready, downloaded: true);
        await settle();
        expect(updater.installCalls, 1);

        // The platform could not terminate the app and reports it staged again.
        updater.emit(DesktopUpdatePhase.ready, downloaded: true);
        await settle();
        expect(updater.installCalls, 1);
        expect(
          (controller.state as UpdateReadyToRestart).restartFailed,
          isTrue,
        );

        updater.installs = false;
        await controller.update();
        expect(updater.installCalls, 2);
        expect(controller.state, isA<UpdateReadyToRestart>());
      },
    );

    test('a newer release replaces the offer rather than queueing', () async {
      final updater = FakeDesktopUpdater();
      final controller = DesktopUpdateController(updater: updater);
      addTearDown(controller.dispose);
      await controller.start();
      updater.emit(DesktopUpdatePhase.available, version: '1.3.0');
      await controller.check();
      updater.emit(DesktopUpdatePhase.idle, version: null);
      updater.emit(DesktopUpdatePhase.available, version: '1.4.0');

      expect((controller.state as UpdateAvailable).version, '1.4.0');
      await controller.update();
      expect(updater.downloads, 1);
    });

    test(
      'an update staged in an earlier session restarts on one press',
      () async {
        final events = <String>[];
        final updater = FakeDesktopUpdater(
          events: events,
          initial: const DesktopUpdateSnapshot(
            phase: DesktopUpdatePhase.available,
            version: '1.4.0',
            downloaded: true,
          ),
        );
        final controller = DesktopUpdateController(
          updater: updater,
          beforeRestart: () async => events.add('checkpoint'),
        );
        addTearDown(controller.dispose);
        await controller.start();
        expect(controller.state, isA<UpdateReadyToRestart>());

        await controller.update();
        updater.emit(DesktopUpdatePhase.preparing);
        updater.emit(DesktopUpdatePhase.ready, downloaded: true);
        await settle();
        expect(events, ['download', 'checkpoint', 'install']);
      },
    );

    test('presses while work is under way are ignored', () async {
      final updater = FakeDesktopUpdater();
      final controller = DesktopUpdateController(updater: updater);
      addTearDown(controller.dispose);
      await controller.start();
      await controller.update();
      expect(updater.downloads, 0, reason: 'nothing is on offer');
      updater.emit(DesktopUpdatePhase.available);
      await controller.update();
      await controller.update();
      expect(updater.downloads, 1);
    });
  });

  group('the control beside the profile', () {
    testWidgets('draws nothing until there is an update', (tester) async {
      final updater = FakeDesktopUpdater();
      final controller = DesktopUpdateController(updater: updater);
      addTearDown(controller.dispose);
      await controller.start();

      await tester.pumpWidget(sidebar(controller));
      expect(byIdentifier(ShellIds.updateControl), findsNothing);
      expect(find.text('Update'), findsNothing);
      await tester.pumpWidget(sidebar(null));
      expect(byIdentifier(ShellIds.updateControl), findsNothing);
    });

    testWidgets('is blue, sits right of the profile, and shows each stage', (
      tester,
    ) async {
      final updater = FakeDesktopUpdater();
      final controller = DesktopUpdateController(updater: updater);
      addTearDown(controller.dispose);
      await controller.start();
      var profileOpened = 0;
      await tester.pumpWidget(
        sidebar(controller, onProfile: () => profileOpened++),
      );

      updater.emit(DesktopUpdatePhase.available);
      await tester.pump();
      final control = byIdentifier(ShellIds.updateControl);
      expect(find.text('Update'), findsOneWidget);
      final profile = tester.getRect(byIdentifier(ShellIds.sidebarProfile));
      final rect = tester.getRect(control);
      expect(rect.left, greaterThanOrEqualTo(profile.right - 1));
      expect(rect.left - profile.right, lessThan(16));
      expect((rect.center.dy - profile.center.dy).abs(), lessThan(1));
      final button = tester.widget<FilledButton>(
        find.descendant(of: control, matching: find.byType(FilledButton)),
      );
      expect(
        button.style!.backgroundColor!.resolve({}),
        DesktopUpdateButton.blue,
      );

      await tester.tap(find.text('Update'));
      await tester.pump();
      expect(updater.downloads, 1);
      updater.emit(DesktopUpdatePhase.downloading, received: 42, expected: 100);
      await tester.pump();
      expect(find.text('Downloading 42%'), findsOneWidget);

      // The app stays usable while the download runs.
      await tester.tap(byIdentifier(ShellIds.sidebarProfile));
      expect(profileOpened, 1);

      updater.emit(DesktopUpdatePhase.preparing);
      await tester.pump();
      expect(find.text('Preparing…'), findsOneWidget);

      updater.emit(DesktopUpdatePhase.failed);
      await tester.pump();
      expect(find.text('Retry update'), findsOneWidget);
      await tester.tap(find.text('Retry update'));
      await tester.pump();
      expect(updater.downloads, 2);
      expect(tester.takeException(), isNull);
    });

    testWidgets('offers the restart when the update is staged', (tester) async {
      final updater = FakeDesktopUpdater(installs: false);
      final controller = DesktopUpdateController(updater: updater);
      addTearDown(controller.dispose);
      await controller.start();
      await tester.pumpWidget(sidebar(controller));

      updater.emit(DesktopUpdatePhase.ready, downloaded: true);
      await tester.pump();
      expect(find.text('Restart to update'), findsOneWidget);
      await tester.tap(find.text('Restart to update'));
      await tester.pump();
      await tester.pump();
      expect(updater.installCalls, 1);
      expect(find.text('Retry restart'), findsOneWidget);
    });

    testWidgets('keeps its mark when the window is too narrow to read', (
      tester,
    ) async {
      final updater = FakeDesktopUpdater(installs: false);
      final controller = DesktopUpdateController(updater: updater);
      addTearDown(controller.dispose);
      await controller.start();
      await tester.pumpWidget(sidebar(controller, phone: true, width: 360));

      updater.emit(DesktopUpdatePhase.ready, downloaded: true);
      await tester.pump();
      final control = byIdentifier(ShellIds.updateControl);
      expect(control, findsOneWidget);
      expect(find.text('Restart to update'), findsNothing);
      expect(
        find.descendant(of: control, matching: find.byType(Icon)),
        findsOneWidget,
      );
      expect(tester.getRect(control).width, lessThan(64));
      expect(tester.takeException(), isNull);

      await tester.tap(control);
      await tester.pump();
      await tester.pump();
      expect(updater.installCalls, 1);

      await tester.pumpWidget(sidebar(controller));
      await tester.pump();
      expect(find.text('Retry restart'), findsOneWidget);
    });

    testWidgets('returning to a hidden app looks for a newer release', (
      tester,
    ) async {
      final updater = FakeDesktopUpdater();
      final controller = DesktopUpdateController(updater: updater);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        DesktopUpdateFrame(controller: controller, child: const SizedBox()),
      );
      await tester.pump();
      expect(updater.checks, 1);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(updater.checks, 1);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(updater.checks, 2);
    });
  });

  group('the macOS channel', () {
    const channel = MethodChannel('com.frockbot/update');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    tearDown(() => messenger.setMockMethodCallHandler(channel, null));

    test('reads the native state and follows its changes', () async {
      final calls = <String>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        return switch (call.method) {
          'state' => {
            'phase': 'downloading',
            'version': '1.4.0',
            'received': 50,
            'expected': 200,
          },
          'install' => true,
          _ => null,
        };
      });
      final updater = MacDesktopUpdater();
      final snapshot = await updater.current();
      expect(snapshot.phase, DesktopUpdatePhase.downloading);
      expect(snapshot.expected, 200);
      await updater.download();
      expect(await updater.install(), isTrue);
      expect(calls, ['state', 'download', 'install']);

      final next = updater.changes.first;
      await messenger.handlePlatformMessage(
        channel.name,
        channel.codec.encodeMethodCall(
          const MethodCall('state', {'phase': 'ready', 'version': '1.4.0'}),
        ),
        (_) {},
      );
      expect((await next).phase, DesktopUpdatePhase.ready);
    });

    test('a host without the updater offers nothing', () async {
      final updater = MacDesktopUpdater();
      expect((await updater.current()).phase, DesktopUpdatePhase.idle);
      await updater.check();
      expect(await updater.install(), isFalse);
    });

    test('an unknown phase from a newer native side reads as idle', () {
      expect(
        DesktopUpdateSnapshot.decode({'phase': 'teleporting'}).phase,
        DesktopUpdatePhase.idle,
      );
    });
  });
}
