/// Visual review of header voice chrome, before the PR.
///
/// `--dart-define=VOICE_VISUAL_OUTPUT=<dir>` writes PNGs of each state.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/shell/semantics.dart';
import 'package:frockbot_native/theme/frock_theme.dart';
import 'package:frockbot_native/voice/assistant.dart';
import 'package:frockbot_native/voice/call_chrome.dart';
import 'package:frockbot_native/voice/capture.dart';
import 'package:frockbot_native/voice/footer.dart';

import 'shell_layout_test.dart' show byIdentifier;
import 'voice_fakes.dart';
import 'voice_mode_test.dart' show capture, controllerFor, live;
import 'voice_shell_harness.dart';

Color? _voiceIconColor(WidgetTester tester) {
  final button = tester.widget<IconButton>(
    find.byKey(const ValueKey('composer-voice')),
  );
  return button.style?.foregroundColor?.resolve({});
}

VoiceCallChrome _chrome(AssistantSessionController session) => VoiceCallChrome(
  session: session,
  userInitials: 'Tim O',
  botName: 'Rosemary',
  characterId: 'pixel',
  primary: '#fc85ae',
  onEnd: () {},
);

Widget _row(String label, AssistantSessionController session) {
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 20),
    child: Row(
      children: [
        SizedBox(
          width: 140,
          child: Text(
            label,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: Color(0xfff6f2ee),
            ),
          ),
        ),
        _chrome(session),
      ],
    ),
  );
}

Size _chromeSize(WidgetTester tester, {required int index}) {
  final chrome = byIdentifier(VoiceIds.callChrome);
  return tester.getSize(chrome.at(index));
}

void main() {
  const visual = String.fromEnvironment('VOICE_VISUAL_OUTPUT');
  if (visual.isNotEmpty) {
    setUpAll(() async {
      final inter = FontLoader('Inter');
      for (final weight in [400, 500, 600, 700]) {
        inter.addFont(rootBundle.load('assets/fonts/inter-latin-$weight.ttf'));
      }
      await inter.load();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    });
  }

  testWidgets('header chrome states write a labeled gallery', (tester) async {
    tester.view.physicalSize = const Size(720, 1280);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final connecting = controllerFor(FakeVoiceSocket());
    await connecting.start();

    final listenSocket = FakeVoiceSocket();
    final listening = await live(tester, listenSocket);

    final talkSocket = FakeVoiceSocket();
    final talking = await live(tester, talkSocket);
    (talking.capture as FakeVoiceCapture).emit(
      AudioFrame(Uint8List(0), 0.8, 40),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 360));

    final botSocket = FakeVoiceSocket();
    final botSpeaking = await live(tester, botSocket);
    (botSpeaking.player as FakeVoicePlayer).level = 0.8;

    final pauseSocket = FakeVoiceSocket();
    final paused = await live(tester, pauseSocket);
    paused.pause();

    final failSocket = FakeVoiceSocket();
    final failed = await live(tester, failSocket);
    failSocket.deliver(
      jsonEncode({'type': 'error', 'message': 'upstream', 'code': 'upstream'}),
    );

    final thinkSocket = FakeVoiceSocket();
    final thinking = await live(tester, thinkSocket);
    thinkSocket.deliver(jsonEncode({'type': 'status', 'status': 'thinking'}));
    await tester.pump();

    final muteSocket = FakeVoiceSocket();
    final muted = await live(tester, muteSocket);
    muted.setMuted(true);
    await tester.pump();

    final boundary = GlobalKey();
    final theme = FrockTheme.theme(Brightness.dark);
    await tester.pumpWidget(
      MaterialApp(
        theme: theme,
        home: Scaffold(
          backgroundColor: theme.scaffoldBackgroundColor,
          body: RepaintBoundary(
            key: boundary,
            child: ColoredBox(
              color: theme.scaffoldBackgroundColor,
              child: ListView(
                children: [
                  const Padding(
                    padding: EdgeInsets.fromLTRB(20, 20, 20, 8),
                    child: Text(
                      'Voice header chrome',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                        color: Color(0xfff6f2ee),
                      ),
                    ),
                  ),
                  _row('Connecting', connecting),
                  _row('Listening', listening),
                  _row('You talking', talking),
                  _row('Bot speaking', botSpeaking),
                  _row('Thinking', thinking),
                  _row('Paused', paused),
                  _row('Muted', muted),
                  _row('Failed', failed),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Connecting'), findsWidgets);
    expect(find.text('Listening'), findsWidgets);
    expect(find.text('Thinking'), findsWidgets);
    expect(find.text('Paused'), findsWidgets);
    expect(find.text('Muted'), findsWidgets);
    expect(find.text('Failed'), findsWidgets);

    final widths = [
      for (var i = 0; i < 8; i++) _chromeSize(tester, index: i).width,
    ];
    expect(widths.toSet(), {voiceCallClusterWidth});
    await capture(tester, boundary, '00-states');
    connecting.dispose();
  });

  testWidgets('idle chat, then connecting, then listening', (tester) async {
    final harness = VoiceShellHarness();
    await harness.mount(tester, width: 1280, brightness: Brightness.dark);
    expect(find.text('Remind me about the flight on Friday.'), findsOneWidget);
    expect(find.byType(Composer), findsOneWidget);
    expect(byIdentifier(VoiceIds.callChrome), findsNothing);
    final idle = _voiceIconColor(tester);
    await capture(tester, harness.boundary, '10-desktop-idle');

    await harness.call.start();
    harness.showCall(botId: 'voice-bot');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Connecting'), findsOneWidget);
    expect(find.text('Remind me about the flight on Friday.'), findsOneWidget);
    expect(find.byType(Composer), findsOneWidget);
    expect(_voiceIconColor(tester), isNot(idle));
    final connectingSize = tester.getSize(byIdentifier(VoiceIds.callChrome));
    expect(connectingSize.width, voiceCallClusterWidth);
    await capture(tester, harness.boundary, '11-desktop-connecting');

    harness.callSocket.deliver(
      jsonEncode({'type': 'welcome', 'protocol_version': 1}),
    );
    harness.callSocket.deliver(
      jsonEncode({'type': 'status', 'status': 'listening'}),
    );
    await tester.pump();
    await tester.pump();
    expect(find.text('Listening'), findsOneWidget);
    expect(find.byType(Composer), findsOneWidget);
    final theme = Theme.of(
      tester.element(find.byKey(const ValueKey('composer-voice'))),
    );
    expect(_voiceIconColor(tester), theme.colorScheme.primary);
    expect(tester.getSize(byIdentifier(VoiceIds.callChrome)), connectingSize);
    await capture(tester, harness.boundary, '07-desktop-listening');

    harness.callCapture.emit(AudioFrame(Uint8List(0), 0.8, 40));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 360));
    expect(tester.getSize(byIdentifier(VoiceIds.callChrome)), connectingSize);
    await capture(tester, harness.boundary, '13-desktop-talking');

    harness.call.pause();
    await tester.pump();
    expect(find.text('Paused'), findsOneWidget);
    expect(tester.getSize(byIdentifier(VoiceIds.callChrome)), connectingSize);
    await capture(tester, harness.boundary, '14-desktop-paused');
    await harness.dispose(tester);
  });

  testWidgets('a call with another Bot leaves this composer muted', (
    tester,
  ) async {
    final harness = VoiceShellHarness();
    await harness.mount(tester, width: 1280, brightness: Brightness.dark);
    final idle = _voiceIconColor(tester);
    await harness.call.start();
    harness.callSocket.deliver(
      jsonEncode({'type': 'welcome', 'protocol_version': 1}),
    );
    harness.callSocket.deliver(
      jsonEncode({'type': 'status', 'status': 'listening'}),
    );
    harness.showCall(botId: 'somebody-else');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(VoiceFooter), findsOneWidget);
    expect(byIdentifier(VoiceIds.callChrome), findsNothing);
    expect(_voiceIconColor(tester), idle);
    await capture(tester, harness.boundary, '08-other-bot-dock');
    await harness.dispose(tester);
  });

  testWidgets('phone connecting then listening keep back and the composer', (
    tester,
  ) async {
    final harness = VoiceShellHarness();
    await harness.mount(
      tester,
      width: 390,
      height: 844,
      brightness: Brightness.dark,
    );
    await harness.call.start();
    harness.showCall(botId: 'voice-bot');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Connecting'), findsOneWidget);
    expect(find.text('Rosemary'), findsWidgets);
    expect(find.byTooltip('Your Bots'), findsOneWidget);
    final phoneConnecting = tester.getSize(byIdentifier(VoiceIds.callChrome));
    expect(phoneConnecting.width, voiceCallClusterWidth);
    expect(phoneConnecting.height, voiceCallChromeHeight);
    expect(
      tester.getCenter(byIdentifier(VoiceIds.callChrome)).dx,
      closeTo(195, 1),
    );
    expect(
      tester.getCenter(byIdentifier(VoiceIds.mute)).dx,
      lessThan(tester.getCenter(byIdentifier(VoiceIds.hangUp)).dx),
    );
    expect(
      tester.getCenter(byIdentifier(VoiceIds.mute)).dy,
      greaterThan(tester.getCenter(byIdentifier(VoiceIds.callWave)).dy),
    );
    await capture(tester, harness.boundary, '15-phone-connecting');

    harness.callSocket.deliver(
      jsonEncode({'type': 'welcome', 'protocol_version': 1}),
    );
    harness.callSocket.deliver(
      jsonEncode({'type': 'status', 'status': 'listening'}),
    );
    await tester.pump();
    await tester.pump();
    expect(find.byType(Composer), findsOneWidget);
    expect(byIdentifier(VoiceIds.callChrome), findsOneWidget);
    expect(find.byTooltip('Your Bots'), findsOneWidget);
    expect(tester.getSize(byIdentifier(VoiceIds.callChrome)), phoneConnecting);
    await capture(tester, harness.boundary, '09-phone-listening');
    await harness.dispose(tester);
  });
}
