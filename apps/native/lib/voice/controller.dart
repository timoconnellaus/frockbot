import 'dart:async';

import 'package:flutter/foundation.dart';

import 'audio.dart';
import 'protocol.dart';
import 'session.dart';

/// What the Voice screen is doing, in the User's terms.
enum VoicePhase {
  /// Opening the session; nothing is heard yet.
  connecting,

  /// The room is listening to you.
  listening,

  /// The Bot is speaking.
  speaking,

  /// Reopening after a pause. Brief, then live.
  resuming,

  /// Pause stopped the session outright. Nothing is heard.
  paused,

  /// The session ended and will not come back on its own.
  ended,
}

extension VoicePhaseLive on VoicePhase {
  bool get live => this == VoicePhase.listening || this == VoicePhase.speaking;
}

/// How often a paused screen asks what has arrived. The Bots do not know the
/// User stepped away, so this is the only way the count can grow.
const Duration voicePendingPollInterval = Duration(seconds: 10);

/// How long the screen waits for `ready` before it stops saying "Connecting".
///
/// The server is meant to answer with `ready` or `offline` either way, so this
/// is the screen's own floor: whatever happens between the phone and the
/// Durable Object — a socket held open by a proxy, a server that never gets to
/// a decision — the User is told something they can act on instead of watching
/// "Connecting" forever.
const Duration voiceConnectDeadline = Duration(seconds: 20);

/// The whole Voice screen's state.
///
/// Pause is not a mute: it sends `stop`, which ends the provider session.
/// Nothing is sent to any Bot, so a Bot that answers while paused writes its
/// answer to the User's ledger, where [waiting] finds it. Resuming opens a new
/// session, and the Durable Object's kickoff hands that same list to the agent
/// — which is why the rows on screen and what the agent works through are the
/// same list, not two lists that could disagree.
class VoiceController extends ChangeNotifier {
  final VoiceBackend backend;
  final VoiceAudio audio;
  final String deviceId;

  /// Overridable so a test does not wait ten real seconds.
  final Duration pollInterval;

  VoiceController({
    required this.backend,
    required this.audio,
    required this.deviceId,
    this.pollInterval = voicePendingPollInterval,
  });

  VoicePhase phase = VoicePhase.connecting;

  /// The last thing you said, as a completed utterance.
  String? youSaid;

  /// The last thing the assistant said. Tool use never appears here.
  String? botSaid;

  /// Answers waiting to be spoken. Empty while live: a live session speaks
  /// them instead of queuing them.
  List<VoicePendingAnswer> waiting = const [];

  /// A sentence to show when something went wrong or the session ended.
  String? message;

  VoiceSession? _session;
  StreamSubscription<VoiceServerFrame>? _frames;
  StreamSubscription<Uint8List>? _audio;
  Timer? _poll;
  Timer? _connectGuard;
  bool _disposed = false;

  /// Invalidates a permission prompt or socket callback from an older attempt,
  /// so a slow Resume cannot overwrite a newer Pause.
  int _attempt = 0;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Opens the first session. The screen calls this once, on first frame.
  Future<void> start() => _connect(resuming: false);

  /// Reopens after a pause. The waiting answers go to the agent, not away.
  Future<void> resume() => _connect(resuming: true);

  Future<void> _connect({required bool resuming}) async {
    if (phase.live || phase == VoicePhase.resuming) return;
    final attempt = ++_attempt;
    _poll?.cancel();
    _poll = null;
    phase = resuming ? VoicePhase.resuming : VoicePhase.connecting;
    message = null;
    _armConnectDeadline(attempt);
    _notify();
    VoiceSession? opened;
    try {
      await audio.listen((frame) {
        if (attempt == _attempt) opened?.sendAudio(frame);
      });
      if (attempt != _attempt) {
        await audio.silence();
        return;
      }
      opened = await backend.open(deviceId);
      if (attempt != _attempt) {
        await opened.close();
        await audio.silence();
        return;
      }
      _session = opened;
      _frames = opened.frames.listen(
        (frame) => _onFrame(attempt, frame),
        onDone: () => _onClosed(attempt),
      );
      _audio = opened.audio.listen((pcm16) {
        if (attempt == _attempt) audio.play(pcm16);
      });
    } catch (error) {
      if (attempt != _attempt) return;
      _cancelConnectDeadline();
      await opened?.close();
      await audio.silence();
      _session = null;
      phase = VoicePhase.ended;
      message = error is VoiceAudioRefusal
          ? error.message
          : 'Voice couldn’t connect. Check your connection and try again.';
      _notify();
    }
  }

  void _onFrame(int attempt, VoiceServerFrame frame) {
    if (attempt != _attempt || _disposed) return;
    switch (frame) {
      case VoiceReady():
        // A live session speaks what was waiting, so the rows clear here
        // rather than lingering behind a live conversation.
        _cancelConnectDeadline();
        waiting = const [];
        phase = VoicePhase.listening;
        message = null;
      case VoiceLiveState(:final speaking):
        phase = speaking ? VoicePhase.speaking : VoicePhase.listening;
      case VoiceTranscript(:final fromUser, :final text):
        if (fromUser) {
          youSaid = text;
        } else {
          botSaid = text;
        }
      case VoiceToolUse():
        // Tool calls and receipts never appear in voice captions.
        return;
      case VoiceInterrupted():
        unawaited(audio.interrupt());
        phase = VoicePhase.listening;
      case VoiceOffline(message: final sentence):
        _attempt += 1;
        unawaited(_release());
        phase = VoicePhase.ended;
        message = sentence;
    }
    _notify();
  }

  void _onClosed(int attempt) {
    if (attempt != _attempt || _disposed) return;
    // A socket that closes before `ready` is a session that never started, and
    // it must not leave "Connecting" on screen: the server has stopped talking,
    // so nothing else is coming.
    final connecting =
        phase == VoicePhase.connecting || phase == VoicePhase.resuming;
    if (!phase.live && !connecting) return;
    _attempt += 1;
    unawaited(_release());
    phase = VoicePhase.ended;
    message = connecting
        ? 'Voice couldn’t connect. Try again.'
        : 'Voice lost its connection. Leave and open Voice again.';
    _notify();
  }

  /// Arms the screen's own answer to a session that never becomes live.
  void _armConnectDeadline(int attempt) {
    _connectGuard?.cancel();
    _connectGuard = Timer(voiceConnectDeadline, () {
      if (attempt != _attempt || _disposed) return;
      _attempt += 1;
      _connectGuard = null;
      unawaited(_release());
      phase = VoicePhase.ended;
      message = 'Voice took too long to connect. Try again.';
      _notify();
    });
  }

  void _cancelConnectDeadline() {
    _connectGuard?.cancel();
    _connectGuard = null;
  }

  /// Stops the provider session outright. Bots are told nothing.
  Future<void> pause() async {
    if (!phase.live && phase != VoicePhase.resuming) return;
    _attempt += 1;
    _cancelConnectDeadline();
    final stopping = _session;
    _session = null;
    phase = VoicePhase.paused;
    message = null;
    _notify();
    await _frames?.cancel();
    await _audio?.cancel();
    _frames = null;
    _audio = null;
    await stopping?.stop();
    await audio.silence();
    await audio.interrupt();
    await refresh();
    _poll?.cancel();
    _poll = Timer.periodic(pollInterval, (_) => unawaited(refresh()));
  }

  /// Asks what has arrived while nobody was connected.
  Future<void> refresh() async {
    if (_disposed || phase != VoicePhase.paused) return;
    try {
      final answers = await backend.pendingAnswers();
      if (_disposed || phase != VoicePhase.paused) return;
      waiting = answers;
      _notify();
    } catch (_) {
      // A failed poll is not news: the last count stays until one succeeds.
    }
  }

  Future<void> _release() async {
    _poll?.cancel();
    _poll = null;
    _cancelConnectDeadline();
    final closing = _session;
    _session = null;
    await _frames?.cancel();
    await _audio?.cancel();
    _frames = null;
    _audio = null;
    await closing?.close();
    await audio.silence();
  }

  /// Leaves Voice entirely.
  Future<void> leave() async {
    _attempt += 1;
    _cancelConnectDeadline();
    final stopping = _session;
    _session = null;
    _poll?.cancel();
    _poll = null;
    await _frames?.cancel();
    await _audio?.cancel();
    _frames = null;
    _audio = null;
    await stopping?.stop();
    await audio.dispose();
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    _connectGuard?.cancel();
    unawaited(_frames?.cancel());
    unawaited(_audio?.cancel());
    unawaited(_session?.stop());
    unawaited(audio.dispose());
    super.dispose();
  }
}
