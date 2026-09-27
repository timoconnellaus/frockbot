/// What this deployment can do with voice, read once after sign-in.
///
/// The controls are always shown. A deployment without the keys answers the
/// probe with `false`, and pressing a control says so in one line rather than
/// opening a socket that fails — but a probe that itself failed is not an
/// answer, so the press goes ahead and the socket speaks for itself.
library;

import 'package:flutter/foundation.dart';

import '../client/transport.dart';
import 'protocol.dart';

class VoiceCapabilityProbe extends ChangeNotifier {
  final NativeApi api;
  VoiceCapabilityProbe(this.api);

  VoiceCapabilitiesV1? _capabilities;
  bool _read = false;

  VoiceCapabilitiesV1? get capabilities => _capabilities;

  /// Whether the probe has an answer. Absent, both controls still work.
  bool get known => _capabilities != null;

  bool get dictationAvailable => _capabilities?.dictation ?? true;
  bool get assistantAvailable => _capabilities?.assistant ?? true;

  Future<void> load() async {
    if (_read) return;
    _read = true;
    try {
      _capabilities = decodeVoiceCapabilitiesV1(
        await api.request(voiceCapabilitiesPathV1, limit: 4000),
      );
      notifyListeners();
    } on Object {
      // A probe nobody answered is not a refusal; the control stays live.
      _read = false;
    }
  }
}
