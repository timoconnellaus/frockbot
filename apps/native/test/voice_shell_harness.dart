import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/dictation.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'navigation_test.dart' show OfflineApi, registration;
import 'voice_fakes.dart';
import 'widget_test.dart' show MemoryStore;

/// Real shell layout and commands, with only network and audio devices faked.
class VoiceShellHarness {
  final key = GlobalKey<State<AppShell>>();
  final store = MemoryStore();
  final links = ValueNotifier<String?>(null);
  var dictationSocket = FakeVoiceSocket();
  final dictationCapture = FakeVoiceCapture();
  final callSocket = FakeVoiceSocket();
  final player = FakeVoicePlayer();
  late final api = OfflineApi(store);
  late final sessions = BotSessions(api: api, store: store);
  late DictationController dictation;
  late AssistantSessionController call;
  final reducedMotion = ValueNotifier(false);

  // The shell owns these controllers. Install the device fakes in that owner
  // so the test exercises its real footer placement, exit and draft binding.
  dynamic get shell => key.currentState!;

  Future<void> mount(
    WidgetTester tester, {
    required double width,
    required Brightness brightness,
  }) async {
    tester.view.physicalSize = Size(width, 800);
    tester.view.devicePixelRatio = 1;
    tester.view.padding = FakeViewPadding(bottom: width == 390 ? 34 : 0);
    addTearDown(tester.view.reset);
    store.values['directory/voice-user'] = jsonEncode({
      'schemaVersion': 1,
      'revision': 1,
      'bots': [registration('voice-bot', 'Rosemary')],
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(brightness),
        home: ValueListenableBuilder(
          valueListenable: reducedMotion,
          builder: (context, reduced, _) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              disableAnimations: reduced,
            ),
            child: AppShell(
              key: key,
              api: api,
              store: store,
              sessions: sessions,
              userId: 'voice-user',
              botLinks: links,
              onSignOut: () async {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('bot-voice-bot')));
    await tester.pumpAndSettle();
    final chat = sessions.open('voice-user', 'voice-bot').controller;
    dictation = DictationController(
      openSocket: () async {
        if (dictationSocket.closed) dictationSocket = FakeVoiceSocket();
        return dictationSocket;
      },
      capture: dictationCapture,
      readDraft: (_) => chat.draft,
      onDraft: (_, text) {
        chat.saveDraft(text);
        chat.changed();
      },
    );
    dictation.addListener(() => shell.setState(() {}));
    call = AssistantSessionController(
      openSocket: () async => callSocket,
      capture: FakeVoiceCapture(),
      player: player,
    );
    shell.setState(() {
      shell.dictation = dictation;
      shell.voiceSession = call;
    });
    await tester.pump();
  }

  void showCall() => shell.setState(() {
    shell.footerOpen = true;
    shell.footerExiting = false;
  });

  Future<void> dispose(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    sessions.clear();
    links.dispose();
    reducedMotion.dispose();
    await tester.pump();
  }
}

/// Measure the actual painted ancestors, including shell/page clips. Merely
/// checking the control's layout size would miss a sliced animation frame.
void expectUnclippedControl(WidgetTester tester, Finder finder) {
  final control = tester.renderObject<RenderBox>(finder);
  expect(control.size, const Size(48, 48));
  RenderObject child = control;
  while (child.parent != null) {
    final parent = child.parent!;
    final clip = parent.describeApproximatePaintClip(child);
    if (clip != null) {
      final paddedControl = MatrixUtils.transformRect(
        control.getTransformTo(parent),
        (Offset.zero & control.size).inflate(16),
      );
      expect(clip.intersect(paddedControl), paddedControl,
          reason: '${parent.runtimeType} must not clip the stop or its space');
    }
    child = parent;
  }
}
