/// The continuous voice session: one call, all Bots, the footer's whole
/// state.
///
/// This implements `docs/voice.md` "Assistant protocol (v1)" and holds no
/// policy of its own beyond the one the document gives the client: an idle
/// upstream bills for silence, so put it to sleep after two minutes of quiet
/// and wake it on the next onset. A finished task can wake it too — the
/// server reopens Gemini and this client follows `voice/state` unless the
/// person paused.
///
/// An awake upstream gets a frame every 40 ms — speech, pauses and the
/// silence after a sentence alike. A capture with effective echo cancellation
/// keeps sending the room while the reply plays, so Gemini's detector owns the
/// barge-in decision; the local gate only stops playback sooner. A capture
/// without it sends silence while playback is audible and disables local
/// barge-in, because speaker echo is not evidence that a person spoke. The
/// gate is not consulted about individual frames.
///
/// A per-turn error from the server — a reply that produced no text, a
/// sentence that never became sound — is a notice on the call's surface for a
/// few seconds, not the end of the call. An error that carries a `code` is the
/// call itself failing — the server has already ended it — and so is a
/// refusal or this client's own failure. The server's end of the socket
/// finishing first ends a live conversation the same way. A Pause, or the
/// app off screen, keeps the call and opens a new socket when they come
/// back.
///
/// Nothing here caps how long a call may last. A sleeping upstream costs
/// nothing, so the footer may stay open silently for hours; what the server
/// meters is what it spends, and it says so itself.
///
/// A refused initial connect is retried once; a timeout is not. Then an
/// error the person can act on — a client that reconnects forever is a
/// client that spends money forever. A socket that dies while the person
/// paused, or while the app is off screen, is not that: the call stays up
/// and [enterForeground] opens a new socket onto the same durable call.
library;

import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';

import 'capture.dart';
import 'connect_sound.dart';
import 'diagnostics.dart';
import 'player.dart';
import 'protocol.dart';
import 'route.dart';
import 'socket.dart';
import 'speech_classifier.dart';
import 'speech_gate.dart';
import 'waveform.dart' show VoiceMeterMode;

enum VoiceSessionPhase { idle, connecting, live, ending, ended, error }

/// One subagent the call has handed work to (ADR 0031), as the activity slot
/// lists it.
///
/// The ledger is per Turn, because that is what the `voice/delegation` frame
/// names: a later frame about the same [runId] moves the entry rather than
/// adding a second one, and a second hand-off — which is a second Turn, even
/// on the same Bot — opens its own. [finishedWhilePaused] is what the Resume
/// badge counts — work that landed while nothing was listening is the thing
/// the person missed.
class VoiceDelegationEntryV1 {
  final String botId;
  final String botName;

  /// The Turn the request became; what the chip opens.
  final String runId;
  final VoiceDelegationStateV1 state;
  final bool finishedWhilePaused;
  const VoiceDelegationEntryV1({
    required this.botId,
    required this.botName,
    required this.runId,
    required this.state,
    this.finishedWhilePaused = false,
  });

  bool get finished => state == VoiceDelegationStateV1.finished;
}

class AssistantSessionController extends ChangeNotifier {
  final VoiceSocketOpener openSocket;
  final VoiceCapture capture;
  final VoicePlayer player;
  final VoiceAudioRoute route;
  final SpeechGateConfig gateConfig;
  final SpeechClassifier speechClassifier;
  final VoiceConnectSound connectSound;
  final Duration startTimeout;
  final Duration sleepAfter;
  final Duration connectTimeout;

  /// The Bot this call opens on (ADR 0029). Null talks to General.
  final String? botId;

  /// This call's latency diagnostics, or null — which is every shipped build
  /// ([voiceDiagnosticsEnabledV1]). The same object gave the socket opener the
  /// `trace` this call's query carries, so the two sides' lines correlate.
  ///
  /// What each milestone means. These are per-name meanings, not one order for
  /// the whole call: [start] opens the socket beside the route and the capture,
  /// so `socket.open` is marked before `route.begin`, and the socket's own
  /// lines (`socket.ready`, `socket.welcome`, `upstream.*`, `call.listening`,
  /// `audio.first-down`) land whenever that attempt and its frames arrive,
  /// interleaved with the capture opening.
  ///
  /// * `controller.start` — [start] entered; the person has pressed voice.
  /// * `route.begin` / `route.ready` — around the platform audio session
  ///   ([VoiceAudioRoute.begin]). On macOS and the web this is a no-op and the
  ///   two are adjacent; on Android the gap is the platform applying mode,
  ///   focus and route.
  /// * `capture.open` / `capture.ready` — around opening the microphone. The
  ///   gap includes the permission prompt the first time, so a large one is
  ///   usually a person reading a dialog. Repeated on an unmute, which reopens
  ///   the device.
  /// * `socket.open` / `socket.ready` — around one connect attempt, each
  ///   carrying `attempt`. The gap is DNS, TLS and the upgrade round trip.
  /// * `socket.welcome` — the server's `welcome` frame arrived.
  /// * `call.start-sent` — `start_call` went out, with `openingFrames`: how
  ///   much audio was captured before the handshake and is about to be
  ///   drained behind it.
  /// * `microphone.first-frame` — the first frame the device handed over, with
  ///   `silent` when it is under [voiceRoomToneLevelV1]. A device returning
  ///   zeros still produces this one, which is how a deaf capture is told from
  ///   one that never opened.
  /// * `microphone.first-signal` — the first frame carrying the room at all.
  /// * `microphone.first-speech` — the first frame the gate called speech.
  ///   Not a transcript and not a word: Silero's probability when the
  ///   classifier is up, otherwise an amplitude decision.
  /// * `upstream.asleep` / `upstream.starting` / `upstream.awake` — the first
  ///   `voice/state` frame saying each; `awake` means the server's Live session
  ///   acknowledged its setup.
  /// * `call.listening` — the first `status: listening`: the call is live.
  /// * `audio.first-down` — the first audio frame this client received, with
  ///   its `bytes`. The reply exists at this point; nobody has heard it.
  /// * `player.first-feed` / `player.first-played` — the speaker seam, whose
  ///   exact meanings are in `player.dart`. Neither is the audible start.
  /// * `call.end` (with `reason`, the path that ended it), `call.ended` (the
  ///   server's end of the socket finished first) or `call.failed` — the
  ///   failure's sentence is shown to the person, never logged.
  ///
  /// Every `elapsedMs` here is this process's monotonic clock from
  /// `controller.start`. The server's own lines are elapsed on the server's
  /// clock from its own start, and the two are never subtracted.
  final VoiceDiagnostics? diagnostics;

  AssistantSessionController({
    required this.openSocket,
    required this.capture,
    required this.player,
    this.botId,
    this.diagnostics,
    VoiceAudioRoute? route,
    this.gateConfig = const SpeechGateConfig(),
    this.speechClassifier = const EnergySpeechClassifier(),
    this.connectSound = const SilentVoiceConnectSound(),
    this.startTimeout = voiceAssistantStartTimeoutV1,
    this.sleepAfter = voiceAssistantSleepAfterV1,
    this.connectTimeout = voiceAssistantConnectTimeoutV1,
  }) : route = route ?? NoVoiceAudioRoute();

  VoiceSessionPhase _phase = VoiceSessionPhase.idle;
  VoiceStatusV1 _status = VoiceStatusV1.idle;
  VoiceUpstreamStateV1 _upstream = VoiceUpstreamStateV1.starting;
  String? _error;

  /// The line a call that ended on its own leaves on the surface, or null:
  /// the server's end of the socket finished first. Nothing failed and there
  /// is nothing to retry, so it is not an error — but the call is over, and
  /// no surface may go on saying it is live.
  String? _endedLine;

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

  /// The server has said `welcome`; the handshake goes out once the
  /// microphone is open too.
  bool _welcomed = false;
  bool _barged = false;

  /// The connect chime has played for this call. A later `listening` — wake,
  /// rejoin — does not play it again. [start] clears it.
  bool _chimed = false;

  /// The Bot the call is with, as the server last said. Read by the shell so
  /// the screen and the composer control follow the voice.
  String? _currentBotId;
  bool _disposed = false;
  double _micLevel = 0;
  String? _notice;
  Timer? _noticeTimer;

  /// Whether the microphone has carried the room at all on this call — at or
  /// above [voiceRoomToneLevelV1], the level a working device picks up from
  /// an empty one — and whether the one notice about never hearing it has
  /// been given. Between them they settle the question a live call asks: is
  /// this microphone being heard at all?
  bool _microphoneHeard = false;
  bool _deafNoticed = false;

  /// When the search for a signal started, on the capture's own clock: the
  /// first frame after the call went live, and again after a frame the call
  /// was not listening to at all. Null until such a frame has started it, and
  /// again once the capture reopens and its clock starts over.
  int? _deafSinceMs;

  /// The call's teardown, run once. The first path that ends the call runs
  /// it and every later one — a failure that lands after the end, the shell
  /// disposing the session — finds that same work rather than issuing a
  /// second round of platform calls on devices the next call may already
  /// hold.
  Future<void>? _teardownDone;
  String? _delegatedBotId;
  String? _delegatedBotName;
  VoiceDelegationStateV1? _delegationState;
  Timer? _delegationTimer;

  /// Every subagent this call has handed work to, one entry per Turn, in the
  /// order it was first asked. Unlike the three fields above — which are the
  /// footer's one transient rise — the ledger is the call's, and outlives
  /// each frame.
  final List<VoiceDelegationEntryV1> _delegations = [];

  /// Whether the person put the call to sleep. Distinct from [_asleep],
  /// which the gate also sets: a paused call sends nothing and wakes
  /// for nothing but Resume.
  bool _paused = false;

  /// The app is off screen. Distinct from [_paused]: a Pause the person
  /// started stays paused when they come back, and a sleep this flag caused
  /// resumes on its own. Capture is closed for the whole of it so the
  /// microphone is not held in the background.
  bool _away = false;
  bool _pausedForAway = false;

  /// Completes when a reconnect's `start_call` has gone out, so Resume
  /// cannot beat the handshake.
  Completer<void>? _handshake;
  Future<void>? _rejoining;

  /// Resume ran before `start_call` went out on a reconnect. The wake waits
  /// for the handshake so it is not dropped on a socket that has no call.
  bool _pendingWake = false;

  /// How long a notice about the last reply stays on the call's surface.
  static const noticeDuration = Duration(seconds: 4);

  Uint8List? _silence;

  late SpeechGate _gate = SpeechGate(config: gateConfig);

  /// Whether this session began the shared audio session. The route is begun
  /// before the microphone opens and ended once the call is done, and only
  /// the session that began it may end it: one disposed before it ever
  /// started has no claim on the audio to release.
  bool _routeBegun = false;
  VoiceSocket? _socket;
  StreamSubscription<VoiceFocusChange>? _focus;
  StreamSubscription<AudioFrame>? _frames;
  StreamSubscription<Object?>? _inbound;
  Timer? _startTimer;

  /// Which start this is. Every await inside a start checks it before acting,
  /// so a call ended while the person was still answering the permission
  /// prompt cannot resurrect a capture behind them.
  int _generation = 0;
  bool _reportedPlaying = false;

  /// Audio captured before `start_call` went out, bounded at 10 s and drained
  /// in order once it has.
  final ListQueue<Uint8List> _opening = ListQueue<Uint8List>();
  int _openingBytes = 0;

  VoiceSessionPhase get phase => _phase;
  VoiceStatusV1 get status => _status;
  VoiceUpstreamStateV1 get upstream => _upstream;
  String? get error => _error;

  /// The line a call that ended without the person asking says about itself,
  /// or null. A failure has [error]; a call the person ended has a surface
  /// that is already going away.
  String? get endedLine => _endedLine;

  /// A sentence about the last reply, shown for [noticeDuration].
  String? get notice => _notice;
  String? get delegatedBotId => _delegatedBotId;
  String? get delegatedBotName => _delegatedBotName;
  VoiceDelegationStateV1? get delegationState => _delegationState;

  /// The activity slot's whole content: one entry per hand-off this call made.
  List<VoiceDelegationEntryV1> get delegations =>
      List.unmodifiable(_delegations);

  /// Whether the person paused the call. The upstream is asleep and nothing
  /// is being listened to or spoken.
  bool get paused => _paused;

  /// How many subagents finished while the call was paused: the count the
  /// Resume pill wears.
  int get finishedWhilePaused =>
      _delegations.where((entry) => entry.finishedWhilePaused).length;

  /// Whether the reply is being heard: the server says it is speaking, or the
  /// speaker still has audio to play after the server moved on.
  bool get _playing => _status == VoiceStatusV1.speaking || player.playing;

  /// Whether this client is sending. Either input is enough to stop it.
  bool get muted => _userMuted || _microphoneHeld;

  /// The person's own toggle, which is what the footer's control changes.
  bool get userMuted => _userMuted;

  /// Whether the upstream is asleep because this client stopped sending.
  bool get asleep => _asleep;
  double get micLevel => _micLevel;
  double get playbackLevel => player.level;

  /// What the meter shows when no sound decides it, in the order that
  /// matters: a call that is not live has no state to show, a held or muted
  /// microphone is stillness whatever the server is doing, and the reply
  /// being heard outranks the status that announced it.
  VoiceMeterMode get meterMode {
    if (_phase == VoiceSessionPhase.connecting) {
      return VoiceMeterMode.connecting;
    }
    if (_phase != VoiceSessionPhase.live) return VoiceMeterMode.resting;
    if (muted) return VoiceMeterMode.muted;
    if (_playing) return VoiceMeterMode.speaking;
    if (_status == VoiceStatusV1.thinking) return VoiceMeterMode.thinking;
    if (_asleep) return VoiceMeterMode.asleep;
    return VoiceMeterMode.listening;
  }

  bool get active =>
      _phase == VoiceSessionPhase.connecting ||
      _phase == VoiceSessionPhase.live ||
      _phase == VoiceSessionPhase.ending;

  /// This call's devices, closed: the teardown's own work, or already done
  /// where no teardown has run. The shell owns the capture and the audio
  /// route and lends them to one call at a time, so it waits here before the
  /// next call opens them — a teardown still in flight must not land on the
  /// audio session that followed it. Disposal cannot wait, which is why it
  /// is asked apart from [dispose].
  Future<void> get released => _teardownDone ?? Future<void>.value();

  /// Opens the call: the microphone and the socket at the same time, so the
  /// slow part of each — the permission prompt, the upgrade round trip — is
  /// paid once rather than twice over. The handshake itself waits for both:
  /// `start_call` wakes a metered upstream, and it is not sent while the
  /// person is still answering the permission prompt.
  Future<void> start() async {
    if (active || _disposed) return;
    final generation = ++_generation;
    _error = null;
    _endedLine = null;
    _userMuted = false;
    _microphoneHeld = false;
    _asleep = false;
    _paused = false;
    _away = false;
    _pausedForAway = false;
    _pendingWake = false;
    _started = false;
    _welcomed = false;
    _barged = false;
    _chimed = false;
    _status = VoiceStatusV1.idle;
    _upstream = VoiceUpstreamStateV1.starting;
    _gate = SpeechGate(config: gateConfig);
    speechClassifier.reset();
    unawaited(speechClassifier.prepare());
    _teardownDone = null;
    _opening.clear();
    _openingBytes = 0;
    _microphoneHeard = false;
    _deafNoticed = false;
    _deafSinceMs = null;
    _clearNotice();
    _clearDelegation();
    _set(VoiceSessionPhase.connecting);
    final diagnostics = this.diagnostics;
    diagnostics?.mark('controller.start');
    // The speaker reports its own two seams through a plain callback, which
    // this call holds for as long as it holds the player.
    player.onDiagnostic = diagnostics == null
        ? null
        : (event) => diagnostics.markOnce(event);
    player.addListener(_onPlayback);
    final connecting = _connect(generation);
    // The session before the devices: the mode decides how the microphone
    // and the speaker are opened, so it is set before either is — and this
    // call now holds it until its teardown gives it back.
    _routeBegun = true;
    diagnostics?.mark('route.begin');
    await _settled(route.begin);
    diagnostics?.mark('route.ready');
    if (generation != _generation || _disposed) {
      unawaited(connecting.then(_abandon));
      return;
    }
    _focus ??= route.focus.listen(_onFocus);
    final captured = await _openCapture(generation);
    if (!captured) {
      // The connect that is still in flight answers to the generation check
      // below when it lands, and a socket that arrives then is abandoned.
      unawaited(connecting.then(_abandon));
      return;
    }
    _armStartTimer();
    _beginCall();
    final socket = await connecting;
    if (socket == null) return;
    if (generation != _generation || _disposed || !active) {
      await _abandon(socket);
      await _closeCapture();
      return;
    }
    _attach(socket);
  }

  Future<void> _abandon(VoiceSocket? socket) async {
    if (socket == null) return;
    await socket.close(
      code: voiceCloseAbandonedV1,
      reason: 'abandoned-connect',
    );
  }

  /// The socket is attached the moment it arrives — the `welcome` may land
  /// while the microphone is still opening — and [start] finishes the rest.
  Future<VoiceSocket?> _connect(int generation) async {
    final socket = await _connectOnce(generation);
    if (socket == null) return null;
    if (generation != _generation || _disposed || !active) {
      await _abandon(socket);
      return null;
    }
    _attach(socket);
    return socket;
  }

  void _attach(VoiceSocket socket) {
    if (identical(_socket, socket)) return;
    _socket = socket;
    _inbound = socket.messages.listen(
      _onMessage,
      onError: (Object _) => unawaited(_fail('Voice stopped. Try again.')),
      onDone: () => unawaited(_socketDropped()),
    );
    _armStartTimer();
  }

  /// The start timeout covers the server, not the permission prompt: it runs
  /// once both the socket and the microphone are open.
  void _armStartTimer() {
    if (_socket == null || _frames == null) return;
    _startTimer ??= Timer(startTimeout, () {
      if (_status != VoiceStatusV1.listening) {
        unawaited(_fail('Voice didn’t start. Try again.'));
      }
    });
  }

  /// A live call that has carried nothing but zeros for
  /// [voiceAssistantDeafNoticeAfterV1] says so, once, because a call can be up
  /// and deaf: the microphone open and handing over no signal at all, which is
  /// what the documented macOS voice-processing unit produces (`capture.dart`).
  /// It is a notice and not an error — the call is fine and the microphone is
  /// the problem — and it never ends the call. A microphone nobody is talking
  /// into still carries the room, which is why the line is room tone and not
  /// the gate's speech floor: waiting for words would call a quiet person
  /// deaf.
  ///
  /// The capture's own clock is the clock here, as it is for the gate's quiet
  /// window: the frames carry it, so a test runs the window out in a
  /// millisecond. A frame the call is not listening to at all — before it is
  /// live, or while the person has it paused, both of which are silence by
  /// somebody's choice rather than a microphone nobody can hear — starts the
  /// window again rather than counting: a call that never carried signal is
  /// not the same as one whose person stopped talking, and only the first is
  /// ever said.
  void _watchForDeafness(int atMs) {
    if (_microphoneHeard ||
        _deafNoticed ||
        _phase != VoiceSessionPhase.live ||
        muted ||
        _paused) {
      _deafSinceMs = null;
      return;
    }
    final since = _deafSinceMs ??= atMs;
    if (atMs - since < voiceAssistantDeafNoticeAfterV1.inMilliseconds) return;
    _deafNoticed = true;
    _showNotice(
      'FrockBot isn’t hearing anything. Check the microphone in your device settings.',
    );
  }

  /// One attempt gets the full connect timeout. A timeout is the object
  /// still starting, so it is not retried — a second upgrade would only
  /// race the first. A refused socket is retried once, then it is an
  /// error, not a loop. A reconnect whose upgrade fails is not that
  /// error: the call is still up, and the next return to the screen tries
  /// again.
  Future<VoiceSocket?> _connectOnce(int generation, {bool fatal = true}) async {
    var attempts = 0;
    Future<VoiceSocket> attempt() async {
      final at = ++attempts;
      diagnostics?.mark('socket.open', {'attempt': at});
      final pending = openSocket();
      try {
        final socket = await pending.timeout(connectTimeout);
        diagnostics?.mark('socket.ready', {'attempt': at});
        return socket;
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
        rethrow;
      }
    }

    try {
      return await attempt();
    } on TimeoutException {
      if (generation != _generation || _disposed) return null;
      if (fatal) {
        await _fail(
          'Couldn’t reach voice. Check your connection and try again.',
        );
      }
      return null;
    } on Object {
      if (generation != _generation || _disposed) return null;
      try {
        return await attempt();
      } on Object {
        if (generation != _generation || _disposed) return null;
        if (fatal) {
          await _fail(
            'Couldn’t reach voice. Check your connection and try again.',
          );
        }
        return null;
      }
    }
  }

  /// Opens the microphone behind the start fence.
  ///
  /// The permission prompt is the slow part and the person may end the call
  /// while it is up. Whatever the prompt eventually answers, a capture that
  /// belongs to a call that is over is stopped rather than listened to.
  Future<bool> _openCapture(int generation) async {
    try {
      diagnostics?.mark('capture.open');
      final frames = await capture.start(
        sampleRate: voiceAssistantInputSampleRateV1,
        frame: voiceAssistantFrame,
        profile: VoiceCaptureProfile.call,
      );
      diagnostics?.mark('capture.ready');
      if (generation != _generation || _disposed) {
        await capture.stop();
        return false;
      }
      // The frames carry the capture's clock and it starts at zero every time
      // the device opens, so a window started on the previous one is not a
      // window on this one.
      _deafSinceMs = null;
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
    if (_disposed) return;
    _micLevel = frame.level;
    final diagnostics = this.diagnostics;
    if (diagnostics != null) {
      // Three separate questions, and a call can fail any one of them: did the
      // device hand anything over at all, was any of it above the nothing a
      // deaf capture returns, and did the gate ever hear words.
      diagnostics.markOnce('microphone.first-frame', {
        'silent': frame.level < voiceRoomToneLevelV1,
      });
      if (frame.level >= voiceRoomToneLevelV1) {
        diagnostics.markOnce('microphone.first-signal');
      }
    }
    // The one thing a deaf call never has: the room the microphone is
    // listening to. Room tone is a working device, not speech — the gate's
    // floor is where words start — so only a device handing over zeros
    // stays under this line.
    if (!_microphoneHeard && frame.level >= voiceRoomToneLevelV1) {
      _microphoneHeard = true;
    }
    _watchForDeafness(frame.atMs);
    speechClassifier.offer(frame.bytes);
    final decision = _gate.offer(
      frame.bytes,
      frame.level,
      frame.atMs,
      speechScore: speechClassifier.ready ? speechClassifier.probability : null,
    );
    if (decision.open) diagnostics?.markOnce('microphone.first-speech');
    // A capture with AEC lets Gemini hear the room throughout playback. The
    // local gate may stop the speaker sooner, but Gemini's VAD remains the
    // authority on whether the model turn was interrupted. Without AEC,
    // speaker energy is not evidence of a barge-in and must never trip this.
    if (capture.cancelsPlaybackEcho &&
        decision.bargeIn &&
        _playing &&
        !muted &&
        !_barged) {
      _barged = true;
      unawaited(player.interrupt());
      _socket?.sendText(encodeAssistantInterruptV1());
    }
    _notify();
    if (muted || !active) return;
    // A paused call is not listening: the gate's onset must not wake an
    // upstream the person deliberately put to sleep.
    if (_paused) return;
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
      // The pre-roll is captured audio like any other and obeys the same
      // rule as the live frames below.
      for (final piece in decision.emit) {
        socket.sendBinary(_outbound(piece));
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
    // Awake means a frame every 40 ms, speech and silence alike, through
    // pauses and while the assistant is thinking. The server's transcriber
    // decides where a turn ends and needs the silence after the words to
    // decide it — about half a second; a client that cut the audio off right
    // after the last syllable would leave the transcript hanging until the
    // upstream timed out. What each frame carries is [_outbound]'s rule.
    socket.sendBinary(_outbound(frame.bytes));
  }

  /// What may go on the wire for one piece of captured audio.
  ///
  /// During playback, a device with effective AEC sends the cleaned
  /// microphone continuously and Gemini's VAD decides whether the person
  /// interrupted. A device without AEC sends silence until the speaker has
  /// drained: its own output is indistinguishable from the person, so it can
  /// neither offer barge-in nor let the model hear the speaker.
  Uint8List _outbound(Uint8List captured) =>
      _playing && !capture.cancelsPlaybackEcho
      ? _silentFrame(captured.length)
      : captured;

  Uint8List _silentFrame(int length) {
    final cached = _silence;
    if (cached != null && cached.length == length) return cached;
    return _silence = Uint8List(length);
  }

  void _onMessage(Object? message) {
    // A disposed controller keeps its socket and capture alive until the
    // teardown's awaits finish; it must issue no further speaker commands,
    // because the app has already built the next session's player.
    if (_disposed || !active || _phase == VoiceSessionPhase.ending) return;
    if (message is List<int>) {
      diagnostics?.markOnce('audio.first-down', {'bytes': message.length});
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
        diagnostics?.markOnce('socket.welcome');
        _welcomed = true;
        _beginCall();
      case AssistantStatusV1(:final status):
        _status = status;
        if (status != VoiceStatusV1.speaking) {
          _barged = false;
        }
        if (status == VoiceStatusV1.listening) {
          diagnostics?.markOnce('call.listening');
          _startTimer?.cancel();
          _startTimer = null;
          if (!_asleep) _upstream = VoiceUpstreamStateV1.awake;
          _set(VoiceSessionPhase.live);
          // Once per call. A wake and a rejoin both say listening again,
          // and neither is someone picking up.
          if (!_chimed) {
            _chimed = true;
            unawaited(connectSound.play());
          }
        }
        _notify();
      case AssistantAudioConfigV1(:final sampleRate):
        unawaited(
          player.configure(sampleRate ?? voiceAssistantOutputSampleRateV1),
        );
      case AssistantPlaybackInterruptV1():
        unawaited(player.interrupt());
      case AssistantVoiceTargetV1(:final botId):
        // The call is with this Bot now, whether this client asked for the
        // move or the Bot handed the conversation over itself (ADR 0029).
        if (_currentBotId != botId) {
          _currentBotId = botId;
          _notify();
        }
      case AssistantVoiceStateV1(:final upstream):
        // The server reports its own view of the mute; the two inputs that
        // produced it are this client's and are not overwritten by it.
        diagnostics?.markOnce('upstream.${upstream.name}');
        _upstream = upstream;
        // A finished task unhibernates from the server. Follow that unless
        // the person paused — Pause waits for Resume, not for Gemini.
        if (!_paused &&
            (upstream == VoiceUpstreamStateV1.starting ||
                upstream == VoiceUpstreamStateV1.awake)) {
          _asleep = false;
        }
        _notify();
      case AssistantDelegationV1(
        :final botId,
        :final botName,
        :final runId,
        :final state,
      ):
        _record(botId, botName, runId, state);
        _delegationTimer?.cancel();
        _delegatedBotId = botId;
        _delegatedBotName = botName;
        _delegationState = state;
        if (state == VoiceDelegationStateV1.finished) {
          _delegationTimer = Timer(const Duration(milliseconds: 1200), () {
            _delegatedBotId = null;
            _delegatedBotName = null;
            _delegationState = null;
            _notify();
          });
        }
        _notify();
      case AssistantRefusalV1(:final code):
        unawaited(_fail(voiceRefusalMessage(code)));
      case AssistantErrorV1(:final code):
        if (code != null) {
          // A coded error is the call itself failing — the server has already
          // torn it down and stopped listening. Only a per-turn error, which
          // carries no code, is a notice.
          unawaited(_fail('Voice stopped. Try again.'));
          return;
        }
        // One reply failed — no text, or a sentence that never became sound.
        // The server is still listening; so is this client.
        _showNotice('That reply didn’t come through. Say it again.');
      case AssistantTranscriptV1():
      case AssistantDiagnosticV1():
        // The footer shows no transcript and no diagnostics.
        break;
    }
  }

  /// Another app's claim on the audio. A transient one — a ringtone, a
  /// navigation prompt — lends the microphone out the way dictation does and
  /// stops the reply, so the call comes back as the person left it. One for
  /// good — a phone call answered — ends this call with a sentence.
  void _onFocus(VoiceFocusChange change) {
    if (!active || _phase == VoiceSessionPhase.ending) return;
    switch (change) {
      case VoiceFocusChange.paused:
        unawaited(player.interrupt());
        if (_playing) _socket?.sendText(encodeAssistantInterruptV1());
        unawaited(holdMicrophone(true));
      case VoiceFocusChange.regained:
        unawaited(holdMicrophone(false));
      case VoiceFocusChange.lost:
        unawaited(
          _fail(
            'Another app took the audio. Start voice again when you’re ready.',
          ),
        );
    }
  }

  /// `hello` and `start_call`, once the server has welcomed and the
  /// microphone is open: the opening audio goes up behind them in order.
  /// A reconnect while paused or muted has no microphone yet and still
  /// starts the call — Gemini stays asleep until Resume or unmute.
  void _beginCall() {
    final socket = _socket;
    if (socket == null || !_welcomed || _started) return;
    if (_frames == null && !muted && !_paused) return;
    socket.sendText(encodeAssistantHelloV1());
    // Who the call is with, before it starts: the SDK's own frame has no
    // room for it, and the server needs it to build the first prompt.
    final target = botId;
    if (target != null && target.isNotEmpty) {
      socket.sendText(encodeVoiceTargetV1(target));
    }
    socket.sendText(encodeAssistantStartCallV1());
    diagnostics?.markOnce('call.start-sent', {
      'openingFrames': _opening.length,
    });
    _started = true;
    while (_opening.isNotEmpty) {
      socket.sendBinary(_opening.removeFirst());
    }
    _openingBytes = 0;
    if (_pendingWake) {
      _pendingWake = false;
      socket.sendText(encodeVoiceWakeV1());
    } else if (_paused) {
      socket.sendText(encodeVoiceSleepV1(paused: true));
    } else if (muted) {
      socket.sendText(encodeVoiceMuteV1(true));
    }
    final handshake = _handshake;
    if (handshake != null && !handshake.isCompleted) handshake.complete();
  }

  /// Points an open call at another Bot (ADR 0029).
  ///
  /// The audio stays up: this is the same call with somebody else on the
  /// other end. The server moves its own record and tells every client, so a
  /// screen that was already following stays right.
  void retarget(String botId) {
    if (botId.isEmpty || !_started) return;
    _socket?.sendText(encodeVoiceTargetV1(botId));
  }

  /// The Bot the call is with right now (ADR 0029). Null before the server
  /// has said, which is only the moment before the call is admitted.
  String? get currentBotId => _currentBotId;

  void _onPlayback() {
    final playing = player.playing;
    if (active &&
        _phase != VoiceSessionPhase.ending &&
        playing != _reportedPlaying) {
      _reportedPlaying = playing;
      _socket?.sendText(encodeVoiceSpeechV1(playing));
    }
    _notify();
  }

  void _showNotice(String message) {
    _notice = message;
    _noticeTimer?.cancel();
    _noticeTimer = Timer(noticeDuration, () {
      _noticeTimer = null;
      _notice = null;
      _notify();
    });
    _notify();
  }

  void _clearNotice() {
    _noticeTimer?.cancel();
    _noticeTimer = null;
    _notice = null;
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
    speechClassifier.reset();
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
  /// [reason] names the path that ended it — the End button, the view
  /// detaching — and travels in the socket's close frame, where the
  /// server logs it. A Pause whose socket the OS already killed reconnects
  /// just long enough to say `end_call`, so the accordion is this hang-up
  /// and not the abandoned-call alarm a day later.
  Future<void> end({required String reason}) async {
    if (_phase == VoiceSessionPhase.idle || _phase == VoiceSessionPhase.ended) {
      return;
    }
    if (_rejoining != null) await _rejoining;
    if (!_started) {
      final handshake = _handshake;
      if (handshake != null && !handshake.isCompleted) {
        await handshake.future.timeout(startTimeout, onTimeout: () {});
      } else if (_socket == null &&
          active &&
          _phase != VoiceSessionPhase.ending) {
        await _rejoin(waitForHandshake: true);
      }
    }
    _generation++;
    // The path that ended it, which is a token this app names — never
    // anything the person said or the server sent.
    diagnostics?.mark('call.end', {'reason': reason});
    _set(VoiceSessionPhase.ending);
    final socket = _socket;
    await _settled(() async => socket?.sendText(encodeAssistantEndCallV1()));
    await _teardown(reason: reason);
    _status = VoiceStatusV1.idle;
    _set(VoiceSessionPhase.ended);
  }

  /// The server's end of the socket finished first. A live conversation
  /// treats that as the call ending. A Pause, or the app off screen, does
  /// not: the durable call is still there, and a new socket continues it.
  Future<void> _socketDropped() async {
    if (_disposed ||
        _error != null ||
        !active ||
        _phase == VoiceSessionPhase.ending) {
      return;
    }
    final keep = _phase == VoiceSessionPhase.live && (_away || _paused);
    if (!keep) {
      await _ended();
      return;
    }
    _inbound = null;
    _socket = null;
    _welcomed = false;
    _started = false;
    _startTimer?.cancel();
    _startTimer = null;
    diagnostics?.mark('call.socket-dropped');
    _notify();
    if (!_away) unawaited(_rejoin());
  }

  /// Opens a new socket onto the durable call. Used when the OS killed the
  /// last one while the person still had this call, and when hang-up has
  /// to reach the server after that.
  Future<void> _rejoin({bool waitForHandshake = false}) {
    return _rejoining ??= _rejoinNow(waitForHandshake: waitForHandshake)
        .whenComplete(() {
          _rejoining = null;
        });
  }

  Future<void> _rejoinNow({required bool waitForHandshake}) async {
    if (_socket != null ||
        _disposed ||
        !active ||
        _phase == VoiceSessionPhase.ending) {
      return;
    }
    final generation = _generation;
    _welcomed = false;
    _started = false;
    _opening.clear();
    _openingBytes = 0;
    final handshake = Completer<void>();
    _handshake = handshake;
    try {
      final socket = await _connectOnce(generation, fatal: false);
      if (socket == null) return;
      if (generation != _generation ||
          _disposed ||
          !active ||
          _phase == VoiceSessionPhase.ending) {
        await _abandon(socket);
        return;
      }
      _attach(socket);
      if (waitForHandshake && !_started) {
        await handshake.future.timeout(startTimeout, onTimeout: () {});
      }
    } finally {
      if (waitForHandshake &&
          identical(_handshake, handshake) &&
          !handshake.isCompleted) {
        handshake.complete();
      }
    }
  }

  /// The server's end of the socket finished first: the call is over and
  /// nobody asked for it to be. Nothing failed and there is nothing to act
  /// on, so it is not an error — but it is an end, and the surface says so
  /// rather than going on claiming a live call.
  ///
  /// A failure already under way and the person's own end both outrank it:
  /// the failure has the line that explains it, and a call the person ended
  /// has a surface that is already going away.
  Future<void> _ended() async {
    if (_disposed ||
        _error != null ||
        !active ||
        _phase == VoiceSessionPhase.ending) {
      return;
    }
    _generation++;
    diagnostics?.mark('call.ended');
    _endedLine = 'The call ended.';
    _notify();
    await _teardown(reason: 'server-closed');
    _status = VoiceStatusV1.idle;
    _set(VoiceSessionPhase.ended);
  }

  Future<void> _fail(String message) async {
    if (_phase == VoiceSessionPhase.error) return;
    _generation++;
    // The sentence is for the person, not the log: a failure is a milestone
    // here and nothing more.
    diagnostics?.mark('call.failed', {'phase': _phase.name});
    _error = message;
    // Say so now, before the teardown's awaits: the call's surface shows the
    // failure the moment it is known, not after the socket has finished
    // closing.
    _notify();
    await _teardown(code: voiceCloseFailedV1, reason: message);
    _status = VoiceStatusV1.idle;
    _set(VoiceSessionPhase.error);
  }

  /// One teardown for one call. Whichever path ends it — the End control, a
  /// failure, the server closing first, the shell disposing the session —
  /// the first one runs the work and the rest wait on it rather than closing
  /// the microphone, the speaker and the audio session a second time, on
  /// devices the call after this one may already hold.
  Future<void> _teardown({int code = voiceCloseNormalV1, String reason = ''}) =>
      _teardownDone ??= _teardownNow(code: code, reason: reason);

  Future<void> _teardownNow({required int code, required String reason}) async {
    _reportedPlaying = false;
    _startTimer?.cancel();
    _startTimer = null;
    _clearNotice();
    _clearDelegation();
    await _settled(_closeCapture);
    final inbound = _inbound;
    _inbound = null;
    await _settled(() async => inbound?.cancel());
    final socket = _socket;
    _socket = null;
    await _settled(player.close);
    player.removeListener(_onPlayback);
    player.onDiagnostic = null;
    final focus = _focus;
    _focus = null;
    await _settled(() async => focus?.cancel());
    // The devices are closed; now the session they were opened in — and only
    // if this call is the one that opened it. A session disposed before it
    // started issued no `begin`, so it has nothing to give back and must not
    // take the session away from a call that does.
    if (_routeBegun) {
      _routeBegun = false;
      await _settled(route.end);
    }
    await _settled(() async => socket?.close(code: code, reason: reason));
    await _settled(speechClassifier.dispose);
    await _settled(connectSound.dispose);
    _micLevel = 0;
    _opening.clear();
    _openingBytes = 0;
    _started = false;
    _welcomed = false;
    _paused = false;
    _away = false;
    _pausedForAway = false;
    _rejoining = null;
    _pendingWake = false;
    final handshake = _handshake;
    _handshake = null;
    if (handshake != null && !handshake.isCompleted) handshake.complete();
  }

  /// A recorder, a speaker or a socket that fails to close — or to carry the
  /// goodbye frame — is not a reason
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

  void _clearDelegation() {
    _delegationTimer?.cancel();
    _delegationTimer = null;
    _delegatedBotId = null;
    _delegatedBotName = null;
    _delegationState = null;
    _delegations.clear();
  }

  /// Moves the ledger's entry for one hand-off, or opens it. A finish that
  /// lands while the call is paused is marked, because the Resume pill counts
  /// them.
  void _record(
    String botId,
    String botName,
    String runId,
    VoiceDelegationStateV1 state,
  ) {
    final entry = VoiceDelegationEntryV1(
      botId: botId,
      botName: botName,
      runId: runId,
      state: state,
      finishedWhilePaused: _paused && state == VoiceDelegationStateV1.finished,
    );
    final at = _delegations.indexWhere((item) => item.runId == runId);
    if (at < 0) {
      _delegations.add(entry);
      return;
    }
    // A hand-off reported twice keeps its place in the slot; only a finish
    // that already counted stays counted.
    _delegations[at] = entry.finishedWhilePaused || !_delegations[at].finished
        ? entry
        : VoiceDelegationEntryV1(
            botId: botId,
            botName: botName,
            runId: runId,
            state: state,
            finishedWhilePaused: _delegations[at].finishedWhilePaused,
          );
  }

  /// The person's own pause (ADR 0031): the upstream sleeps, the reply stops,
  /// and nothing wakes it but [resume]. Subagents already admitted carry on —
  /// their work is a Turn in the Bot, not this socket's — and what they
  /// finish is counted for the Resume pill.
  void pause() {
    if (_paused || !active) return;
    _paused = true;
    _asleep = true;
    _upstream = VoiceUpstreamStateV1.asleep;
    _gate.reset();
    speechClassifier.reset();
    unawaited(player.interrupt());
    _socket?.sendText(encodeVoiceSleepV1(paused: true));
    _notify();
  }

  /// Back on the line. The badge's count is spent the moment the person has
  /// been told, so it starts again at nothing.
  void resume() {
    if (!_paused) return;
    _paused = false;
    _asleep = false;
    _upstream = VoiceUpstreamStateV1.starting;
    _gate.reset();
    speechClassifier.reset();
    for (var i = 0; i < _delegations.length; i++) {
      if (!_delegations[i].finishedWhilePaused) continue;
      _delegations[i] = VoiceDelegationEntryV1(
        botId: _delegations[i].botId,
        botName: _delegations[i].botName,
        runId: _delegations[i].runId,
        state: _delegations[i].state,
      );
    }
    if (_started) {
      _socket?.sendText(encodeVoiceWakeV1());
    } else {
      _pendingWake = true;
    }
    _notify();
  }

  /// The app left the screen. Gemini sleeps the way Pause does, so a
  /// finished task does not speak into an empty room, and the microphone
  /// is released. The socket stays; [enterForeground] is coming back.
  ///
  /// A Pause the person already started is left alone. Mute has already
  /// closed the device; Pause is still written so a socket the OS then
  /// kills keeps the long rejoin window. `detached` hangs up from the
  /// shell instead.
  Future<void> leaveForeground() async {
    if (!active || _away || _phase == VoiceSessionPhase.ending) return;
    _away = true;
    if (!_paused) {
      pause();
      _pausedForAway = true;
    } else {
      unawaited(player.interrupt());
    }
    await _closeCapture();
    _notify();
  }

  /// The app is on screen again. The microphone comes back unless it is
  /// muted, a socket the OS killed is opened again onto the same call,
  /// and a sleep this controller started for the background resumes. A
  /// Pause the person started still waits for Resume.
  Future<void> enterForeground() async {
    if (!_away) return;
    _away = false;
    if (!active || _phase == VoiceSessionPhase.ending || _disposed) {
      _pausedForAway = false;
      return;
    }
    final generation = _generation;
    if (!muted) {
      final opened = await _openCapture(generation);
      if (_away || generation != _generation || _disposed) {
        if (opened) await _closeCapture();
        return;
      }
    }
    _beginCall();
    if (_socket == null) {
      await _rejoin();
      if (_away ||
          generation != _generation ||
          _disposed ||
          !active ||
          _phase == VoiceSessionPhase.ending) {
        return;
      }
    }
    if (_pausedForAway) {
      _pausedForAway = false;
      resume();
    }
    _notify();
  }

  @override
  void dispose() {
    _clearDelegation();
    _disposed = true;
    _generation++;
    unawaited(_teardown(code: voiceCloseDisposedV1, reason: 'disposed'));
    super.dispose();
  }
}
