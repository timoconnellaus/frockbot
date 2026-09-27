/// One microphone, one owner.
///
/// Dictation and the assistant both capture, and a device has one input. Two
/// captures at once is not a race to be detected later: it is a rule, and
/// this is the token that holds it.
///
/// The two directions are deliberately different. Dictation is a short,
/// deliberate act, so it borrows the microphone: the call keeps running with
/// its microphone held, which mutes it and releases the device. Starting the
/// assistant is the larger gesture, so it takes the microphone: a dictation
/// in progress is stopped and its draft flushed, because words already spoken
/// belong in the composer either way.
///
/// A Plugin's page is the third owner, and the weakest: it gets the
/// microphone only when nobody holds it, and either spoken gesture takes it
/// away, because the person's latest gesture wins.
///
/// The loan is a hold, not a mute. This token never decides that a call
/// should be unmuted — it only says the borrowing is over, and the call's own
/// two inputs decide what that means. Someone who muted their call before
/// dictating gets it back muted.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

enum MicOwner { none, dictation, assistant, page }

class MicOwnership extends ChangeNotifier {
  /// Whether the assistant currently holds a live call.
  bool Function() assistantLive = () => false;

  /// Lends the assistant's microphone out, or gives it back. Holding it mutes
  /// the call and closes the device; releasing restores what the person chose.
  Future<void> Function(bool held) holdAssistant = (_) async {};

  /// Whether a dictation is capturing.
  bool Function() dictationActive = () => false;

  /// Stops the dictation and flushes its draft into its own composer.
  Future<void> Function() stopDictation = () async {};

  MicOwner _owner = MicOwner.none;
  bool _held = false;

  /// Closes the page's capture and tells it why; set while a page holds it.
  Future<void> Function()? _stopPage;

  MicOwner get owner => _owner;

  /// Dictation borrows the microphone. Answers once the device is free, so
  /// the capture that follows is not racing the one it replaced.
  Future<void> acquireForDictation() async {
    await _takeFromPage();
    if (assistantLive()) {
      _held = true;
      await holdAssistant(true);
    }
    _set(MicOwner.dictation);
  }

  /// Dictation gives the microphone back. What that means for the call is the
  /// call's to decide.
  Future<void> releaseDictation() async {
    if (_held) {
      _held = false;
      await holdAssistant(false);
    }
    _set(assistantLive() ? MicOwner.assistant : MicOwner.none);
  }

  /// The assistant takes the microphone, stopping a dictation first so its
  /// words reach the draft rather than being dropped.
  Future<void> acquireForAssistant() async {
    await _takeFromPage();
    if (dictationActive()) {
      await stopDictation();
      // The dictation is over on its own terms, so nothing is owed back.
      _held = false;
    }
    _set(MicOwner.assistant);
  }

  void releaseAssistant() {
    _held = false;
    _set(dictationActive() ? MicOwner.dictation : MicOwner.none);
  }

  /// A page takes the microphone only when nobody holds it. Answers whether
  /// it did; [stop] is how dictation or a call takes it back.
  bool acquireForPage(Future<void> Function() stop) {
    if (_owner != MicOwner.none) return false;
    _stopPage = stop;
    _set(MicOwner.page);
    return true;
  }

  void releasePage() {
    if (_owner != MicOwner.page) return;
    _stopPage = null;
    _set(MicOwner.none);
  }

  Future<void> _takeFromPage() async {
    final stop = _stopPage;
    if (_owner != MicOwner.page || stop == null) return;
    _stopPage = null;
    await stop();
    if (_owner == MicOwner.page) _set(MicOwner.none);
  }

  void _set(MicOwner owner) {
    if (_owner == owner) return;
    _owner = owner;
    notifyListeners();
  }
}
