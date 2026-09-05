import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';

import 'audio.dart';
import 'dictation.dart';

/// What the composer's mic button is doing.
enum DictationState {
  /// No microphone. The mic button is the mic button.
  idle,

  /// Asked for the microphone, or waiting for the upstream to say `ready`.
  starting,

  /// Capturing. Cancel and Done have replaced the mic.
  listening,

  /// Done was pressed; the last of the audio is being transcribed.
  finishing,
}

/// Dictation as text arriving in a draft somebody may be editing at the same
/// time.
///
/// The words land in the composer's own field rather than in a box of their
/// own, so the message stays editable while it is being spoken, Send is the
/// ordinary Send, and a draft that is saved is saved whole. That makes one
/// thing hard — knowing which part of the field dictation put there — and
/// [applyDictationTail] is that one thing.
///
/// Nothing here decides anything about quota or provider: a `failed` frame
/// carries a sentence written on the server and this shows it unchanged.
class DictationController extends ChangeNotifier {
  DictationController({
    required this.backend,
    required this.audio,
    this.noticeFor = const Duration(seconds: 6),
  });

  final DictationBackend backend;
  final VoiceAudio audio;

  /// Called with the field's text whenever dictation changes it, so the draft
  /// is saved the way typing saves it. The composer sets this when it attaches
  /// its field; this controller outlives any one conversation.
  void Function(String draft)? onDraft;

  /// How long a refusal stays on screen before the composer is quiet again.
  final Duration noticeFor;

  DictationState _state = DictationState.idle;
  DictationState get state => _state;

  /// True while the composer should show Cancel and Done instead of the mic.
  bool get capturing => _state != DictationState.idle;

  /// True once the first word has arrived; until then the field says
  /// "Listening…" rather than nothing.
  bool get heard => !_transcript.isEmpty;

  /// A sentence to show above the composer, written by the server.
  String? get notice => _notice;
  String? _notice;

  final DictationTranscript _transcript = DictationTranscript();
  TextEditingController? _field;
  DictationSession? _session;
  StreamSubscription<DictationServerFrame>? _frames;
  Timer? _noticeTimer;
  String _tail = '';
  bool _disposed = false;

  /// Starts one capture into [field]. Safe to call while already capturing:
  /// the second tap is ignored rather than opening a second socket.
  Future<void> start(TextEditingController field) async {
    if (_disposed || _state != DictationState.idle) return;
    _field = field;
    _transcript.reset();
    _tail = '';
    _show(null);
    _set(DictationState.starting);
    try {
      await audio.listen(
        _capture,
        sampleRate: voiceDictationSampleRate,
        playback: false,
      );
    } on VoiceAudioRefusal catch (refusal) {
      await _end(notice: refusal.message);
      return;
    } catch (error) {
      await _end(
        notice: 'FrockBot couldn’t open the microphone ($error). Try again.',
      );
      return;
    }
    if (_disposed || _state != DictationState.starting) {
      // Cancelled while the microphone was opening.
      await audio.silence();
      return;
    }
    final DictationSession session;
    try {
      session = await backend.open();
    } catch (_) {
      await _end(
        notice:
            'Dictation couldn’t connect. Check your connection and try again.',
      );
      return;
    }
    if (_disposed || _state != DictationState.starting) {
      await session.close();
      await audio.silence();
      return;
    }
    _session = session;
    _frames = session.frames.listen(
      _receive,
      onDone: () {
        // A socket that closed without saying `final` still ends the capture;
        // whatever was heard stays in the field.
        if (_state != DictationState.idle) unawaited(_end());
      },
      cancelOnError: false,
    );
    _set(DictationState.listening);
  }

  void _capture(Uint8List pcm16) => _session?.sendAudio(pcm16);

  void _receive(DictationServerFrame frame) {
    switch (frame) {
      case DictationReady():
        return;
      case DictationDelta(:final text):
        _transcript.delta(text);
        _write();
      case DictationSettled(:final text):
        _transcript.settle(text);
        _write();
      case DictationFinal():
        unawaited(_end());
      case DictationFailed(:final message):
        unawaited(_end(notice: message));
    }
  }

  /// Puts what has been heard where dictation last put it — or on the end,
  /// when the person has since deleted or retyped over it.
  void _write() {
    final field = _field;
    if (field == null) return;
    final next = applyDictationTail(field.text, _tail, _transcript.text());
    _tail = next.tail;
    if (field.text != next.draft) {
      field.value = TextEditingValue(
        text: next.draft,
        selection: TextSelection.collapsed(offset: next.draft.length),
      );
      onDraft?.call(next.draft);
    }
    notifyListeners();
  }

  /// Done: stop capturing, transcribe the rest, keep the text for editing.
  Future<void> done() async {
    if (_state != DictationState.listening &&
        _state != DictationState.starting) {
      return;
    }
    _set(DictationState.finishing);
    await audio.silence();
    _session?.commit();
    // `final` ends it. A socket that never answers is ended by its own close.
  }

  /// Cancel: throw away what this capture put in the field, keep what was
  /// typed before it.
  Future<void> cancel() async {
    if (_state == DictationState.idle) return;
    _session?.cancel();
    final field = _field;
    if (field != null && _tail.isNotEmpty) {
      final draft = removeDictationTail(field.text, _tail);
      field.value = TextEditingValue(
        text: draft,
        selection: TextSelection.collapsed(offset: draft.length),
      );
      onDraft?.call(draft);
    }
    _tail = '';
    _transcript.reset();
    await _end();
  }

  Future<void> _end({String? notice}) async {
    final frames = _frames;
    final session = _session;
    _frames = null;
    _session = null;
    if (notice != null) _show(notice);
    _set(DictationState.idle);
    if (notice != null && !_disposed) notifyListeners();
    await frames?.cancel();
    await session?.close();
    await audio.silence();
  }

  void _show(String? notice) {
    _noticeTimer?.cancel();
    _noticeTimer = null;
    _notice = notice;
    if (notice == null) return;
    _noticeTimer = Timer(noticeFor, () {
      _noticeTimer = null;
      if (_disposed) return;
      _notice = null;
      notifyListeners();
    });
  }

  void _set(DictationState state) {
    if (_state == state) return;
    _state = state;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _noticeTimer?.cancel();
    unawaited(_frames?.cancel());
    unawaited(_session?.close());
    unawaited(audio.dispose());
    super.dispose();
  }
}
