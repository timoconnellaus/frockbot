/// The chime when a call first reaches listening.
///
/// Not the call's speaker. That stream is the Bot's voice, and feeding this
/// into it would make the meter, the echo rule and the playback receipts
/// treat a UI sound as a reply. It also must not take audio focus: the call
/// already holds the session, and a second claimant ducks it.
///
/// The file is Freesound 848974, `sfx_rpg_ui_confirm` by MATUSTRM, CC0. The
/// recording's own tail is more than a second of silence; that is not in
/// the asset.
library;

import 'package:audioplayers/audioplayers.dart';

abstract interface class VoiceConnectSound {
  Future<void> play();
  Future<void> dispose();
}

/// Tests, and any call that has nothing to play.
class SilentVoiceConnectSound implements VoiceConnectSound {
  const SilentVoiceConnectSound();

  @override
  Future<void> play() async {}

  @override
  Future<void> dispose() async {}
}

/// [assets/voice/connect.wav], once, mixed under the call.
class AssetVoiceConnectSound implements VoiceConnectSound {
  AudioPlayer? _player;

  @override
  Future<void> play() async {
    try {
      final player = _player ??= AudioPlayer();
      await player.setAudioContext(
        AudioContextConfig(focus: AudioContextConfigFocus.mixWithOthers)
            .build(),
      );
      await player.setReleaseMode(ReleaseMode.stop);
      await player.stop();
      await player.play(AssetSource('voice/connect.wav'));
    } on Object {
      // The call is already up. A speaker that will not play a chime is
      // not a reason to take it down.
    }
  }

  @override
  Future<void> dispose() async {
    final player = _player;
    _player = null;
    try {
      await player?.dispose();
    } on Object {
      // Already gone.
    }
  }
}
