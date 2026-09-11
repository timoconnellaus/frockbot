/// The microphone: PCM16 mono at a requested rate, in frames of one size.
///
/// The platform hands audio over in whatever chunk its buffer happened to
/// hold. Both protocols want an even, known frame — 40 ms for the assistant,
/// 32 ms for dictation — so the re-chunker is here rather than in either
/// controller, and it is a plain object so a test can prove it never loses or
/// reorders a byte.
///
/// [VoiceCapture] is an interface because everything above it must be
/// testable without a device. [RecordVoiceCapture] is the only implementation
/// that touches hardware.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:record/record.dart';

import 'speech_gate.dart' show pcm16Rms;

/// One frame of captured audio, its loudness, and when it was captured.
class AudioFrame {
  final Uint8List bytes;

  /// RMS of this frame, 0..1.
  final double level;

  /// Milliseconds since capture started. The controllers' whole clock.
  final int atMs;
  const AudioFrame(this.bytes, this.level, this.atMs);
}

/// The microphone was refused. The message is what a person can act on.
class MicrophoneDenied implements Exception {
  final String message;
  const MicrophoneDenied([
    this.message = 'FrockBot needs the microphone for voice. Allow it in your device settings and try again.',
  ]);
  @override
  String toString() => message;
}

abstract interface class VoiceCapture {
  /// Starts capture and answers the frame stream. Requests the microphone
  /// permission on the first call and throws [MicrophoneDenied] if refused.
  Future<Stream<AudioFrame>> start({
    required int sampleRate,
    required Duration frame,
  });
  Future<void> stop();
  bool get active;

  /// Releases the device. One capture serves the whole app — the microphone
  /// has one owner at a time — so this happens when the shell goes, not when
  /// a call does.
  Future<void> dispose();
}

/// Re-chunks a byte stream into frames of exactly [frameBytes].
///
/// A trailing partial frame is carried to the next call, so a stream cut at
/// any boundary produces the same frames as one that was not.
class PcmFrameChunker {
  final int frameBytes;
  final BytesBuilder _pending = BytesBuilder(copy: true);
  PcmFrameChunker(this.frameBytes) : assert(frameBytes > 0);

  List<Uint8List> add(Uint8List chunk) {
    _pending.add(chunk);
    if (_pending.length < frameBytes) return const [];
    final buffered = _pending.takeBytes();
    final frames = <Uint8List>[];
    var offset = 0;
    while (buffered.length - offset >= frameBytes) {
      frames.add(Uint8List.sublistView(buffered, offset, offset + frameBytes));
      offset += frameBytes;
    }
    if (offset < buffered.length) {
      _pending.add(Uint8List.sublistView(buffered, offset));
    }
    return frames;
  }

  /// How many bytes are held back waiting for a full frame.
  int get pending => _pending.length;
}

int pcmFrameBytes(int sampleRate, Duration frame) =>
    (sampleRate * 2 * frame.inMicroseconds) ~/ Duration.microsecondsPerSecond;

/// The microphone through the `record` package.
///
/// Echo cancellation, noise suppression and auto gain are asked for on every
/// platform that has them: the speaker is inches from the microphone on a
/// phone, and without cancellation the assistant barges in on itself.
class RecordVoiceCapture implements VoiceCapture {
  final AudioRecorder _recorder = AudioRecorder();
  StreamSubscription<Uint8List>? _subscription;
  StreamController<AudioFrame>? _frames;
  final Stopwatch _clock = Stopwatch();
  bool _active = false;

  @override
  bool get active => _active;

  @override
  Future<Stream<AudioFrame>> start({
    required int sampleRate,
    required Duration frame,
  }) async {
    await stop();
    if (!await _recorder.hasPermission()) throw const MicrophoneDenied();
    final chunker = PcmFrameChunker(pcmFrameBytes(sampleRate, frame));
    final frames = StreamController<AudioFrame>.broadcast();
    _frames = frames;
    final Stream<Uint8List> source;
    try {
      source = await _recorder.startStream(
        RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          sampleRate: sampleRate,
          numChannels: 1,
          echoCancel: true,
          noiseSuppress: true,
          autoGain: true,
          androidConfig: const AndroidRecordConfig(
            // The communication source is the one Android attaches its own
            // echo canceller and noise suppressor to.
            audioSource: AndroidAudioSource.voiceCommunication,
            audioManagerMode: AudioManagerMode.modeInCommunication,
          ),
        ),
      );
    } on Object {
      await frames.close();
      _frames = null;
      throw const MicrophoneDenied(
        'FrockBot couldn’t open the microphone. Check that nothing else is using it and try again.',
      );
    }
    _clock
      ..reset()
      ..start();
    _active = true;
    _subscription = source.listen(
      (chunk) {
        final at = _clock.elapsedMilliseconds;
        for (final piece in chunker.add(chunk)) {
          if (frames.isClosed) return;
          frames.add(AudioFrame(piece, pcm16Rms(piece), at));
        }
      },
      onError: frames.addError,
      cancelOnError: false,
    );
    return frames.stream;
  }

  @override
  Future<void> stop() async {
    _active = false;
    _clock.stop();
    final subscription = _subscription;
    _subscription = null;
    await subscription?.cancel();
    try {
      await _recorder.stop();
    } on Object {
      // Stopping a recorder that never started is not a failure worth
      // showing: the capture is over either way.
    }
    final frames = _frames;
    _frames = null;
    await frames?.close();
  }

  @override
  Future<void> dispose() async {
    await stop();
    try {
      await _recorder.dispose();
    } on Object {
      // Nothing is left to release.
    }
  }
}
