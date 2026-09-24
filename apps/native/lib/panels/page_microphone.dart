/// The shell's one microphone, lent to a Plugin's page (ADR 0036).
///
/// A page shares the capture dictation and calls use and takes its turn by
/// [MicOwnership]'s rules: it gets the microphone only when nobody holds it,
/// and either spoken gesture takes it back. The capture is unprocessed,
/// because a page listens to sound rather than speech.
library;

import 'dart:async';
import 'dart:typed_data';

import '../voice/capture.dart';
import '../voice/mic_ownership.dart';
import 'plugin_page.dart';

class ShellPageMicrophone implements PluginPageMicrophone {
  final MicOwnership ownership;
  final VoiceCapture Function() capture;
  ShellPageMicrophone({required this.ownership, required this.capture});

  bool _held = false;

  @override
  Future<Stream<Uint8List>> open({
    required Future<void> Function() taken,
  }) async {
    if (!ownership.acquireForPage(taken)) {
      throw const PluginPageMicrophoneRefused(
        'The microphone is in use by voice or dictation.',
      );
    }
    _held = true;
    try {
      final frames = await capture().start(
        sampleRate: pluginPageMicrophoneRateV1,
        frame: pluginPageMicrophoneFrameV1,
        profile: VoiceCaptureProfile.instrument,
      );
      return frames.map((frame) => frame.bytes);
    } on MicrophoneDenied catch (denied) {
      _release();
      throw PluginPageMicrophoneRefused(denied.message);
    } catch (_) {
      _release();
      rethrow;
    }
  }

  @override
  Future<void> close() async {
    if (!_held) return;
    _held = false;
    await capture().stop();
    ownership.releasePage();
  }

  void _release() {
    _held = false;
    ownership.releasePage();
  }
}
