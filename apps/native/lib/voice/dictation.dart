/// Composer dictation: one capture, bound to one Bot's composer.
///
/// The draft belongs to the Bot the capture started on. That is the whole
/// reason [start] takes a context and every write goes back through
/// [onDraft] with it: switching Bots mid-capture must never put words into
/// another Bot's composer, and a controller that read "the selected Bot" at
/// write time would do exactly that.
///
/// Stop flushes into the editable draft and never sends. Sending is the
/// person's, through the ordinary Send.
library;

import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';

import 'capture.dart';
import 'protocol.dart';
import 'socket.dart';

enum DictationState { idle, starting, capturing, stopping, done, error }

extension DictationStateActivity on DictationState {
  /// Whether a capture is in progress: the one definition every surface asks,
  /// so a new in-flight state cannot mean one thing here and another there.
  bool get active =>
      this == DictationState.starting ||
      this == DictationState.capturing ||
      this == DictationState.stopping;
}

/// Writes the assembled draft into one composer context.
typedef DictationDraftSink = void Function(Object context, String text);

/// Reads the draft of one composer context as it stands right now.
typedef DictationDraftReader = String Function(Object context);

/// The span of the draft a capture owns.
///
/// A capture does not own the composer: it owns the words it put there. What
/// the person typed before it started stays before them, and what they type
/// while it runs stays where they typed it — the transcript is re-anchored
/// around its own span on every write rather than replacing the field.
///
/// If the person edits inside the transcript itself, the span can no longer
/// be found and the range fences: from then on nothing more is written, and
/// both their edit and the words already there are kept. That is deliberate.
/// The alternative — guessing where their cursor meant the next segment to go
/// — loses text, and losing what someone typed is worse than stopping.
class DictationDraftRange {
  String _prefix;
  String _suffix;
  String _transcript = '';
  bool _fenced = false;

  DictationDraftRange({String before = '', String after = ''})
    : _prefix = before,
      _suffix = after;

  /// Whether the person has edited inside the transcript, which stops it.
  bool get fenced => _fenced;

  /// The draft [transcript] makes of [current], or null once fenced.
  String? next(String current, String transcript) {
    if (_fenced) return null;
    if (current != _compose(_transcript)) {
      // Typed into while the words were arriving. Re-anchor on the span this
      // capture owns.
      if (_transcript.isEmpty) {
        _prefix = current;
        _suffix = '';
      } else {
        final at = current.indexOf(_transcript);
        if (at < 0) {
          _fenced = true;
          return null;
        }
        _prefix = current.substring(0, at);
        _suffix = current.substring(at + _transcript.length);
      }
    }
    _transcript = transcript;
    return _compose(transcript);
  }

  /// One space between what was already there and what was said, and never
  /// two: a draft is prose, not a concatenation.
  String _compose(String transcript) {
    if (transcript.isEmpty) return _prefix + _suffix;
    final head =
        _prefix.isEmpty || _prefix.endsWith(' ') || _prefix.endsWith('\n')
        ? _prefix
        : '$_prefix ';
    final tail =
        _suffix.isEmpty || _suffix.startsWith(' ') || _suffix.startsWith('\n')
        ? _suffix
        : ' $_suffix';
    return '$head$transcript$tail';
  }
}

class DictationController extends ChangeNotifier {
  final VoiceSocketOpener openSocket;
  final VoiceCapture capture;
  final DictationDraftSink onDraft;

  /// Reads the draft as it stands, so a segment that lands after the person
  /// typed goes beside their words rather than over them.
  final DictationDraftReader readDraft;

  /// Returns a borrowed microphone after capture and socket teardown.
  final Future<void> Function()? onFinished;
  final Duration connectTimeout;
  final Duration finalTimeout;

  DictationController({
    required this.openSocket,
    required this.capture,
    required this.onDraft,
    required this.readDraft,
    this.onFinished,
    this.connectTimeout = voiceDictationConnectTimeoutV1,
    this.finalTimeout = voiceDictationFinalTimeoutV1,
  });

  DictationState _state = DictationState.idle;
  String? _error;
  String? _notice;
  Object? _context;

  /// The capture level, on its own so thirty notifications a second reach the
  /// bars beside the composer and nothing else. A rebuild of the whole shell
  /// per audio frame is not a price a drawn waveform is worth.
  final ValueNotifier<double> level = ValueNotifier<double>(0);

  final List<String> _segments = [];
  String _delta = '';

  VoiceSocket? _socket;
  StreamSubscription<Object?>? _frames;
  StreamSubscription<Object?>? _inbound;
  Timer? _finalTimer;
  Completer<void>? _finished;

  /// Opening audio held while the socket opens, drained in order on `ready`.
  /// Bounded at 30 s; the oldest goes first, which is what the server's own
  /// buffer does with the same overflow.
  final ListQueue<Uint8List> _opening = ListQueue<Uint8List>();
  int _openingBytes = 0;
  bool _ready = false;
  bool _stopRequested = false;
  bool _disposed = false;

  /// Which capture this is. Every await inside a start checks it, so a
  /// capture the person cancelled while the permission prompt was up cannot
  /// come back and start recording behind them.
  int _generation = 0;
  DictationDraftRange _range = DictationDraftRange();

  DictationState get state => _state;
  String? get error => _error;

  /// A non-fatal word from the server — truncated opening audio, and such.
  String? get notice => _notice;
  Object? get context => _context;
  double get micLevel => level.value;
  bool get active => _state.active;

  /// The draft as the protocol defines it: committed segments, then the
  /// interim delta.
  String get text {
    final committed = _segments.join(' ').trim();
    final delta = _delta.trim();
    if (delta.isEmpty) return committed;
    return committed.isEmpty ? delta : '$committed $delta';
  }

  /// Starts a capture for [context] and returns once it is under way.
  ///
  /// Capture starts before the socket does, so the first words are already
  /// recorded by the time the server is listening.
  Future<void> start(Object context) async {
    if (active) return;
    final generation = ++_generation;
    _context = context;
    // Everything already in this Bot's composer stays in front of the words
    // about to arrive.
    _range = DictationDraftRange(before: readDraft(context));
    _segments.clear();
    _delta = '';
    _error = null;
    _notice = null;
    _ready = false;
    _stopRequested = false;
    _opening.clear();
    _openingBytes = 0;
    _finished = Completer<void>();
    _set(DictationState.starting);
    try {
      final frames = await capture.start(
        sampleRate: voiceDictationSampleRateV1,
        frame: voiceDictationFrame,
      );
      if (generation != _generation || _disposed) {
        await capture.stop();
        return;
      }
      if (_stopRequested) {
        await capture.stop();
        await _finish(null);
        return;
      }
      _frames = frames.listen(_onFrame, onError: (Object _) {});
    } on MicrophoneDenied catch (denied) {
      if (generation != _generation || _disposed) return;
      await _fail(denied.message);
      return;
    } on Object {
      if (generation != _generation || _disposed) return;
      await _fail('FrockBot couldn’t start the microphone. Try again.');
      return;
    }
    unawaited(_connect(generation));
  }

  Future<void> _connect(int generation) async {
    try {
      final socket = await openSocket().timeout(connectTimeout);
      if (generation != _generation ||
          _disposed ||
          _state == DictationState.idle ||
          _state == DictationState.done ||
          _state == DictationState.error) {
        await socket.close();
        return;
      }
      _socket = socket;
      _inbound = socket.messages.listen(
        _onMessage,
        onError: (Object _) => unawaited(_finish('Voice stopped. Try again.')),
        onDone: () => unawaited(_finish(null)),
      );
      socket.sendText(encodeDictationStartV1());
      if (_state == DictationState.starting) _set(DictationState.capturing);
      // A stop that arrived before the socket did still commits: the server
      // buffers everything sent before it is ready, so the audio and the stop
      // go out now, in order.
      if (_stopRequested) _commit();
    } on TimeoutException {
      if (generation != _generation || _disposed) return;
      await _fail('Voice didn’t answer. Check your connection and try again.');
    } on Object {
      if (generation != _generation || _disposed) return;
      await _fail('Couldn’t reach voice. Check your connection and try again.');
    }
  }

  void _onFrame(AudioFrame frame) {
    _setLevel(frame.level);
    if (_state == DictationState.done || _state == DictationState.error) return;
    final socket = _socket;
    if (socket == null || (!_ready && !_stopRequested)) {
      _opening.addLast(frame.bytes);
      _openingBytes += frame.bytes.length;
      while (_openingBytes > voiceDictationOpeningBufferBytesV1 &&
          _opening.isNotEmpty) {
        _openingBytes -= _opening.removeFirst().length;
        _notice = 'The opening of that capture was too long to keep.';
      }
      return;
    }
    if (_state == DictationState.stopping) return;
    socket.sendBinary(frame.bytes);
  }

  void _drainOpening() {
    final socket = _socket;
    if (socket == null) return;
    while (_opening.isNotEmpty) {
      socket.sendBinary(_opening.removeFirst());
    }
    _openingBytes = 0;
  }

  void _onMessage(Object? message) {
    if (message is! String) return;
    final DictationServerFrameV1 frame;
    try {
      frame = decodeDictationServerFrameV1(message);
    } on FormatException {
      return;
    }
    switch (frame) {
      case DictationReadyV1():
        _ready = true;
        _drainOpening();
        if (_state == DictationState.starting) _set(DictationState.capturing);
      case DictationDeltaV1(:final text):
        _delta = text;
        _publish();
      case DictationSegmentV1(:final text):
        _segments.add(text);
        _delta = '';
        _publish();
      case DictationNoticeV1(:final message):
        _notice = message;
        _notify();
      case DictationFinalV1():
        unawaited(_finish(null));
      case DictationErrorV1(:final message):
        unawaited(_finish(message));
    }
  }

  void _publish() {
    final context = _context;
    if (context != null && !_disposed) {
      final draft = _range.next(readDraft(context), text);
      if (draft != null) onDraft(context, draft);
    }
    _notify();
  }

  /// Commits the capture: everything held goes up, then `stop`, then the
  /// server answers `final` — or [finalTimeout] passes and the draft is
  /// flushed with what arrived.
  Future<void> stop() async {
    if (!active) return;
    _stopRequested = true;
    _set(DictationState.stopping);
    await _frames?.cancel();
    _frames = null;
    await capture.stop();
    _setLevel(0);
    // The bound covers waiting for the socket as well as waiting for `final`.
    // A capture whose socket is still connecting is not a lost one: the audio
    // is held, and the commit goes out in order the moment the socket is
    // there — which is what `_connect` does with `_stopRequested`.
    _finalTimer?.cancel();
    _finalTimer = Timer(finalTimeout, () => unawaited(_finish(null)));
    if (_socket != null) _commit();
    await _finished?.future;
  }

  void _commit() {
    _drainOpening();
    _socket?.sendText(encodeDictationStopV1());
  }

  /// Abandons the capture. Nothing is committed and the draft keeps whatever
  /// already arrived, which is what closing without `stop` means on the wire.
  Future<void> cancel() async {
    if (_state == DictationState.idle) return;
    _generation++;
    await _teardown();
    _set(DictationState.done);
    await onFinished?.call();
  }

  Future<void> _fail(String message) async {
    _generation++;
    _error = message;
    await _teardown();
    // A socket that failed keeps whatever text already arrived.
    _publish();
    _set(DictationState.error);
    await onFinished?.call();
    _finished?.complete();
    _finished = null;
  }

  Future<void> _finish(String? failure) async {
    if (_state == DictationState.done || _state == DictationState.error) return;
    _generation++;
    _error = failure;
    await _teardown();
    _publish();
    _set(failure == null ? DictationState.done : DictationState.error);
    await onFinished?.call();
    if (_finished?.isCompleted == false) _finished!.complete();
    _finished = null;
  }

  Future<void> _teardown() async {
    _finalTimer?.cancel();
    _finalTimer = null;
    await _frames?.cancel();
    _frames = null;
    await _inbound?.cancel();
    _inbound = null;
    final socket = _socket;
    _socket = null;
    await socket?.close();
    await capture.stop();
    _setLevel(0);
    _opening.clear();
    _openingBytes = 0;
  }

  void _set(DictationState state) {
    if (_state == state) return;
    _state = state;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _setLevel(double value) {
    if (!_disposed) level.value = value;
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    unawaited(_teardown().whenComplete(level.dispose));
    super.dispose();
  }
}
