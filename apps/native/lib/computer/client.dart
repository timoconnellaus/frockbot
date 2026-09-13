/// The Computer, as a client reads it.
///
/// A port of `computer/client/application.ts`, `progress.ts`, `live-preview.ts`
/// and `viewer.ts` — the projection the Bot Durable Object answers with, one
/// versioned command per action, and the two pure rules the card needs: which
/// of the desktop or its last photograph is on screen, and what to call that.
///
/// The viewer URL is a bearer secret for the VNC transport. It crosses this
/// one projection, lives only in memory, and never enters the durable store, a
/// log, or a document.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../client/transport.dart';

/// The phases the authority projects.
const computerPhasesV1 = <String>{
  'unconfigured',
  'idle',
  'provisioning',
  'updating',
  'ready',
  'taking-control',
  'human-control',
  'disconnected',
  'error',
};

/// The commands a client may submit.
const computerCommandTypesV1 = <String>{
  'connect',
  'takeControl',
  'releaseControl',
  'refreshControl',
  'refreshViewer',
  'closeViewer',
  'runDoctor',
};

/// What the card promises a first-ever cold provision will take.
const computerColdProvisionExpectationV1 = 'This usually takes 2-3 minutes';

class ComputerStep {
  final String id;
  final String label;

  /// `pending`, `active` or `complete`.
  final String status;
  const ComputerStep(this.id, this.label, this.status);
}

class ComputerProgress {
  /// `connect` or `update`.
  final String kind;
  final int index;
  final int total;
  final String? provisioningLabel;
  final bool resumed;
  final String? provisioningKind;
  final List<ComputerStep> steps;
  const ComputerProgress({
    required this.kind,
    required this.index,
    required this.total,
    required this.steps,
    this.provisioningLabel,
    this.provisioningKind,
    this.resumed = false,
  });

  /// How far along, where the authority said enough to know.
  double? get fraction => total <= 0 ? null : (index / total).clamp(0.0, 1.0);

  String? get activeLabel =>
      provisioningLabel ??
      steps
          .where((step) => step.status == 'active')
          .map((s) => s.label)
          .firstOrNull;
}

class ComputerScreenshot {
  final String url;
  final String contentHash;
  final DateTime capturedAt;
  const ComputerScreenshot({
    required this.url,
    required this.contentHash,
    required this.capturedAt,
  });
}

class ComputerProjection {
  final String phase;
  final String message;
  final String providerLabel;
  final ComputerProgress? progress;

  /// The bearer URL of a minted viewer session. Memory only.
  final String? viewerUrl;
  final bool controlHeld;
  final List<ComputerScreenshot> screenshots;
  const ComputerProjection({
    required this.phase,
    required this.message,
    required this.providerLabel,
    this.progress,
    this.viewerUrl,
    this.controlHeld = false,
    this.screenshots = const [],
  });

  bool get running =>
      const {'ready', 'taking-control', 'human-control'}.contains(phase);

  static const unknown = ComputerProjection(
    phase: 'unconfigured',
    message: 'No computer',
    providerLabel: '',
  );

  factory ComputerProjection.fromJson(Object? value) {
    final json = (value as Map).cast<String, Object?>();
    final phase = json['phase'];
    if (phase is! String || !computerPhasesV1.contains(phase)) {
      throw const FormatException('Unknown Computer phase');
    }
    final progress = json['progress'] as Map?;
    final session = json['viewerSession'] as Map?;
    return ComputerProjection(
      phase: phase,
      message: json['message']! as String,
      providerLabel: json['providerLabel']! as String,
      viewerUrl: session?['url'] as String?,
      controlHeld: json['controlLease'] != null,
      progress: progress == null
          ? null
          : ComputerProgress(
              kind: progress['kind']! as String,
              index: (progress['index']! as num).toInt(),
              total: (progress['total']! as num).toInt(),
              resumed: (progress['provisioning'] as Map?)?['resumed'] == true,
              provisioningKind:
                  (progress['provisioning'] as Map?)?['kind'] as String?,
              provisioningLabel:
                  (progress['provisioning'] as Map?)?['label'] as String?,
              steps: [
                for (final step in (progress['steps']! as List).cast<Map>())
                  ComputerStep(
                    step['id']! as String,
                    step['label']! as String,
                    step['status']! as String,
                  ),
              ],
            ),
      screenshots: [
        for (final shot
            in (json['screenshots'] as List? ?? const []).cast<Map>())
          ComputerScreenshot(
            url: shot['url']! as String,
            contentHash: shot['contentHash']! as String,
            capturedAt: DateTime.parse(shot['capturedAt']! as String),
          ),
      ],
    );
  }
}

/// Whether the live Turn has reached one of the hosted Computer tools.
///
/// A Bot wakes the Computer through its tools without minting the viewer
/// session that makes [ComputerProjection.running] true. The conversation is
/// already the live projection of that work, so the header can show the same
/// running affordance while such a call is in flight.
bool botComputerRunningV1(Iterable<Map<String, dynamic>> runs) {
  for (final run in runs) {
    if (run['status'] != 'running') continue;
    for (final event in (run['events'] as List? ?? const [])) {
      if (event is! Map || event['type'] != 'tool/call') continue;
      final call = event['call'];
      if (call is! Map) continue;
      final name = call['name'];
      if (name is String && name.startsWith('computer_')) return true;
      if (name == 'call_dynamic_tool') {
        final input = call['input'];
        if (input is Map &&
            input['namespace'] == 'frockbot' &&
            input['toolName'] is String &&
            (input['toolName'] as String).startsWith('computer_')) {
          return true;
        }
      }
    }
  }
  return false;
}

/// What the opening card and overlay call this run.
String computerOpeningHeadingV1(ComputerProjection state) {
  final progress = state.progress;
  if (state.phase == 'updating' ||
      progress?.kind == 'update' ||
      progress?.provisioningKind == 'update') {
    return 'Updating your computer';
  }
  if (progress == null || progress.provisioningKind != 'provision') {
    return 'Preparing computer…';
  }
  if (progress.resumed) return 'Resuming computer setup';
  return 'Setting up your computer for the first time';
}

/// Whether this run is the first-ever provision, which is the only one the
/// card makes a promise about.
bool computerColdProvisionV1(ComputerProjection state) {
  final progress = state.progress;
  return state.phase != 'updating' &&
      progress != null &&
      progress.kind == 'connect' &&
      progress.provisioningKind == 'provision' &&
      !progress.resumed;
}

/// How long the card keeps streaming after the Bot's Turn settles.
///
/// A Turn that ends is usually followed by another within seconds. Dropping
/// the connection the instant a Turn stops would make the next one reconnect
/// from black, which is the stall this exists to remove; the grace window is
/// what stops an idle Bot from holding a connection all afternoon.
const computerLivePreviewGraceV1 = Duration(seconds: 15);

/// How often the card re-reads its own status line while it is on screen.
const computerScreenStatusTickV1 = Duration(seconds: 1);

/// The phases in which a minted viewer session addresses a desktop that is
/// actually there. Provisioning and updating are hosts mid-operation, and the
/// card draws their progress rather than a frame that cannot connect.
const _streamablePhases = {'ready', 'taking-control', 'human-control'};

/// Whether the card draws the Bot's desktop live or the last stored capture.
///
/// One sentence: stream a desktop that exists, to a card someone is actually
/// looking at, while the Bot is working or has just stopped. Every other
/// answer is the snapshot, which costs nothing to hold.
bool computerStreamsV1({
  String? viewerUrl,
  required String phase,
  required bool expanded,
  required bool turnRunning,
  required bool onScreen,
  Duration? sinceTurnEnded,
  Duration grace = computerLivePreviewGraceV1,
}) {
  if (viewerUrl == null) return false;
  if (!onScreen && !expanded) return false;
  if (!_streamablePhases.contains(phase)) return false;
  if (expanded || turnRunning) return true;
  return sinceTurnEnded != null && sinceTurnEnded < grace;
}

/// A whole-unit age, coarse enough that it does not redraw every frame.
String computerSnapshotAgeLabelV1(Duration age) {
  final seconds = age.inSeconds < 0 ? 0 : age.inSeconds;
  if (seconds < 60) return '${seconds}s ago';
  if (seconds < 3600) return '${seconds ~/ 60}m ago';
  if (seconds < 86400) return '${seconds ~/ 3600}h ago';
  return '${seconds ~/ 86400}d ago';
}

/// The one line under the screen, in the reader's words.
///
/// "Live" and "Snapshot · 12s ago" are the whole vocabulary: the question is
/// whether they are watching the Bot or a photograph of it, and no answer that
/// names a transport or a session answers that.
String? computerScreenStatusLabelV1({
  required bool streaming,
  DateTime? capturedAt,
  DateTime? now,
}) {
  if (streaming) return 'Live';
  if (capturedAt == null) return null;
  return 'Snapshot · '
      '${computerSnapshotAgeLabelV1((now ?? DateTime.now()).difference(capturedAt))}';
}

/// Changes only the viewer's client-visible input fence on one minted session.
///
/// The bearer token and path stay byte for byte inside the same URL fragment;
/// control changes no server session and mints no second secret.
String viewerUrlForControlV1(String viewerUrl, bool takingControl) {
  final url = Uri.parse(viewerUrl);
  final fragment = Uri.splitQueryString(url.fragment);
  return url
      .replace(
        fragment: Uri(
          queryParameters: {
            ...fragment,
            'view_only': takingControl ? '0' : '1',
          },
        ).query,
      )
      .toString();
}

/// How often the projection is re-read. A Bot mid-operation is asked more
/// often; an idle one costs one read every twenty seconds.
const computerPollV1 = Duration(seconds: 20);
const computerActivePollV1 = Duration(milliseconds: 1500);
const _activePhases = {'provisioning', 'updating', 'taking-control'};

/// One Bot's Computer: the projection, and the commands that move it.
class ComputerController extends ChangeNotifier {
  final NativeApi api;
  final String botId;
  ComputerController(this.api, this.botId);

  ComputerProjection state = ComputerProjection.unknown;
  bool available = false;
  bool busy = false;
  bool expanded = false;
  bool takingControl = false;
  String? failure;
  Timer? _poll;
  bool _closed = false;

  String get _root => '/api/bots/${Uri.encodeComponent(botId)}/computer';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  Future<void> read() async {
    try {
      state = ComputerProjection.fromJson(await api.request(_root));
      available = true;
      failure = null;
    } on RequestFailure catch (error) {
      // A deployment without the Computer answers 404, which is silence rather
      // than a failure: the card is simply not there. Every other answer is a
      // Computer that is there and could not be read — a host that is down
      // answers exactly this — so the card stays, says what refused, and keeps
      // asking. Hiding it would turn a dependency being down into a Bot that
      // never had a Computer.
      if (error.status == 404) {
        available = false;
        failure = null;
      } else {
        available = true;
        failure = error.message;
      }
    } catch (_) {
      available = true;
      failure = 'Couldn’t read the computer.';
    }
    _schedule();
    _changed();
  }

  void _schedule() {
    _poll?.cancel();
    if (_closed || !available) return;
    final active = _activePhases.contains(state.phase) || expanded;
    _poll = Timer(
      active ? computerActivePollV1 : computerPollV1,
      () => unawaited(read()),
    );
  }

  /// One versioned command, under its own id.
  Future<void> command(String type) async {
    if (busy || !computerCommandTypesV1.contains(type)) return;
    busy = true;
    failure = null;
    _changed();
    try {
      await api.request(
        '$_root/commands',
        body: {
          'version': 1,
          'commandId': randomId(),
          'botId': botId,
          'type': type,
        },
      );
    } on RequestFailure catch (error) {
      failure = error.message;
    } finally {
      busy = false;
      _changed();
      await read();
    }
  }

  /// Opening is a connect where there is nothing to connect to yet, and a
  /// re-mint where the desktop is already up: `refreshViewer` renews a session
  /// and refuses where none exists, so a Computer that has never been woken
  /// has to be woken first.
  Future<void> open() async {
    expanded = true;
    _changed();
    if (state.viewerUrl == null) {
      await command(
        _streamablePhases.contains(state.phase) ? 'refreshViewer' : 'connect',
      );
    }
    _schedule();
  }

  Future<void> close() async {
    expanded = false;
    takingControl = false;
    _changed();
    await command('closeViewer');
  }

  /// Taking control is two gestures: the ask, then the confirmation. Only the
  /// second reaches the Bot.
  Future<void> takeControl() async {
    takingControl = true;
    _changed();
    await command('takeControl');
  }

  Future<void> releaseControl() async {
    takingControl = false;
    _changed();
    await command('releaseControl');
  }

  @override
  void dispose() {
    _closed = true;
    _poll?.cancel();
    super.dispose();
  }
}
