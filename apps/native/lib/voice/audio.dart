import 'dart:async';
import 'dart:typed_data';

import 'package:audio_session/audio_session.dart';
import 'package:flutter_pcm_sound/flutter_pcm_sound.dart' as pcm;
import 'package:record/record.dart';

import 'dictation.dart';
import 'protocol.dart';

/// Why the microphone could not be opened, in the User's terms.
class VoiceAudioRefusal implements Exception {
  final String message;
  const VoiceAudioRefusal(this.message);
  @override
  String toString() => message;
}

/// The phone's microphone and speaker for one Voice session.
///
/// The screen owns none of this directly, so a test can drive all four states
/// without a device.
abstract interface class VoiceAudio {
  /// Opens the microphone. Throws [VoiceAudioRefusal] when the User says no,
  /// with a sentence the screen can show unchanged.
  ///
  /// [sampleRate] is the rate the far end was told to expect: the assistant's
  /// [voiceInputSampleRate], or dictation's [voiceDictationSampleRate]. Set
  /// [playback] false for dictation, which never plays anything back and so
  /// must not claim the speaker.
  Future<void> listen(
    void Function(Uint8List pcm16) onFrame, {
    int sampleRate,
    bool playback,
  });

  /// Closes the microphone but leaves playback able to finish a sentence.
  Future<void> silence();

  /// Queues PCM16LE mono at [voiceOutputSampleRate].
  void play(Uint8List pcm16);

  /// Drops whatever is queued; the Bot was spoken over.
  Future<void> interrupt();

  Future<void> dispose();
}

/// The real phone. Capture is `record`, playback is `flutter_pcm_sound`, and
/// the route is negotiated through `audio_session` so a call or an alarm ducks
/// this rather than fighting it.
class DeviceVoiceAudio implements VoiceAudio {
  final AudioRecorder _recorder = AudioRecorder();
  StreamSubscription<Uint8List>? _capture;
  bool _playing = false;
  bool _disposed = false;

  /// The remainder of a chunk that did not divide into whole frames. The
  /// upstream expects PCM16 sample boundaries, so a split sample is carried
  /// rather than dropped.
  final BytesBuilder _spare = BytesBuilder(copy: true);

  /// 32 ms of PCM16 at whatever rate this capture was opened with.
  static int _frameBytes(int sampleRate) => (sampleRate * 32 ~/ 1000) * 2;

  /// Speaker by default, and a headset when there is one.
  static final AVAudioSessionCategoryOptions _voiceRouteOptions =
      AVAudioSessionCategoryOptions.defaultToSpeaker |
      AVAudioSessionCategoryOptions.allowBluetooth;

  Future<void> _configureSession() async {
    final session = await AudioSession.instance;
    await session.configure(
      AudioSessionConfiguration(
        avAudioSessionCategory: AVAudioSessionCategory.playAndRecord,
        avAudioSessionCategoryOptions: _voiceRouteOptions,
        avAudioSessionMode: AVAudioSessionMode.voiceChat,
        androidAudioAttributes: const AndroidAudioAttributes(
          contentType: AndroidAudioContentType.speech,
          usage: AndroidAudioUsage.voiceCommunication,
        ),
        androidAudioFocusGainType:
            AndroidAudioFocusGainType.gainTransientMayDuck,
        androidWillPauseWhenDucked: false,
      ),
    );
    await session.setActive(true);
  }

  @override
  Future<void> listen(
    void Function(Uint8List pcm16) onFrame, {
    int sampleRate = voiceInputSampleRate,
    bool playback = true,
  }) async {
    if (!await _recorder.hasPermission()) {
      throw const VoiceAudioRefusal(
        'FrockBot needs the microphone to hear you. Turn it on for FrockBot in '
        'your phone’s settings, then try Voice again.',
      );
    }
    await _configureSession();
    if (playback && !_playing) {
      await pcm.FlutterPcmSound.setup(
        sampleRate: voiceOutputSampleRate,
        channelCount: 1,
        iosAudioCategory: pcm.IosAudioCategory.playAndRecord,
      );
      _playing = true;
    }
    final Stream<Uint8List> stream;
    try {
      stream = await _recorder.startStream(
        RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          sampleRate: sampleRate,
          numChannels: 1,
          echoCancel: true,
          noiseSuppress: true,
          autoGain: true,
        ),
      );
    } catch (error) {
      throw VoiceAudioRefusal(
        'FrockBot couldn’t open the microphone ($error). Check nothing else is '
        'using it and try Voice again.',
      );
    }
    // The platform hands over whatever size it likes; the socket wants the
    // browser's 32 ms frame, so the stream is re-cut here.
    final frameBytes = _frameBytes(sampleRate);
    _capture = stream.listen((chunk) {
      _spare.add(chunk);
      if (_spare.length < frameBytes) return;
      final buffered = _spare.takeBytes();
      var offset = 0;
      while (buffered.length - offset >= frameBytes) {
        onFrame(
          Uint8List.fromList(buffered.sublist(offset, offset + frameBytes)),
        );
        offset += frameBytes;
      }
      if (offset < buffered.length) _spare.add(buffered.sublist(offset));
    }, cancelOnError: false);
  }

  @override
  Future<void> silence() async {
    final capture = _capture;
    _capture = null;
    _spare.clear();
    await capture?.cancel();
    try {
      if (await _recorder.isRecording()) await _recorder.stop();
    } catch (_) {
      // A recorder that is already stopped is the state we wanted.
    }
  }

  @override
  void play(Uint8List pcm16) {
    if (_disposed || !_playing || pcm16.lengthInBytes < 2) return;
    // The bytes are already PCM16LE, which is what the queue takes.
    unawaited(
      pcm.FlutterPcmSound.feed(
        pcm.PcmArrayInt16(
          bytes: pcm16.buffer.asByteData(
            pcm16.offsetInBytes,
            pcm16.lengthInBytes - (pcm16.lengthInBytes % 2),
          ),
        ),
      ).catchError((Object _) {
        // A dropped frame is a click, not a broken session.
      }),
    );
  }

  @override
  Future<void> interrupt() async {
    if (_disposed || !_playing) return;
    // The queue has no flush, so the device is torn down and rebuilt. That is
    // the only way a barge-in stops a sentence already handed to the speaker.
    try {
      await pcm.FlutterPcmSound.release();
      await pcm.FlutterPcmSound.setup(
        sampleRate: voiceOutputSampleRate,
        channelCount: 1,
        iosAudioCategory: pcm.IosAudioCategory.playAndRecord,
      );
    } catch (_) {
      _playing = false;
    }
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await silence();
    if (_playing) {
      _playing = false;
      try {
        await pcm.FlutterPcmSound.release();
      } catch (_) {
        // Releasing twice is not an error the User can act on.
      }
    }
    await _recorder.dispose();
    try {
      await (await AudioSession.instance).setActive(false);
    } catch (_) {
      // Handing focus back is best effort.
    }
  }
}
