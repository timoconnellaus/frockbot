/// The continuous voice session: one call, all Bots, the footer's whole
/// state.
///
/// This implements `docs/voice.md` "Assistant protocol (v1)" and holds no
/// policy of its own beyond the one the document gives the client: an idle
/// upstream bills for silence, so put it to sleep after twenty continuous
/// seconds of quiet and wake it on the next onset.
///
/// An awake upstream gets every frame — speech, pauses and the silence after
/// a sentence alike. OpenAI's server VAD decides where a turn ends and it
/// needs that silence — 700 ms of it, `silence_duration_ms` — to decide it. The energy gate here is only ever asked two questions: has
/// someone started talking (wake), and is someone talking over the reply
/// (barge-in). It is not consulted about individual frames.
///
/// Nothing here caps how long a call may last. A sleeping upstream costs
/// nothing, so the footer may stay open silently for hours; what the server
/// meters is what it spends, and it says so itself.
///
/// There is no reconnect loop. One retry of the initial connect, then an
/// error the person can act on — a client that reconnects forever is a client
/// that spends money forever.
library;

import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';

import 'capture.dart';
import 'player.dart';
import 'protocol.dart';
import 'socket.dart';
import 'speech_gate.dart';

enum VoiceSessionPhase { idle, connecting, live, ending, ended, error }

class AssistantSessionController extends ChangeNotifier {
  final VoiceSocketOpener openSocket;
  final VoiceCapture capture;
  final VoicePlayer player;
  final SpeechGateConfig gateConfig;
  final Duration startTimeout;
  final Duration sleepAfter;
  final Duration connectRetryWindow;

  AssistantSessionController({
    required this.openSocket,
    required this.capture,
    required this.player,
    this.gateConfig = const SpeechGateConfig(),
    this.startTimeout = voiceAssistantStartTimeoutV1,
    this.sleepAfter = voiceAssistantSleepAfterV1,
    this.connectRetryWindow = voiceAssistantConnectRetryWindowV1,
  });

  VoiceSessionPhase _phase = VoiceSessionPhase.idle;
  VoiceStatusV1 _status = VoiceStatusV1.idle;
  VoiceUpstreamStateV1 _upstream = VoiceUpstreamStateV1.starting;
  String? _error;

  /// Two independent inputs decide whether this client is sending. [_userMuted]
  /// is the person's own toggle and survives everything; [_microphoneHeld] is
  /// the device being lent to dictation for a moment. Effective mute is either
  /// of them, so releasing the loan restores what the person chose rather than
  /// speaking for them — a call someone deliberately muted must never come
  /// back on by itself.
  bool _userMuted = false;
  bool _microphoneHeld = false;
  bool _asleep = false;
  bool _started = false;
  bool _barged = false;
  bool _disposed = false;
  double _micLevel = 0;

  late SpeechGate _gate = SpeechGate(config: gateConfig);
  VoiceSocket? _socket;
  StreamSubscription<AudioFrame>? _frames;
  StreamSubscription<Object?>? _inbound;
  Timer? _startTimer;

  /// Which start this is. Every await inside a start checks it before acting,
  /// so a call ended while the person was still answering the permission
  /// prompt cannot resurrect a capture behind them.
  int _generation = 0;

  /// Audio captured before `start_call` went out, bounded at 10 s and drained
  /// in order once it has.
  final ListQueue<Uint8List> _opening = ListQueue<Uint8List>();
  int _openingBytes = 0;

  VoiceSessionPhase get phase => _phase;
  VoiceStatusV1 get status => _status;
  VoiceUpstreamStateV1 get upstream => _upstream;
  String? get error => _error;

  /// Whether this client is sending. Either input is enough to stop it.
  bool get muted => _userMuted || _microphoneHeld;

  /// The person's own toggle, which is what the footer's control changes.
  bool get userMuted => _userMuted;

  /// Whether the upstream is asleep because this client stopped sending.
  bool get asleep => _asleep;
  double get micLevel => _micLevel;
  double get playbackLevel => player.level;
  bool get active =>
      _phase == VoiceSessionPhase.connecting ||
      _phase == VoiceSessionPhase.live ||
      _phase == VoiceSessionPhase.ending;

  /// Opens the call: capture first so the opening words are already recorded,
  /// then the socket, then the handshake.
  Future<void> start() async {
    if (active) return;
    final generation = ++_generation;
    _error = null;
    _userMuted = false;
    _microphoneHeld = false;
    _asleep = false;
    _started = false;
    _barged = false;
    _status = VoiceStatusV1.idle;
    _upstream = VoiceUpstreamStateV1.starting;
    _gate = SpeechGate(config: gateConfig);
    _opening.clear();
    _openingBytes = 0;
    _set(VoiceSessionPhase.connecting);
    player.addListener(_notify);
    if (!await _openCapture(generation)) return;
    final socket = await _connect(generation);
    if (socket == null) return;
    if (generation != _generation || _disposed || !active) {
      await socket.close(
        code: voiceCloseAbandonedV1,
        reason: 'abandoned-connect',
      );
      await _closeCapture();
      return;
    }
    _socket = socket;
    _inbound = socket.messages.listen(
      _onMessage,
      onError: (Object _) => unawaited(_fail('Voice stopped. Try again.')),
      onDone: () => unawaited(_ended()),
    );
    _startTimer = Timer(startTimeout, () {
      if (_status != VoiceStatusV1.listening) {
        unawaited(_fail('Voice didn’t start. Try again.'));
      }
    });
  }

  /// One retry, inside the retry window. Then it is an error, not a loop.
  Future<VoiceSocket?> _connect(int generation) async {
    final began = DateTime.now();
    for (var attempt = 0; attempt < 2; attempt++) {
      final pending = openSocket();
      try {
        return await pending.timeout(connectRetryWindow);
      } on Object {
        unawaited(
          pending
              .then(
                (socket) => socket.close(
                  code: voiceCloseAbandonedV1,
                  reason: 'abandoned-connect',
                ),
              )
              .catchError((Object _) {}),
        );
        if (generation != _generation || _disposed) return null;
        final elapsed = DateTime.now().difference(began);
        if (attempt == 1 || elapsed >= connectRetryWindow) break;
      }
    }
    if (generation != _generation || _disposed) return null;
    await _fail('Couldn’t reach voice. Check your connection and try again.');
    return null;
  }

  /// Opens the microphone behind the start fence.
  ///
  /// The permission prompt is the slow part and the person may end the call
  /// while it is up. Whatever the prompt eventually answers, a capture that
  /// belongs to a call that is over is stopped rather than listened to.
  Future<bool> _openCapture(int generation) async {
    try {
      final frames = await capture.start(
        sampleRate: voiceAssistantInputSampleRateV1,
        frame: voiceAssistantFrame,
      );
      if (generation != _generation || _disposed) {
        await capture.stop();
        return false;
      }
      _frames = frames.listen(_onFrame, onError: (Object _) {});
      return true;
    } on MicrophoneDenied catch (denied) {
      if (generation != _generation || _disposed) return false;
      await _fail(denied.message);
      return false;
    } on Object {
      if (generation != _generation || _disposed) return false;
      await _fail('FrockBot couldn’t start the microphone. Try again.');
      return false;
    }
  }

  Future<void> _closeCapture() async {
    await _frames?.cancel();
    _frames = null;
    await capture.stop();
    _micLevel = 0;
  }

  void _onFrame(AudioFrame frame) {
    _micLevel = frame.level;
    final decision = _gate.offer(frame.bytes, frame.level, frame.atMs);
    // Barge-in is judged before mute and before sleep: it is the one thing
    // that must reach the server while it is talking.
    if (decision.bargeIn &&
        _status == VoiceStatusV1.speaking &&
        !muted &&
        !_barged) {
      _barged = true;
      unawaited(player.interrupt());
      _socket?.sendText(encodeAssistantInterruptV1());
    }
    _notify();
    if (muted || !active) return;
    if (!_started) {
      _opening.addLast(frame.bytes);
      _openingBytes += frame.bytes.length;
      while (_openingBytes > voiceAssistantOpeningBufferBytesV1 &&
          _opening.isNotEmpty) {
        _openingBytes -= _opening.removeFirst().length;
      }
      return;
    }
    final socket = _socket;
    if (socket == null) return;
    if (_asleep) {
      // Asleep, the gate is the only thing that can wake the upstream: a
      // verified onset, then the pre-roll in order, then live frames.
      if (!decision.onset) return;
      socket.sendText(encodeVoiceWakeV1());
      _asleep = false;
      _upstream = VoiceUpstreamStateV1.starting;
      for (final piece in decision.emit) {
        socket.sendBinary(piece);
      }
      _notify();
      return;
    }
    // Quiet long enough while listening, and the upstream sleeps. This is the
    // only thing that stops the audio: nothing else is gated.
    if (!decision.open &&
        _status == VoiceStatusV1.listening &&
        _gate.quietForMs(frame.atMs) >= sleepAfter.inMilliseconds) {
      socket.sendText(encodeVoiceSleepV1());
      _asleep = true;
      _upstream = VoiceUpstreamStateV1.asleep;
      _notify();
      return;
    }
    // Awake means every frame, speech and silence alike, through pauses and
    // while the assistant is thinking or speaking. OpenAI's server VAD decides
    // where a turn ends and needs the silence after the words to decide it —
    // 700 ms, `silence_duration_ms`; a client that cut the audio off a second
    // after the last syllable would leave the transcript hanging until the
    // upstream timed out.
    socket.sendBinary(frame.bytes);
  }

  void _onMessage(Object? message) {
    if (message is List<int>) {
      player.write(
        message is Uint8List ? message : Uint8List.fromList(message),
      );
      return;
    }
    if (message is! String) return;
    final frame = decodeAssistantServerFrameV1(message);
    if (frame == null) return;
    switch (frame) {
      case AssistantWelcomeV1():
        final socket = _socket;
        if (socket == null || _started) return;
        socket.sendText(encodeAssistantHelloV1());
        socket.sendText(encodeAssistantStartCallV1());
        _started = true;
        while (_opening.isNotEmpty) {
          socket.sendBinary(_opening.removeFirst());
        }
        _openingBytes = 0;
      case AssistantStatusV1(:final status):
        _status = status;
        if (status != VoiceStatusV1.speaking) _barged = false;
        if (status == VoiceStatusV1.listening) {
          _startTimer?.cancel();
          _startTimer = null;
          if (!_asleep) _upstream = VoiceUpstreamStateV1.awake;
          _set(VoiceSessionPhase.live);
        }
        _notify();
      case AssistantAudioConfigV1(:final sampleRate):
        unawaited(
          player.configure(sampleRate ?? voiceAssistantOutputSampleRateV1),
        );
      case AssistantPlaybackInterruptV1():
        unawaited(player.interrupt());
      case AssistantVoiceStateV1(:final upstream):
        // The server reports its own view of the mute; the two inputs that
        // produced it are this client's and are not overwritten by it.
        _upstream = upstream;
        _notify();
      case AssistantRefusalV1(:final code):
        unawaited(_fail(voiceRefusalMessage(code)));
      case AssistantErrorV1():
        unawaited(_fail('Voice stopped unexpectedly. Try again.'));
      case AssistantTranscriptV1():
      case AssistantDiagnosticV1():
        // The footer shows no transcript and no diagnostics.
        break;
    }
  }

  /// The person's own mute toggle. It is remembered across a microphone loan:
  /// muting during dictation leaves the call muted when dictation ends.
  void setMuted(bool muted) => unawaited(_apply(userMuted: muted));

  /// Lends the microphone out, or takes it back.
  ///
  /// A held microphone is an effective mute — the transcriber is billed by
  /// the second, so it sleeps for the loan — and the device is released, so
  /// the borrower can actually open it.
  Future<void> holdMicrophone(bool held) => _apply(held: held);

  /// Applies one change to either input and reconciles everything an
  /// effective transition owes: the server is told, the gate is reset, and
  /// the device is closed or reopened.
  Future<void> _apply({bool? userMuted, bool? held}) async {
    final was = muted;
    if (userMuted != null) _userMuted = userMuted;
    if (held != null) _microphoneHeld = held;
    final now = muted;
    if (now == was) {
      // The toggle moved under a loan, or the loan ended into a mute the
      // person had already asked for. Nothing is owed but the repaint.
      _notify();
      return;
    }
    _socket?.sendText(encodeVoiceMuteV1(now));
    _gate.reset();
    // A client that is not sending is, to the upstream, asleep: the next
    // onset must wake it explicitly.
    _asleep = true;
    if (now) {
      _upstream = VoiceUpstreamStateV1.asleep;
      _notify();
      await _closeCapture();
      _notify();
      return;
    }
    _notify();
    if (!active) return;
    await _openCapture(_generation);
    _notify();
  }

  /// Ends the call. A Bot Turn already delegated keeps running; that work is
  /// durable in the Bot and is not this socket's to cancel.
  ///
  /// [reason] names the path that ended it — the End button, the app leaving
  /// the foreground — and travels in the socket's close frame, where the
  /// server logs it.
  Future<void> end({required String reason}) async {
    if (_phase == VoiceSessionPhase.idle || _phase == VoiceSessionPhase.ended) {
      return;
    }
    _generation++;
    _set(VoiceSessionPhase.ending);
    _socket?.sendText(encodeAssistantEndCallV1());
    await _teardown(reason: reason);
    _status = VoiceStatusV1.idle;
    _set(VoiceSessionPhase.ended);
  }

  Future<void> _ended() async {
    if (!active) return;
    _generation++;
    await _teardown(reason: 'server-closed');
    _status = VoiceStatusV1.idle;
    _set(VoiceSessionPhase.ended);
  }

  Future<void> _fail(String message) async {
    if (_phase == VoiceSessionPhase.error) return;
    _generation++;
    _error = message;
    // Say so now, before the teardown's awaits: the footer shows the failure
    // the moment it is known, not after the socket has finished closing.
    _notify();
    await _teardown(code: voiceCloseFailedV1, reason: message);
    _status = VoiceStatusV1.idle;
    _set(VoiceSessionPhase.error);
  }

  Future<void> _teardown({
    int code = voiceCloseNormalV1,
    String reason = '',
  }) async {
    _startTimer?.cancel();
    _startTimer = null;
    await _settled(_closeCapture);
    final inbound = _inbound;
    _inbound = null;
    await _settled(() async => inbound?.cancel());
    final socket = _socket;
    _socket = null;
    await _settled(player.close);
    player.removeListener(_notify);
    await _settled(() async => socket?.close(code: code, reason: reason));
    _micLevel = 0;
    _opening.clear();
    _openingBytes = 0;
    _started = false;
  }

  /// A recorder, a speaker or a socket that fails to close is not a reason
  /// to strand the call in [VoiceSessionPhase.ending] with the microphone
  /// still held: every step runs and the phase still lands.
  Future<void> _settled(Future<void> Function() step) =>
      Future<void>.sync(step).catchError((Object _) {});

  void _set(VoiceSessionPhase phase) {
    if (_phase == phase) return;
    _phase = phase;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    unawaited(_teardown(code: voiceCloseDisposedV1, reason: 'disposed'));
    super.dispose();
  }
}
