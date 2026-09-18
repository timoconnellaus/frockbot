/// Starting a call from the composer's voice control: the press opens the
/// call's surface in the same gesture, and a call that goes away while the
/// press is still waiting for the call before it to let the devices go must
/// not claim the audio session on its way out.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/semantics.dart';

import 'shell_layout_test.dart' show byIdentifier;
import 'voice_shell_harness.dart';

void main() {
  testWidgets(
    'a call hung up while the one before it lets go never begins the audio',
    (tester) async {
      final harness = VoiceShellHarness();
      await harness.mount(tester, width: 1280, brightness: Brightness.dark);
      // The call the press replaces is still letting the devices go, which
      // is the window the replacement starts in.
      final lettingGo = Completer<void>();
      harness.callCapture.stopGate = lettingGo;

      // A press on the Bot's voice control opens the call's surface at once.
      await tester.tap(find.byKey(const ValueKey('composer-voice')));
      await tester.pump();
      expect(byIdentifier(VoiceIds.hangUp), findsOneWidget);

      // The person hangs up before the call it replaced has let go.
      await tester.tap(byIdentifier(VoiceIds.hangUp));
      await tester.pump();
      expect(harness.shell.voiceSession, isNull);

      // The devices are free again, and the start that was waiting on them
      // must not claim the audio session for a call nobody holds.
      lettingGo.complete();
      await tester.pumpAndSettle();

      expect(harness.route.begins, 0);
      expect(harness.route.ends, 0);
      expect(harness.callCapture.starts, 0);
      expect(harness.shell.voiceSession, isNull);
      await harness.dispose(tester);
    },
  );
}
