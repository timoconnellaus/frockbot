/// Composer dictation transcribed on this Mac.
///
/// The Mac app can turn speech into text itself (`LocalDictation.swift`,
/// Parakeet on Core ML), so a capture never leaves the machine, costs nothing
/// and works offline. The phone and the web keep FrockBot's dictation.
///
/// [LocalDictationSocket] speaks the dictation protocol's server half on the
/// device, so [DictationController] drives it exactly as it drives the relay:
/// the same pill, the same stop, the same draft range. Only the tidy-up
/// crosses the network, and only as text: the relay's own cleanup, reached
/// through `POST /api/voice/dictation/cleanup`. Offline it fails and the raw
/// transcript stands, as it does on the relay.
///
/// The choice is this Mac's, kept in its local store under
/// [dictationSourceKeyV1], because the model it depends on is on this Mac.
/// When the setup app gains its per-job Dictation row it takes over that one
/// key's meaning.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../brand.dart';
import '../client/transport.dart';
import 'protocol.dart';
import 'socket.dart';

/// Where composer dictation is transcribed.
enum DictationSource {
  /// FrockBot's dictation: the relay, and OpenAI behind it.
  frockbot('frockbot'),

  /// This Mac's own model. Never falls back to the cloud.
  thisMac('this-mac');

  final String wire;
  const DictationSource(this.wire);

  static DictationSource decode(String? value) =>
      value == DictationSource.thisMac.wire
      ? DictationSource.thisMac
      : DictationSource.frockbot;
}

const dictationSourceKeyV1 = 'voice.dictation.source.v1';

/// The route that tidies a transcript the device produced.
const voiceDictationCleanupPathV1 = '/api/voice/dictation/cleanup';

/// How long stop waits for the Mac's transcript. Parakeet reads five minutes
/// of speech in seconds, but the first capture after launch may also load the
/// model onto the Neural Engine.
const localDictationFinalTimeoutV1 = Duration(seconds: 60);

/// A capture nobody stops is ended, as the relay ends one: five minutes.
const localDictationMaxBytesV1 = 5 * 60 * voiceDictationSampleRateV1 * 2;

/// The relay's own bounds on what is worth offering to the tidy-up; outside
/// them it answers null without a model call, so the request is skipped.
const _cleanupMinChars = 24;
const _cleanupMaxChars = 12000;

/// "483 MB": what the model takes, for a person deciding whether to fetch it.
String formatDictationModelSizeV1(int bytes) {
  if (bytes <= 0) return 'about 480 MB';
  if (bytes < 1000 * 1000) return '${(bytes / 1000).ceil()} KB';
  return '${(bytes / (1000 * 1000)).round()} MB';
}

enum LocalDictationPhase { unsupported, absent, downloading, ready, failed }

class LocalDictationStatus {
  final LocalDictationPhase phase;

  /// 0..1 while downloading, read from the bytes on disk.
  final double progress;
  final int bytesOnDisk;
  final int expectedBytes;
  final String error;

  const LocalDictationStatus({
    this.phase = LocalDictationPhase.unsupported,
    this.progress = 0,
    this.bytesOnDisk = 0,
    this.expectedBytes = 0,
    this.error = '',
  });

  static LocalDictationStatus decode(Object? value) {
    if (value is! Map) return const LocalDictationStatus();
    int integer(Object? raw) => raw is num ? raw.toInt() : 0;
    final progress = value['progress'];
    return LocalDictationStatus(
      phase:
          LocalDictationPhase.values.asNameMap()[value['phase']] ??
          LocalDictationPhase.unsupported,
      progress: progress is num ? progress.toDouble().clamp(0, 1) : 0,
      bytesOnDisk: integer(value['bytesOnDisk']),
      expectedBytes: integer(value['expectedBytes']),
      error: value['error'] is String ? value['error'] as String : '',
    );
  }
}

/// The platform half. Tests drive this seam; the app's only implementation
/// is [MacLocalDictationEngine].
abstract interface class LocalDictationEngine {
  Stream<LocalDictationStatus> get changes;
  Future<LocalDictationStatus> status();
  Future<void> download();
  Future<void> remove();

  /// Loads the model ahead of a capture, so stop does not wait for it.
  Future<void> prepare();

  /// One whole capture, PCM16 mono at [sampleRate], to text.
  Future<String> transcribe(Uint8List pcm16, {required int sampleRate});
}

class MacLocalDictationEngine implements LocalDictationEngine {
  static const channel = MethodChannel('com.frockbot/local-dictation');
  final _changes = StreamController<LocalDictationStatus>.broadcast();

  MacLocalDictationEngine() {
    channel.setMethodCallHandler((call) async {
      if (call.method == 'state') {
        _changes.add(LocalDictationStatus.decode(call.arguments));
      }
    });
  }

  @override
  Stream<LocalDictationStatus> get changes => _changes.stream;

  @override
  Future<LocalDictationStatus> status() => _status('state');

  @override
  Future<void> download() => _status('download');

  @override
  Future<void> remove() => _status('remove');

  @override
  Future<void> prepare() async {
    try {
      await channel.invokeMethod<void>('prepare');
    } on MissingPluginException {
      // A host without the engine has nothing to load.
    }
  }

  @override
  Future<String> transcribe(Uint8List pcm16, {required int sampleRate}) async {
    final text = await channel.invokeMethod<String>('transcribe', {
      'pcm': pcm16,
      'sampleRate': sampleRate,
    });
    return text ?? '';
  }

  Future<LocalDictationStatus> _status(String method) async {
    try {
      final status = LocalDictationStatus.decode(
        await channel.invokeMethod<Object?>(method),
      );
      _changes.add(status);
      return status;
    } on MissingPluginException {
      return const LocalDictationStatus();
    }
  }
}

/// The Mac's dictation choice and its model, for the composer and the card.
class LocalDictationController extends ChangeNotifier {
  final LocalDictationEngine? engine;
  LocalStore? _store;
  StreamSubscription<LocalDictationStatus>? _changes;

  DictationSource source = DictationSource.frockbot;
  LocalDictationStatus status = const LocalDictationStatus();

  LocalDictationController({this.engine});

  bool get supported =>
      engine != null && status.phase != LocalDictationPhase.unsupported;

  /// Whether the composer transcribes on this Mac. Read at every capture.
  bool get onThisMac => engine != null && source == DictationSource.thisMac;

  bool get ready => status.phase == LocalDictationPhase.ready;

  Future<void> load(LocalStore store) async {
    final engine = this.engine;
    if (engine == null) return;
    _store = store;
    _changes ??= engine.changes.listen(_adopt);
    source = DictationSource.decode(await store.read(dictationSourceKeyV1));
    _adopt(await engine.status());
    if (onThisMac && ready) unawaited(engine.prepare());
  }

  void _adopt(LocalDictationStatus next) {
    status = next;
    notifyListeners();
  }

  Future<void> choose(DictationSource next) async {
    if (engine == null || next == source) return;
    source = next;
    notifyListeners();
    await _store?.write(dictationSourceKeyV1, next.wire);
    if (onThisMac && ready) unawaited(engine!.prepare());
  }

  Future<void> download() async => engine?.download();

  Future<void> remove() async => engine?.remove();

  /// A dictation socket that never leaves this Mac. [cleanup] is the relay's
  /// tidy-up, reached with text; null skips it.
  VoiceSocket open({DictationCleaner? cleanup}) {
    final engine = this.engine;
    if (engine == null) throw StateError('No on-device dictation here');
    unawaited(engine.prepare());
    return LocalDictationSocket(engine: engine, cleanup: cleanup);
  }

  @override
  void dispose() {
    unawaited(_changes?.cancel());
    super.dispose();
  }
}

final localDictation = LocalDictationController(
  engine: !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS
      ? MacLocalDictationEngine()
      : null,
);

/// The tidied form of [text], or null when the person's own words stand.
typedef DictationCleaner = Future<String?> Function(String text);

DictationCleaner dictationCleanerV1(NativeApi api) => (text) async {
  final answer = await api
      .request(
        voiceDictationCleanupPathV1,
        body: {'schemaVersion': 1, 'text': text},
      )
      .timeout(voiceDictationCleanupTimeoutV1);
  if (answer is! Map || answer['schemaVersion'] != 1) return null;
  final tidied = answer['text'];
  return tidied is String && tidied.trim().isNotEmpty ? tidied : null;
};

/// The dictation protocol's server half, run on this Mac.
///
/// `start` is answered `ready` at once: there is no upstream to wait for.
/// Audio is held until `stop`, transcribed whole — Parakeet reads a
/// minute of speech in well under a second, and the composer holds deltas
/// rather than showing them — and answered with the frames the relay sends:
/// `segment`, then `cleaning`/`cleaned` when a tidy-up runs, then `final`.
class LocalDictationSocket implements VoiceSocket {
  final LocalDictationEngine engine;
  final DictationCleaner? cleanup;
  final int maxBytes;

  final _messages = StreamController<Object?>();
  final _audio = BytesBuilder(copy: false);
  bool _stopping = false;
  bool _closed = false;

  LocalDictationSocket({
    required this.engine,
    this.cleanup,
    this.maxBytes = localDictationMaxBytesV1,
  });

  @override
  Stream<Object?> get messages => _messages.stream;

  @override
  void sendText(String text) {
    final Object? frame;
    try {
      frame = jsonDecode(text);
    } on FormatException {
      return;
    }
    if (frame is! Map) return;
    switch (frame['type']) {
      case 'start':
        _emit({'schemaVersion': 1, 'type': 'ready'});
      case 'stop':
        unawaited(_commit(capped: false));
    }
  }

  @override
  void sendBinary(Uint8List bytes) {
    if (_stopping || _closed) return;
    _audio.add(bytes);
    if (_audio.length >= maxBytes) unawaited(_commit(capped: true));
  }

  Future<void> _commit({required bool capped}) async {
    if (_stopping || _closed) return;
    _stopping = true;
    final String transcript;
    try {
      transcript = (await engine.transcribe(
        _audio.takeBytes(),
        sampleRate: voiceDictationSampleRateV1,
      )).trim();
    } on Object {
      _emit({
        'schemaVersion': 1,
        'type': 'error',
        'message': 'This Mac couldn’t transcribe that. Try again.',
        'code': 'upstream',
      });
      await close();
      return;
    }
    if (_closed) return;
    if (transcript.isNotEmpty) {
      _emit({'schemaVersion': 1, 'type': 'segment', 'text': transcript});
    }
    if (capped) {
      _emit({
        'schemaVersion': 1,
        'type': 'error',
        'message': 'Dictation stopped after five minutes. Press the microphone to continue.',
        'code': 'limit',
      });
      await close();
      return;
    }
    final cleanup = this.cleanup;
    if (cleanup != null &&
        transcript.length >= _cleanupMinChars &&
        transcript.length <= _cleanupMaxChars) {
      _emit({'schemaVersion': 1, 'type': 'cleaning'});
      String? tidied;
      try {
        tidied = await cleanup(transcript);
      } on Object {
        // Offline, or the tidy-up failed: the person's own words stand.
      }
      if (_closed) return;
      if (tidied != null) {
        _emit({'schemaVersion': 1, 'type': 'cleaned', 'text': tidied});
      }
    }
    _emit({'schemaVersion': 1, 'type': 'final'});
    await close();
  }

  void _emit(Map<String, Object?> frame) {
    if (!_closed) _messages.add(jsonEncode(frame));
  }

  @override
  Future<void> close({
    int code = voiceCloseNormalV1,
    String reason = '',
  }) async {
    if (_closed) return;
    _closed = true;
    _audio.clear();
    await _messages.close();
  }
}

/// Your computers › This Mac: where dictation is transcribed, and the model.
class LocalDictationCard extends StatelessWidget {
  final LocalDictationController controller;
  const LocalDictationCard({super.key, required this.controller});

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      if (controller.engine == null) return const SizedBox.shrink();
      final theme = Theme.of(context);
      final status = controller.status;
      final size = formatDictationModelSizeV1(status.expectedBytes);
      return Card(
        margin: const EdgeInsets.only(bottom: 12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                header: true,
                child: Text('Dictation', style: theme.textTheme.titleSmall),
              ),
              const SizedBox(height: 4),
              Text(
                'Where the composer turns your speech into text on this Mac.',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 8),
              SegmentedButton<DictationSource>(
                segments: [
                  ButtonSegment(
                    value: DictationSource.frockbot,
                    label: Text('${clientBrand.productName}’s'),
                  ),
                  ButtonSegment(
                    value: DictationSource.thisMac,
                    label: const Text('On this Mac'),
                    enabled: controller.supported,
                  ),
                ],
                selected: {controller.source},
                showSelectedIcon: false,
                onSelectionChanged: (choice) =>
                    unawaited(controller.choose(choice.single)),
              ),
              const SizedBox(height: 8),
              if (!controller.supported)
                Text(
                  'Dictation on this Mac needs Apple silicon.',
                  style: theme.textTheme.bodySmall,
                )
              else ...[
                Text(
                  'On this Mac, audio never leaves the Mac, works offline and '
                  'is never billed. When you’re online the text is tidied as '
                  'usual.',
                  style: theme.textTheme.bodySmall,
                ),
                const SizedBox(height: 8),
                ..._model(theme, status, size),
              ],
            ],
          ),
        ),
      );
    },
  );

  List<Widget> _model(
    ThemeData theme,
    LocalDictationStatus status,
    String size,
  ) => switch (status.phase) {
    LocalDictationPhase.unsupported => const [],
    LocalDictationPhase.downloading => [
      Text(
        'Downloading the speech model… '
        '${formatDictationModelSizeV1(status.bytesOnDisk)} of $size',
        style: theme.textTheme.bodySmall,
      ),
      const SizedBox(height: 6),
      LinearProgressIndicator(value: status.progress),
    ],
    LocalDictationPhase.ready => [
      Text(
        'Speech model on this Mac · '
        '${formatDictationModelSizeV1(status.bytesOnDisk)}',
        style: theme.textTheme.bodySmall,
      ),
      const SizedBox(height: 8),
      OutlinedButton(
        onPressed: () => unawaited(controller.remove()),
        child: const Text('Remove model'),
      ),
    ],
    LocalDictationPhase.absent || LocalDictationPhase.failed => [
      if (status.error.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Text(
            status.error,
            style: TextStyle(color: theme.colorScheme.error),
          ),
        ),
      FilledButton.tonal(
        onPressed: () => unawaited(controller.download()),
        child: Text('Download speech model ($size)'),
      ),
    ],
  };
}
