/// Timbre preview clips minted from Gemini TTS, played through the same
/// speaker a call uses.
///
/// Live has no sample endpoint. `scripts/mint-voice-previews.ts` recites one
/// line in each of the thirty `voiceName`s over HTTP and writes a WAV under
/// `assets/voices/`. This module loads that file, strips the header, and
/// feeds PCM16 to [VoicePlayer] at 24 kHz — Live's own downstream rate, so
/// nothing resamples. Delivery presets are not in the clip: it is the mouth,
/// not the session.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'player.dart';
import 'protocol.dart' show voiceAssistantOutputSampleRateV1;

/// Where the minted clip for [voiceName] is bundled.
String voicePreviewAssetV1(String voiceName) => 'assets/voices/$voiceName.wav';

class PcmClipV1 {
  final Uint8List pcm;
  final int sampleRate;
  const PcmClipV1({required this.pcm, required this.sampleRate});
}

int _u32(Uint8List bytes, int offset) =>
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24);

String _ascii(Uint8List bytes, int offset, int length) =>
    String.fromCharCodes(bytes.sublist(offset, offset + length));

/// PCM16 little-endian mono from a canonical WAV, or null when it is not one.
PcmClipV1? wavToPcmV1(Uint8List wav) {
  if (wav.length < 44) return null;
  if (_ascii(wav, 0, 4) != 'RIFF' || _ascii(wav, 8, 4) != 'WAVE') return null;
  var offset = 12;
  var sampleRate = voiceAssistantOutputSampleRateV1;
  Uint8List? pcm;
  while (offset + 8 <= wav.length) {
    final id = _ascii(wav, offset, 4);
    final size = _u32(wav, offset + 4);
    final start = offset + 8;
    final end = start + size > wav.length ? wav.length : start + size;
    if (id == 'fmt ' && end - start >= 16) {
      final rate = _u32(wav, start + 4);
      if (rate > 0) sampleRate = rate;
    } else if (id == 'data') {
      pcm = Uint8List.sublistView(wav, start, end);
    }
    offset = start + size + (size.isOdd ? 1 : 0);
  }
  if (pcm == null) return null;
  return PcmClipV1(pcm: pcm, sampleRate: sampleRate);
}

/// A canonical PCM16 mono WAV. The mint script writes this shape; tests
/// build the same bytes so the decoder is proved against a known header.
Uint8List pcmToWavV1(
  Uint8List pcm, {
  int sampleRate = voiceAssistantOutputSampleRateV1,
}) {
  final wav = Uint8List(44 + pcm.length);
  final view = ByteData.sublistView(wav);
  void write(int offset, String text) {
    for (var i = 0; i < text.length; i++) {
      wav[offset + i] = text.codeUnitAt(i);
    }
  }

  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, Endian.little);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, Endian.little);
  view.setUint16(20, 1, Endian.little);
  view.setUint16(22, 1, Endian.little);
  view.setUint32(24, sampleRate, Endian.little);
  view.setUint32(28, sampleRate * 2, Endian.little);
  view.setUint16(32, 2, Endian.little);
  view.setUint16(34, 16, Endian.little);
  write(36, 'data');
  view.setUint32(40, pcm.length, Endian.little);
  wav.setRange(44, 44 + pcm.length, pcm);
  return wav;
}

/// Plays one minted timbre at a time through the device speaker.
///
/// Tapping the same voice again stops it. A second voice replaces the first.
/// [dispose] releases the speaker so a later call can own it.
class VoicePreviewPlayer extends ChangeNotifier {
  VoicePreviewPlayer({
    VoicePlayer Function()? createPlayer,
    Future<Uint8List> Function(String voiceName)? loadClip,
  }) : _createPlayer = createPlayer ?? PcmVoicePlayer.new,
       _loadClip =
           loadClip ??
           ((voiceName) async {
             final data = await rootBundle.load(voicePreviewAssetV1(voiceName));
             return data.buffer.asUint8List(
               data.offsetInBytes,
               data.lengthInBytes,
             );
           });

  final VoicePlayer Function() _createPlayer;
  final Future<Uint8List> Function(String voiceName) _loadClip;
  VoicePlayer? _player;
  String? _playing;
  int _generation = 0;

  String? get playing => _playing;

  Future<void> hear(String voiceName) async {
    if (_playing == voiceName) {
      await stop();
      return;
    }
    await stop();
    final generation = ++_generation;
    _playing = voiceName;
    notifyListeners();
    Uint8List bytes;
    try {
      bytes = await _loadClip(voiceName);
    } on Object {
      if (generation != _generation) return;
      _playing = null;
      notifyListeners();
      return;
    }
    if (generation != _generation) return;
    final clip = wavToPcmV1(bytes);
    if (clip == null || clip.pcm.isEmpty) {
      _playing = null;
      notifyListeners();
      return;
    }
    final player = _player ??= _createPlayer();
    await player.configure(clip.sampleRate);
    if (generation != _generation) return;
    player.write(clip.pcm);
    unawaited(
      player.drain().then((_) {
        if (generation != _generation) return;
        _playing = null;
        notifyListeners();
      }),
    );
  }

  Future<void> stop() async {
    _generation++;
    _playing = null;
    notifyListeners();
    final player = _player;
    if (player == null) return;
    await player.interrupt();
  }

  @override
  void dispose() {
    _generation++;
    _playing = null;
    final player = _player;
    _player = null;
    if (player != null) unawaited(player.close());
    super.dispose();
  }
}
