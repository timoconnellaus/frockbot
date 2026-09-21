import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/bot_sessions.dart';
import 'package:frockbot_native/client/page_cache.dart';
import 'package:frockbot_native/client/store.dart';
import 'package:frockbot_native/shell/app_shell.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/dictation.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'navigation_test.dart' show OfflineApi, registration;
import 'voice_fakes.dart';
import 'widget_test.dart' show MemoryStore;

class _SnapshotStore extends MemoryStore implements SnapshotStore {
  @override
  bool get resident => true;

  @override
  String? peek(String key) => values[key];
}

/// Real shell layout and commands, with only network and audio devices faked.
class VoiceShellHarness {
  final key = GlobalKey<State<AppShell>>();

  /// The whole window, so a visual test can read the real shell back as an
  /// image rather than photographing a fixture built to look like it.
  final boundary = GlobalKey();
  final store = _SnapshotStore();
  final links = ValueNotifier<String?>(null);
  var dictationSocket = FakeVoiceSocket();
  final dictationCapture = FakeVoiceCapture();
  final callSocket = FakeVoiceSocket();
  final player = FakeVoicePlayer();
  final callCapture = FakeVoiceCapture();
  final route = FakeVoiceAudioRoute();
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
    double height = 800,
  }) async {
    tester.view.physicalSize = Size(width, height);
    tester.view.devicePixelRatio = 1;
    tester.view.padding = FakeViewPadding(bottom: width == 390 ? 34 : 0);
    addTearDown(tester.view.reset);
    store.values['directory/voice-user'] = jsonEncode({
      'schemaVersion': 1,
      'revision': 1,
      'bots': [registration('voice-bot', 'Rosemary')],
    });
    store.values[pageCacheKey('voice-user', 'voice-bot')] = encodePageCache([
      {
        'schemaVersion': 1,
        'runId': 'run-flight',
        'admittedAt': '2026-09-21T00:00:00.000Z',
        'input': 'Remind me about the flight on Friday.',
        'status': 'completed',
        'events': [
          {
            'type': 'send/to-user',
            'payload': {
              'type': 'text',
              'text':
                  'Friday 6:40pm, terminal 2. I’ll ping you an hour before.',
            },
            'ordinal': 0,
          },
        ],
      },
      {
        'schemaVersion': 1,
        'runId': 'run-voice',
        'admittedAt': '2026-09-21T00:01:00.000Z',
        'input': 'Call me when you have an update.',
        'status': 'completed',
        'events': [
          {
            'type': 'send/to-user',
            'payload': {
              'type': 'text',
              'text': 'I will. The thread stays here while we talk.',
            },
            'ordinal': 0,
          },
        ],
      },
    ], null);
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(brightness),
        home: ValueListenableBuilder(
          valueListenable: reducedMotion,
          builder: (context, reduced, _) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
            child: RepaintBoundary(
              key: boundary,
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
      capture: callCapture,
      player: player,
      route: route,
    );
    shell.setState(() {
      shell.dictation = dictation;
      shell.voiceSession = call;
      // A call the shell itself builds — a press on a voice control — takes
      // the same devices, so nothing here reaches a real microphone.
      shell.voiceCapture = callCapture;
      shell.audioRoute = route;
    });
    await tester.pump();
  }

  /// The call, as the shell holds it. Naming a Bot puts the call *on* that
  /// Bot, which is what voice mode is; naming none leaves the call in the
  /// background, where the dock is.
  void showCall({String? botId}) => shell.setState(() {
    shell.footerOpen = true;
    shell.footerExiting = false;
    if (botId != null) shell.voiceBotId = botId;
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
      expect(
        clip.intersect(paddedControl),
        paddedControl,
        reason: '${parent.runtimeType} must not clip the stop or its space',
      );
    }
    child = parent;
  }
}
