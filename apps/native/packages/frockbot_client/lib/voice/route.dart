/// The audio session of a call: mode, focus and output route, held for as
/// long as the call lasts.
///
/// A phone plays a voice call through the earpiece and a song through the
/// loudspeaker, and it decides which by the mode the app put it in. A
/// realtime assistant is a call to the operating system — that is where the
/// echo canceller lives and how a Bluetooth microphone gets used — but not to
/// the person, who is not holding the phone to their ear. So the call takes
/// the session the way a VoIP app does and then says where the sound goes: a
/// headset if one is worn, the loudspeaker otherwise.
///
/// Only the phones need telling: Android through its audio manager, an iPhone
/// through its audio session's voice-chat mode, both over the same channel.
/// macOS routes on its own and the browser has no say, so those get
/// [NoVoiceAudioRoute], and every controller takes the interface so a test can
/// prove the session is begun before the microphone opens and ended after it
/// closes.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Where the call's sound is going.
enum VoiceRouteKind { speaker, earpiece, bluetooth, wired, other }

/// What the platform did with the call's claim on the audio.
enum VoiceFocusChange {
  /// Something transient took it — a ringtone, a navigation prompt — and
  /// will give it back.
  paused,

  /// It came back.
  regained,

  /// Another app took the audio for good.
  lost,
}

abstract interface class VoiceAudioRoute {
  /// Claims the session: focus, mode, route. Answers once the platform has
  /// applied them, which is before a microphone or a speaker should open.
  Future<void> begin();

  /// Releases the session and restores what [begin] found.
  Future<void> end();

  /// The route in use, or null outside a call.
  ValueListenable<VoiceRouteKind?> get route;

  Stream<VoiceFocusChange> get focus;

  /// The smallest capture buffer the platform accepts at [sampleRate], in
  /// bytes, or null where it has no opinion.
  Future<int?> minimumCaptureBuffer(int sampleRate);

  /// The route for this platform: the phones are told, everyone else is not.
  static VoiceAudioRoute forPlatform() =>
      !kIsWeb &&
          (defaultTargetPlatform == TargetPlatform.android ||
              defaultTargetPlatform == TargetPlatform.iOS)
      ? PlatformVoiceAudioRoute()
      : NoVoiceAudioRoute();
}

/// A platform that routes on its own.
class NoVoiceAudioRoute implements VoiceAudioRoute {
  final ValueNotifier<VoiceRouteKind?> _route = ValueNotifier(null);
  final StreamController<VoiceFocusChange> _focus =
      StreamController<VoiceFocusChange>.broadcast();

  @override
  Future<void> begin() async {}

  @override
  Future<void> end() async {}

  @override
  ValueListenable<VoiceRouteKind?> get route => _route;

  @override
  Stream<VoiceFocusChange> get focus => _focus.stream;

  @override
  Future<int?> minimumCaptureBuffer(int sampleRate) async => null;
}

/// The phone's session over `com.frockbot/audio-route`.
class PlatformVoiceAudioRoute implements VoiceAudioRoute {
  static const channel = MethodChannel('com.frockbot/audio-route');
  final ValueNotifier<VoiceRouteKind?> _route = ValueNotifier(null);
  final StreamController<VoiceFocusChange> _focus =
      StreamController<VoiceFocusChange>.broadcast();

  PlatformVoiceAudioRoute() {
    channel.setMethodCallHandler(_onEvent);
  }

  Future<void> _onEvent(MethodCall call) async {
    final args = call.arguments;
    if (args is! Map) return;
    switch (call.method) {
      case 'route':
        _route.value = decodeVoiceRouteKind(args['route']);
      case 'focus':
        final change = switch (args['state']) {
          'paused' => VoiceFocusChange.paused,
          'regained' => VoiceFocusChange.regained,
          'lost' => VoiceFocusChange.lost,
          _ => null,
        };
        if (change != null) _focus.add(change);
    }
  }

  @override
  Future<void> begin() async {
    try {
      _route.value = decodeVoiceRouteKind(
        await channel.invokeMethod<String>('begin'),
      );
    } on PlatformException {
      // A platform that refuses the session still has a microphone and a
      // speaker; the call goes on with whatever route it is given.
      _route.value = null;
    }
  }

  @override
  Future<void> end() async {
    try {
      await channel.invokeMethod<void>('end');
    } on PlatformException {
      // Nothing left to restore.
    }
    _route.value = null;
  }

  @override
  ValueListenable<VoiceRouteKind?> get route => _route;

  @override
  Stream<VoiceFocusChange> get focus => _focus.stream;

  @override
  Future<int?> minimumCaptureBuffer(int sampleRate) async {
    try {
      return await channel.invokeMethod<int>('minimumCaptureBuffer', {
        'sampleRate': sampleRate,
      });
    } on PlatformException {
      return null;
    }
  }
}

VoiceRouteKind? decodeVoiceRouteKind(Object? value) => switch (value) {
  'speaker' => VoiceRouteKind.speaker,
  'earpiece' => VoiceRouteKind.earpiece,
  'bluetooth' => VoiceRouteKind.bluetooth,
  'wired' => VoiceRouteKind.wired,
  String() => VoiceRouteKind.other,
  _ => null,
};
