/// What the Bot is doing to the focused Applet, in words a person reads.
///
/// A port of `app/shell/client/applet-progress.ts`. Building an Applet takes
/// minutes — the Bot scaffolds it, writes the files, runs `applet check` and
/// `applet build`, and only then publishes — and for all of it there is
/// nothing to run. This is the sentence in between, projected from what the
/// thread already shows: no new read, no new durable state.
///
/// It is a projection, never an authority. When the signals say nothing
/// specific the answer is the honest fallback rather than an invented step.
library;

import '../protocol/client_wire.generated.dart' as wire;
import '../shell/transcript_model.dart';
import 'client.dart';

/// Where the work has got to. The order is the order the Bot does them in, and
/// the projection takes the furthest one it has evidence for. `unknown` is a
/// draft with nothing said about it yet.
enum AppletStage {
  unknown('Still being built', 'Still being built'),
  created('Just getting started', 'Just getting started'),
  writing('Writing the code', 'Writing the code'),
  checking('Checking the code', 'The code checks out'),
  building('Putting it together', 'Built and ready to go live'),
  publishing('Getting it ready to open', 'Getting it ready to open'),
  published('Ready to use', 'Ready to use');

  const AppletStage(this.doing, this.finished);
  final String doing;
  final String finished;
}

/// The tail of a check or a build, so a long log never fills the panel.
const appletProgressOutputLinesV1 = 12;
const appletProgressLineCharactersV1 = 200;

/// A failure is a sentence in the panel, not a wall of text.
const appletProgressFailureCharactersV1 = 400;

class AppletProgress {
  final AppletStage stage;

  /// The line the canvas shows.
  final String label;

  /// True while the Turn doing this is still going.
  final bool working;

  /// True when this step finished and finished cleanly.
  final bool done;

  /// What went wrong, in the words of whatever refused.
  final String? failure;

  /// The last lines the check or the build printed.
  final List<String> output;
  const AppletProgress({
    required this.stage,
    required this.label,
    required this.working,
    required this.done,
    this.failure,
    this.output = const [],
  });
}

AppletStage _furthest(AppletStage left, AppletStage right) =>
    right.index > left.index ? right : left;

/// The bare tool name, whether it arrived namespaced or native.
String _toolName(ToolActivity activity) {
  final slash = activity.name.lastIndexOf('/');
  return slash < 0 ? activity.name : activity.name.substring(slash + 1);
}

/// Whether this tool call is about the Applet in the canvas.
///
/// A dynamic call carries its parsed arguments, so a publish of some other
/// Applet never moves this one's line. `applet_create` names no id — it is
/// making one — so it counts for whichever Applet the Session then focuses.
bool _namesApplet(ToolActivity activity, String appletId) {
  final input = activity.input;
  if (input is! Map) return true;
  final named = input['appletId'];
  return named is String ? named == appletId : true;
}

String _trimLine(String line) => line.length > appletProgressLineCharactersV1
    ? '${line.substring(0, appletProgressLineCharactersV1 - 1)}…'
    : line;

List<String> _tail(String text) {
  final lines = [
    for (final line in text.split('\n'))
      if (line.trimRight().isNotEmpty) line.trimRight(),
  ];
  return [
    for (final line in lines.skip(
      lines.length <= appletProgressOutputLinesV1
          ? 0
          : lines.length - appletProgressOutputLinesV1,
    ))
      _trimLine(line),
  ];
}

String _sentence(String text) {
  final trimmed = text.trim();
  if (trimmed.isEmpty) return '';
  return trimmed.length > appletProgressFailureCharactersV1
      ? '${trimmed.substring(0, appletProgressFailureCharactersV1 - 1)}…'
      : trimmed;
}

final _checkOutput = RegExp(r'^applet check:', multiLine: true);
final _checkErrors = RegExp(r'^applet check: \d+ error', multiLine: true);

/// Whether a shell command's output is the `applet` CLI reporting on itself.
///
/// The client is never told what a `computer_exec` ran — the Turn projection
/// carries a call's arguments only for a namespace the person connected
/// themselves, never for a first-party tool. What it does carry is the
/// result, and the CLI's output is a stated contract, so recognising it is
/// reading a published shape rather than guessing at a command. Anything else
/// looks like nothing here and is ignored, which is the right failure: no line
/// rather than a wrong one.
({String command, List<String> output})? appletCommandOutputV1(String? text) {
  if (text == null) return null;
  if (_checkOutput.hasMatch(text)) {
    return (command: 'check', output: _tail(text));
  }
  if (text.contains('dist/manifest.json') && text.contains('dist/server.js')) {
    return (command: 'build', output: _tail(text));
  }
  return null;
}

/// The one line about the focused Applet, and what sits under it. Null when
/// there is no Applet in the canvas to say it about.
AppletProgress? appletProgressV1({
  wire.AppletSummary? applet,
  AppletSource? source,
  AppletBuild? build,
  List<ToolActivity> tools = const [],
  bool running = false,
}) {
  if (applet == null) return null;

  var stage = AppletStage.unknown;
  String? failure;
  var output = const <String>[];
  var done = false;

  // The directory entry is the settled fact: a generation is current, so the
  // Applet runs. A Turn working on it now moves the line off this again.
  if (applet.currentGenerationId != null) {
    stage = AppletStage.published;
    done = true;
  }

  // What the authority recorded, read before the Turn's own evidence so a
  // running Turn wins.
  if (build != null && build.status != 'unknown') {
    stage = _furthest(
      stage,
      build.command == 'build' ? AppletStage.building : AppletStage.checking,
    );
    done = build.status == 'passed';
    if (build.status == 'failed') {
      failure = _sentence(build.summary ?? 'The last check did not pass.');
      if (build.diagnostics.isNotEmpty) {
        output = [
          for (final line in build.diagnostics.skip(
            build.diagnostics.length <= appletProgressOutputLinesV1
                ? 0
                : build.diagnostics.length - appletProgressOutputLinesV1,
          ))
            _trimLine(line),
        ];
      }
    }
  }

  if (appletSourceFilesV1(source).isNotEmpty) {
    stage = _furthest(stage, AppletStage.writing);
  }

  var working = false;
  for (final activity in tools) {
    final name = _toolName(activity);
    if (name == 'computer_exec') {
      if (activity.status == 'running') {
        // A shell command in flight during a build is the Bot working on the
        // Applet; which command it is only becomes knowable when it returns.
        working = true;
        done = false;
        continue;
      }
      final ran = appletCommandOutputV1(activity.text);
      if (ran == null) continue;
      stage = _furthest(
        stage,
        ran.command == 'build' ? AppletStage.building : AppletStage.checking,
      );
      output = ran.output;
      final wrong =
          activity.status == 'failed' ||
          (ran.command == 'check' &&
              _checkErrors.hasMatch(activity.text ?? ''));
      failure = wrong
          ? ran.command == 'build'
                ? 'Putting it together did not work.'
                : 'The code has problems that need fixing.'
          : null;
      done = !wrong;
      continue;
    }
    if (!_namesApplet(activity, applet.appletId)) continue;
    if (name == 'applet_create') {
      stage = _furthest(stage, AppletStage.created);
      if (activity.status == 'running') {
        working = true;
        done = false;
      } else if (activity.status == 'failed') {
        failure = _sentence(activity.text ?? 'This Applet could not be made.');
        done = false;
      } else {
        done = true;
      }
      continue;
    }
    if (name == 'applet_publish') {
      if (activity.status == 'running') {
        stage = _furthest(stage, AppletStage.publishing);
        working = true;
        failure = null;
        done = false;
        continue;
      }
      if (activity.status == 'failed') {
        stage = _furthest(stage, AppletStage.publishing);
        failure = _sentence(
          activity.text ?? 'It could not be made ready to open.',
        );
        done = false;
        continue;
      }
      stage = _furthest(stage, AppletStage.published);
      failure = null;
      done = true;
    }
  }

  if (running) working = true;

  return AppletProgress(
    stage: stage,
    label: done ? stage.finished : stage.doing,
    working: working,
    done: done,
    failure: failure,
    output: output,
  );
}

/// The tool activity the line is read from: every Turn's, oldest first.
///
/// Not just the Turn that is running. Building an Applet takes several Turns,
/// and the last thing that happened to the Applet is what a person wants to
/// know, whether or not it happened in the Turn still open.
List<ToolActivity> appletProgressToolsV1(List<TranscriptLine> lines) => [
  for (final line in lines)
    if (line.role == LineRole.assistant) ...line.tools,
];

/// Whether the canvas should be showing the building view rather than the
/// Applet. A published Applet with a Turn working on it keeps showing what it
/// has: replacing a working Applet with a progress line takes something away.
bool appletIsBeingBuiltV1(AppletProgress? progress) =>
    progress != null && progress.stage != AppletStage.published;
