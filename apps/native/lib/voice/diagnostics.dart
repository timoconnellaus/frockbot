/// Opt-in latency diagnostics for one call, off in every shipped build.
///
/// A call is slow to answer for a reason somebody has to be able to name: the
/// permission prompt, the audio session, the upgrade round trip, the prompt
/// the server assembles, Google's setup, or the speaker. Guessing between them
/// from the outside is hopeless, so a build that asks for it stamps one
/// randomly generated id on the call and both ends write a line per milestone
/// under it.
///
/// Three rules hold this to something safe to leave in the tree:
///
/// * **Opt-in at compile time.** [voiceDiagnosticsEnabledV1] is a
///   `bool.fromEnvironment` const, so a build that did not ask for it compiles
///   [voiceDiagnosticsV1] down to `null` and nothing here runs.
/// * **No durable call state, nothing shared.** The id belongs to one call,
///   never enters the call ledger, and a second call generates its own. It
///   correlates diagnostic log streams and that is all it is for.
/// * **Metadata only.** A line carries the id, the side, the milestone, the
///   elapsed milliseconds, a wall clock stamp and a few numbers or enums named
///   here. Never a word anyone said, never a prompt, never a header, never a
///   credential.
///
/// The clock is [Stopwatch] — monotonic, and unaffected by the wall clock
/// moving. It is this process's clock and no other: the server's elapsed
/// milliseconds are measured from the server's own start on the server's own
/// clock, and the two are never subtracted from each other. What a shared id
/// buys is reading the two sequences side by side, not arithmetic across them.
library;

import 'dart:convert';
import 'dart:math';

import 'diagnostics_sink_stub.dart'
    if (dart.library.io) 'diagnostics_sink_io.dart';

/// Whether this build asked for diagnostics: `--dart-define
/// FROCKBOT_VOICE_DIAGNOSTICS=true`, which only the development desktop build
/// sets. Everything else compiles them out.
const bool voiceDiagnosticsEnabledV1 = bool.fromEnvironment(
  'FROCKBOT_VOICE_DIAGNOSTICS',
);

/// A diagnostic id, or null. Null is the shipped answer and means every
/// milestone below is a no-op and the socket carries no `trace` at all.
VoiceDiagnostics? voiceDiagnosticsV1() =>
    voiceDiagnosticsEnabledV1 ? VoiceDiagnostics() : null;

final _uuidV4 = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

/// Whether a string is the only thing this client will ever put on the wire as
/// a trace: a random v4 UUID, lower case. The server validates the same shape
/// and ignores anything else, so a URL cannot be used to smuggle a value into
/// either log.
bool isVoiceTraceIdV1(String value) => _uuidV4.hasMatch(value);

String _randomTraceId() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = [for (final byte in bytes) byte.toRadixString(16).padLeft(2, '0')]
      .join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// One call's diagnostic id and its clock.
///
/// Built by the shell when the build opted in and handed to both the socket
/// opener — where it becomes the `trace` query parameter — and the
/// controller, so the two ends of the same call carry the same id.
class VoiceDiagnostics {
  /// What both sides log under, and what the socket's `trace` carries.
  final String trace;

  /// Monotonic, from the moment this call's diagnostics were created — which
  /// is the press, before anything was opened.
  final Stopwatch _since = Stopwatch()..start();

  /// Milestones that are "the first X of this call": the set of those already
  /// said, so [markOnce] says each exactly once.
  final Set<String> _said = <String>{};

  /// Where a line goes. Native diagnostics also use a temporary file because
  /// launching the app normally does not preserve its stdout for capture.
  final void Function(String line) sink;

  VoiceDiagnostics({String? trace, void Function(String line)? sink})
    : trace = trace ?? _randomTraceId(),
      sink = sink ?? createVoiceTimingSinkV1();

  int get elapsedMs => _since.elapsedMilliseconds;

  /// One milestone.
  ///
  /// [fields] is a whitelist by construction — the call sites below name
  /// every key, and each is a number, a bool or a short enum-like token.
  /// Nothing derived from audio, text or credentials is ever passed.
  void mark(String event, [Map<String, Object?> fields = const {}]) {
    final line = jsonEncode({
      'trace': trace,
      'side': 'client',
      'event': event,
      'elapsedMs': elapsedMs,
      'at': DateTime.now().toUtc().toIso8601String(),
      ...fields,
    });
    sink('voice timing $line');
  }

  /// A milestone that means "the first one of these this call" — the first
  /// microphone frame, the first audio down. A second one is not a second
  /// line.
  void markOnce(String event, [Map<String, Object?> fields = const {}]) {
    if (!_said.add(event)) return;
    mark(event, fields);
  }
}
