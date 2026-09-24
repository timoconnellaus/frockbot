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
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;
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

/// Whose session the microphone is opened in.
enum VoiceCaptureProfile {
  /// A short, capture-only act. The recorder plugin manages the audio
  /// session itself, as it always has.
  dictation,

  /// A call. The session — mode, focus, route — is already held by a
  /// [VoiceAudioRoute], so the recorder must leave it alone; it opens the
  /// device with the smallest buffer the platform allows, because how fast
  /// the meter follows a word is how fast the audio reaches it.
  call,

  /// A Plugin page listening to sound rather than speech — a tuner. Every
  /// cleanup is off, because noise suppression and automatic gain treat a
  /// held note as noise to remove.
  instrument,
}

abstract interface class VoiceCapture {
  /// Starts capture and answers the frame stream. Requests the microphone
  /// permission on the first call and throws [MicrophoneDenied] if refused.
  Future<Stream<AudioFrame>> start({
    required int sampleRate,
    required Duration frame,
    VoiceCaptureProfile profile = VoiceCaptureProfile.dictation,
  });
  Future<void> stop();
  bool get active;

  /// Whether playback from this app is removed from captured call audio.
  ///
  /// The assistant may stream microphone frames while it speaks only when
  /// this is true. Without that guarantee, speaker output is indistinguishable
  /// from a person to both the local speech gate and the model's VAD.
  bool get cancelsPlaybackEcho;

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

/// Brings what the recorder delivers to PCM16 mono at [toRate].
///
/// A browser captures at the track's own rate and channel count whatever is
/// asked, and a device that cannot do the rate picks its nearest; either says
/// so only through the recorder's config-changed callback, as [adopt]. Left
/// alone, 48 kHz stereo read as 16 kHz mono is every pitch six times too low
/// and every word six times too slow.
///
/// Each output sample is the mean of the input samples its period covers, so
/// a stream cut at any boundary converts the same as one that was not.
class PcmConformer {
  final int toRate;
  int _fromRate;
  int _channels;
  final BytesBuilder _carry = BytesBuilder(copy: true);
  int _read = 0;
  int _slot = 0;
  double _sum = 0;
  int _summed = 0;

  PcmConformer(this.toRate) : _fromRate = toRate, _channels = 1;

  /// What the recorder says it is actually delivering from now on.
  void adopt({required int sampleRate, required int channels}) {
    if (sampleRate == _fromRate && channels == _channels) return;
    _fromRate = sampleRate;
    _channels = math.max(1, channels);
    _carry.clear();
    _read = 0;
    _slot = 0;
    _sum = 0;
    _summed = 0;
  }

  Uint8List add(Uint8List chunk) {
    if (_fromRate == toRate && _channels == 1 && _carry.isEmpty) {
      if (chunk.length.isEven) return chunk;
    }
    _carry.add(chunk);
    final bytes = _carry.takeBytes();
    final frameBytes = 2 * _channels;
    final whole = bytes.length - bytes.length % frameBytes;
    if (whole < bytes.length) _carry.add(Uint8List.sublistView(bytes, whole));
    final input = ByteData.sublistView(bytes, 0, whole);
    final frames = whole ~/ frameBytes;
    final room = (frames + 1) * toRate ~/ _fromRate + toRate ~/ _fromRate + 2;
    final out = ByteData(room * 2);
    var written = 0;
    for (var at = 0; at < whole; at += frameBytes) {
      var mixed = 0;
      for (var channel = 0; channel < _channels; channel++) {
        mixed += input.getInt16(at + channel * 2, Endian.little);
      }
      final slot = (_read * toRate) ~/ _fromRate;
      if (slot != _slot && _summed > 0) {
        final mean = (_sum / _summed).round().clamp(-32768, 32767);
        // Upsampling leaves slots no input fell in; they hold the last value.
        for (var gap = _slot; gap < slot; gap++) {
          out.setInt16(written, mean, Endian.little);
          written += 2;
        }
        _sum = 0;
        _summed = 0;
        _slot = slot;
      }
      _sum += mixed / _channels;
      _summed++;
      _read++;
      if (_read == _fromRate) {
        _read = 0;
        _slot -= toRate;
      }
    }
    return Uint8List.sublistView(out.buffer.asUint8List(), 0, written);
  }
}

int pcmFrameBytes(int sampleRate, Duration frame) =>
    (sampleRate * 2 * frame.inMicroseconds) ~/ Duration.microsecondsPerSecond;

/// Whether the recorder is asked to clean the signal on [platform].
///
/// Echo cancellation, noise suppression and auto gain are the phone's: there
/// the speaker is inches from the microphone, and without cancellation the
/// assistant barges in on itself. On a Mac the recorder answers the same
/// request by turning voice processing on at the engine's input node, and
/// that unit is an input-and-output pair: with nothing rendering through the
/// same engine's output — playback here is the app's own device sink — the
/// input it hands over is silence. That is what the first voice session
/// after allowing the microphone was: a meter that never moved and a word
/// never detected, on a microphone that was open the whole time. The desk
/// gets a plain microphone; the browser keeps its own processing.
bool voiceCaptureProcessingV1(TargetPlatform platform, {bool web = kIsWeb}) =>
    web ||
    switch (platform) {
      TargetPlatform.android ||
      TargetPlatform.iOS ||
      TargetPlatform.fuchsia => true,
      TargetPlatform.macOS ||
      TargetPlatform.windows ||
      TargetPlatform.linux => false,
    };

/// The recorder's configuration for one [profile] on one [platform].
RecordConfig voiceRecordConfigV1({
  required VoiceCaptureProfile profile,
  required TargetPlatform platform,
  required int sampleRate,
  bool web = kIsWeb,
  int? streamBufferSize,
}) {
  final processing = voiceCaptureProcessingV1(platform, web: web);
  return switch (profile) {
    VoiceCaptureProfile.dictation => RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      numChannels: 1,
      sampleRate: sampleRate,
      echoCancel: processing,
      noiseSuppress: processing,
      autoGain: processing,
      androidConfig: const AndroidRecordConfig(
        // The communication source is the one Android attaches its own
        // echo canceller and noise suppressor to.
        audioSource: AndroidAudioSource.voiceCommunication,
        audioManagerMode: AudioManagerMode.modeInCommunication,
      ),
    ),
    VoiceCaptureProfile.call => RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      numChannels: 1,
      sampleRate: sampleRate,
      echoCancel: processing,
      noiseSuppress: processing,
      autoGain: processing,
      // The call already holds the session: the plugin must not set a
      // mode, start Bluetooth on its own, or ask for a second, media-
      // shaped focus that would fight the call's.
      androidConfig: const AndroidRecordConfig(
        audioSource: AndroidAudioSource.voiceCommunication,
        audioManagerMode: AudioManagerMode.modeNormal,
        manageBluetooth: false,
      ),
      audioInterruption: AudioInterruptionMode.none,
      // One frame per read where the platform allows it. The plugin
      // reads a whole buffer at a time, so the buffer is the latency.
      streamBufferSize: streamBufferSize,
    ),
    VoiceCaptureProfile.instrument => RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      numChannels: 1,
      sampleRate: sampleRate,
      echoCancel: false,
      noiseSuppress: false,
      autoGain: false,
      // The recognition source is the one Android keeps free of automatic
      // gain and noise suppression on every device; `unprocessed` is not
      // offered everywhere.
      androidConfig: const AndroidRecordConfig(
        audioSource: AndroidAudioSource.voiceRecognition,
        audioManagerMode: AudioManagerMode.modeNormal,
        manageBluetooth: false,
      ),
      streamBufferSize: streamBufferSize,
    ),
  };
}

/// The microphone through the `record` package.
///
/// Which platforms are asked for echo cancellation, noise suppression and
/// auto gain is [voiceCaptureProcessingV1]'s call: the speaker is inches from
/// the microphone on a phone, and without cancellation the assistant barges
/// in on itself, while the desk's unit hands over silence.
class RecordVoiceCapture implements VoiceCapture {
  final AudioRecorder _recorder = AudioRecorder();

  /// The platform's floor on a capture buffer, for [VoiceCaptureProfile.call].
  final Future<int?> Function(int sampleRate) minimumBuffer;
  RecordVoiceCapture({Future<int?> Function(int sampleRate)? minimumBuffer})
    : minimumBuffer = minimumBuffer ?? ((_) async => null);
  StreamSubscription<Uint8List>? _subscription;
  StreamController<AudioFrame>? _frames;
  final Stopwatch _clock = Stopwatch();
  bool _active = false;

  @override
  bool get active => _active;

  @override
  bool get cancelsPlaybackEcho =>
      voiceCaptureProcessingV1(defaultTargetPlatform);

  @override
  Future<Stream<AudioFrame>> start({
    required int sampleRate,
    required Duration frame,
    VoiceCaptureProfile profile = VoiceCaptureProfile.dictation,
  }) async {
    await stop();
    if (!await _recorder.hasPermission()) throw const MicrophoneDenied();
    final frameBytes = pcmFrameBytes(sampleRate, frame);
    final chunker = PcmFrameChunker(frameBytes);
    final conformer = PcmConformer(sampleRate);
    final frames = StreamController<AudioFrame>.broadcast();
    _frames = frames;
    final Stream<Uint8List> source;
    try {
      await _recorder.setOnConfigChanged(
        (actual) => conformer.adopt(
          sampleRate: actual.sampleRate,
          channels: actual.numChannels,
        ),
      );
      source = await _recorder.startStream(
        voiceRecordConfigV1(
          profile: profile,
          platform: defaultTargetPlatform,
          sampleRate: sampleRate,
          streamBufferSize: profile == VoiceCaptureProfile.dictation
              ? null
              : await _callBuffer(sampleRate, frameBytes),
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
        for (final piece in chunker.add(conformer.add(chunk))) {
          if (frames.isClosed) return;
          frames.add(AudioFrame(piece, pcm16Rms(piece), at));
        }
      },
      onError: frames.addError,
      cancelOnError: false,
    );
    return frames.stream;
  }

  Future<int?> _callBuffer(int sampleRate, int frameBytes) async {
    final minimum = await minimumBuffer(sampleRate);
    if (minimum == null) return null;
    return math.max(minimum, frameBytes);
  }

  @override
  Future<void> stop() async {
    final started = _active;
    _active = false;
    _clock.stop();
    final subscription = _subscription;
    _subscription = null;
    await subscription?.cancel();
    // A recorder that was never started has no device to give back, so the
    // platform is not asked: stopping it is nothing at all rather than a
    // round trip that can land on whatever holds the audio now.
    if (started) {
      try {
        await _recorder.stop();
      } on Object {
        // A device that will not let go is not a failure worth showing: the
        // capture is over either way.
      }
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
