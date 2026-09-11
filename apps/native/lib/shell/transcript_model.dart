/// What the thread holds and the order it draws it in.
///
/// Three rules live here: the projection that turns durable runs into lines,
/// the ordering that keeps a Turn's lines together, and the words the working
/// row says while a supersede drains.
/// Rendering is [TranscriptView]'s; nothing in this file touches a widget, so
/// every rule below is testable without pumping a frame.
library;

import 'dart:convert';

/// One user-facing send, as the thread draws it. `unsupported` is a payload
/// this client cannot draw — a newer shape, or a malformed one. The thread
/// says so rather than throwing: a Turn's history has to render on a client
/// older than the Bot that produced it.
class SendPayloadLine {
  final Map<String, Object?>? payload;
  const SendPayloadLine(this.payload);
  bool get unsupported => payload == null;
  String? get type => payload?['type'] as String?;
}

/// One tool the Turn ran. Receipts live on the run view, never in the thread.
class ToolActivity {
  final String id;
  final String name;
  final String status;
  final String? text;
  final Object? input;
  const ToolActivity({
    required this.id,
    required this.name,
    required this.status,
    this.text,
    this.input,
  });
}

enum LineRole { user, assistant, system }

/// `streaming` is a Turn in flight; `aborted` is one that was stopped or
/// superseded; `error` is one that broke.
enum LineStatus { streaming, completed, aborted, error }

/// The way out of an ending the person cannot otherwise act on. `resendTurn`
/// sends this Turn's own message again, unchanged, as a new Turn.
/// The way out of a failed Turn a client can offer: sending the same message
/// again, or opening Billing when the account could not pay for the reply.
enum LineRetry { resendTurn, openBilling }

class TranscriptLine {
  final String id;
  final String runId;
  final LineRole role;
  final String text;

  /// When the line happened, ISO-8601, when the projection knows.
  final String? at;
  final LineStatus status;

  /// True while this line's Turn is admitted but has not started, because the
  /// person sent it while the Bot was still on the previous one.
  final bool pending;

  /// True once a durable Stop has been accepted for this Turn. The person is
  /// waiting on a settlement they asked for, and the row says so.
  final bool stopRequested;

  /// Why the Turn ends where it does, under whatever it had already said —
  /// never as the bubble's own text, which reads as the Bot saying it.
  final String? notice;
  final LineRetry? retry;
  final List<ToolActivity> tools;
  final List<SendPayloadLine> sends;
  const TranscriptLine({
    required this.id,
    required this.runId,
    required this.role,
    required this.text,
    required this.status,
    this.at,
    this.pending = false,
    this.stopRequested = false,
    this.notice,
    this.retry,
    this.tools = const [],
    this.sends = const [],
  });

  bool get empty =>
      text.isEmpty && notice == null && sends.isEmpty && retry == null;
}

/// Where each Turn sits in the conversation: the timestamp of the message the
/// person sent, which is what every line of that Turn is ordered by.
///
/// A Turn's lines are stamped from two different clocks — the durable
/// projection stamps them with the run's `admittedAt`, while a Turn this
/// client sent is drawn immediately from the device's clock, before the
/// backend has seen it — so ordering every line by its own timestamp put a
/// reply above the message it answered. A Turn whose user line carries no
/// timestamp yet anchors on the first stamp any of its lines has.
Map<String, String> turnAnchors(List<TranscriptLine> lines) {
  final anchors = <String, String>{};
  for (final line in lines) {
    final at = line.at;
    if (line.role == LineRole.system || at == null) continue;
    if (line.role == LineRole.user) {
      anchors[line.runId] = at;
      continue;
    }
    anchors.putIfAbsent(line.runId, () => at);
  }
  return anchors;
}

/// The thread, in the order it is drawn.
///
/// [now] stands in for a line with no timestamp at all, so an incomplete
/// projection sorts to the bottom rather than jumping above durable history.
/// The sort is stable on list order, which is the durable order the projection
/// maintains. A line belonging to no Turn — a system announcement — still
/// sorts by its own time; nothing here reorders a Turn's own lines.
List<TranscriptLine> orderTranscript(List<TranscriptLine> lines, String now) {
  final anchors = turnAnchors(lines);
  String keyOf(TranscriptLine line) =>
      (line.role == LineRole.system
          ? line.at
          : anchors[line.runId] ?? line.at) ??
      now;
  final indexed = [
    for (var index = 0; index < lines.length; index++) (index, lines[index]),
  ];
  indexed.sort((left, right) {
    final compared = keyOf(left.$2).compareTo(keyOf(right.$2));
    return compared != 0 ? compared : left.$1 - right.$1;
  });
  return [for (final entry in indexed) entry.$2];
}

// ------------------------------------------------------- supersede drain

/// The words while the previous reply is being stopped.
const supersedeDrainLabelText = 'Stopping the previous reply…';

/// The words once it is taking longer than anyone expects. It says the same
/// thing, because the same thing is still true — it does not escalate, offer a
/// button, or imply the person did something wrong.
const supersedeDrainSlowLabelText = 'Still stopping the previous reply';

/// How long the ordinary wording stands. A Turn cancels at its next external
/// effect, so a few seconds is normal and a model mid-request can take longer;
/// twenty is well past "normal" without reading as an app that has stopped.
const supersedeDrainSlowAfter = Duration(seconds: 20);

/// `none` is every ordinary moment, an ordinary running Turn included.
enum SupersedeDrainState { none, stopping, slow }

/// Read off the transcript rather than tracked as a flag, so it survives a
/// reload: a Turn waiting behind another is queued in durable run state, and
/// [TranscriptLine.pending] is that fact projected.
SupersedeDrainState supersedeDrainState(
  List<TranscriptLine> lines,
  DateTime now,
) {
  TranscriptLine? waiting;
  for (final line in lines) {
    if (line.role == LineRole.assistant &&
        line.status == LineStatus.streaming &&
        line.pending) {
      waiting = line;
    }
  }
  if (waiting == null) return SupersedeDrainState.none;
  final startedAt = waiting.at == null ? null : DateTime.tryParse(waiting.at!);
  if (startedAt == null) return SupersedeDrainState.stopping;
  return now.difference(startedAt) >= supersedeDrainSlowAfter
      ? SupersedeDrainState.slow
      : SupersedeDrainState.stopping;
}

/// The words for a state, or null when the row says nothing.
String? supersedeDrainLabel(SupersedeDrainState state) => switch (state) {
  SupersedeDrainState.stopping => supersedeDrainLabelText,
  SupersedeDrainState.slow => supersedeDrainSlowLabelText,
  SupersedeDrainState.none => null,
};

// ----------------------------------------------------------- projection

/// The half of a failure sentence that asks the person to send it again. The
/// words stay on the wire — a client that cannot offer the action still needs
/// to say what to do — and this client drops them and shows the action.
const failureRetryInvitation = ' Try again.';

/// What a Turn says when nothing more specific is known about how it ended.
const runFailureFallbackCopy = "This Bot couldn't finish its reply. Try again.";

/// The product's own sentences.
///
/// A run's stored failure is a provider's diagnostic; under a bubble it reads
/// as part of what the Bot was saying. The projection already maps failures to
/// copy before they cross the wire, but a `Run` can arrive from an older
/// backend that forwarded the raw string, so the thread accepts a failure only
/// when it recognises it as something the product wrote.
const knownFailureCopy = <String>{
  "This Bot couldn't finish its reply. Try again.",
  "This Bot wouldn't do that. Try asking a different way.",
  'You stopped this.',
  'This reply stopped before it finished. Try again.',
  "The model couldn't finish its reply. Try again.",
  'The model finished without sending a reply. Try again.',
  "Something the Bot was using didn't work. Try again.",
  "This message can't be shown in this version. Reload to update.",
  // The four the kernel writes for the person rather than for the log. They
  // say something the outcome alone cannot — a Turn that ran out of wall
  // clock, a model that never started or went quiet, a reply that used every
  // step it had — so they are carried through verbatim.
  'This Bot used all the steps it had for one reply and stopped. What it '
      'finished is saved. Send another message to carry on.',
  'This Turn ran for 15 minutes without finishing and was stopped. Try '
      'sending it again.',
  'The model did not start replying within 2 minutes and the request was '
      'stopped. Try sending it again.',
  'The model stopped part-way through its reply and went quiet for a minute, '
      'so the request was stopped. Try sending it again.',
  ...billingFailureCopy,
};

/// Billing's two refusals. Their way out is Billing, not sending again.
const billingFailureCopy = <String>{
  'A paid FrockBot subscription is required. Open Billing to subscribe or '
      'update your payment method.',
  'You have no usage credit left. Open Billing to add more.',
};

/// A failure sentence split into what it reports and whether sending the same
/// message again is the way out of it. "You stopped this." and "This Bot
/// wouldn't do that." are endings the person chose or the Bot meant, and
/// neither is repaired by sending the message a second time.
({String notice, LineRetry? action}) failureNotice(String? failure) {
  final copy = failure != null && knownFailureCopy.contains(failure)
      ? failure
      : runFailureFallbackCopy;
  if (billingFailureCopy.contains(copy)) {
    return (notice: copy, action: LineRetry.openBilling);
  }
  return copy.endsWith(failureRetryInvitation)
      ? (
          notice: copy.substring(
            0,
            copy.length - failureRetryInvitation.length,
          ),
          action: LineRetry.resendTurn,
        )
      : (notice: copy, action: null);
}

/// Each send with the ordinal the cloud names it by.
///
/// The ordinal counts the Turn's durable sends, and the projection drops old
/// ones when a Turn outgrows the wire budget, so the position in this list is
/// not the message's identity. A read the cloud can match has to carry the
/// ordinal the cloud minted.
List<({SendPayloadLine send, int ordinal})> _sendsFrom(List<Object?> events) {
  final sends = <({SendPayloadLine send, int ordinal})>[];
  for (final event in events) {
    if (event is! Map || event['type'] != 'send/to-user') continue;
    final payload = event['payload'];
    final ordinal = event['ordinal'];
    // The ordinal is the message's durable identity, and the wire gate makes
    // every server that can reach this build emit it. A send without one is
    // unidentifiable — it cannot be read, marked unread, or matched to a
    // notification — so it is dropped rather than given a position that shifts
    // under it the moment the page it sits on changes.
    if (ordinal is! int || ordinal < 0) continue;
    sends.add((
      send: SendPayloadLine(
        payload is Map && payload['type'] is String
            ? Map<String, Object?>.from(payload)
            : null,
      ),
      ordinal: ordinal,
    ));
  }
  return sends;
}

/// What a tool call is called on the Work view.
///
/// A dynamic call is a wrapper around the tool the Bot actually reached, and
/// "call_dynamic_tool" tells a person nothing; the namespaced name it carries
/// tells them everything.
({String name, Object? input}) _presentedToolCall(Map call) {
  final input = call['input'];
  if (call['name'] == 'call_dynamic_tool' && input is Map) {
    final namespace = input['namespace'];
    final toolName = input['toolName'];
    if (namespace is String && toolName is String) {
      Object? inner = const <String, Object?>{};
      final encoded = input['argumentsJson'];
      if (encoded is String) {
        try {
          inner = jsonDecode(encoded);
        } catch (_) {
          inner = const <String, Object?>{};
        }
      }
      return (name: '$namespace/$toolName', input: inner);
    }
  }
  return (name: '${call['name'] ?? 'tool'}', input: input);
}

List<ToolActivity> _toolsFrom(List<Object?> events) {
  final tools = <String, ToolActivity>{};
  for (final event in events) {
    if (event is! Map) continue;
    if (event['type'] == 'tool/call' && event['call'] is Map) {
      final call = event['call'] as Map;
      final id = '${call['id']}';
      final presented = _presentedToolCall(call);
      tools[id] = ToolActivity(
        id: id,
        name: presented.name,
        status: 'running',
        input: presented.input,
      );
    }
    if (event['type'] == 'tool/result' && event['callId'] is String) {
      final existing = tools[event['callId']];
      if (existing == null) continue;
      tools[existing.id] = ToolActivity(
        id: existing.id,
        name: existing.name,
        status: event['isError'] == true ? 'failed' : 'completed',
        text: event['content'] as String?,
        input: existing.input,
      );
    }
  }
  return tools.values.toList();
}

/// Projects durable runs into the lines the thread draws.
///
/// One line per `send_to_user` in the order the Bot sent them, then the Turn's
/// own closing line under them. A bubble is never edited once it is in the
/// transcript: a later send appends, it does not replace.
List<TranscriptLine> projectRuns(List<Map<String, dynamic>> runs) {
  final lines = <TranscriptLine>[];
  for (final run in runs) {
    final runId = run['runId'] as String;
    final events = (run['events'] as List?) ?? const [];
    final status = run['status'] as String?;
    final queued = run['queued'] == true;
    final admittedAt = run['admittedAt'] as String?;
    final input = (run['input'] as String?) ?? '';
    // A Routine's Turn is projected with no input at all: nobody typed it. A
    // chat Turn cannot be admitted empty, so an empty input means there is no
    // person's message to draw above the Bot's — not an empty one.
    if (input.isNotEmpty) {
      lines.add(
        TranscriptLine(
          id: '$runId:user',
          runId: runId,
          role: LineRole.user,
          text: input,
          at: admittedAt,
          status: LineStatus.completed,
          pending: status == 'running' && queued,
        ),
      );
    }
    final sends = _sendsFrom(events);
    for (var index = 0; index < sends.length; index++) {
      lines.add(
        TranscriptLine(
          id: '$runId:send:${sends[index].ordinal}',
          runId: runId,
          role: LineRole.assistant,
          text: '',
          at: admittedAt,
          status: LineStatus.completed,
          sends: [sends[index].send],
        ),
      );
    }
    final tools = _toolsFrom(events);
    // Only explicit sends carry the Bot's voice; outcome text is private.
    const text = '';
    final outcome = run['outcome'] as Map?;
    // Whether the outcome's words have already been said to the person. A
    // firing that broke or was stopped before it could speak is told as an
    // ordinary message, and the cloud projects that message onto the run and
    // makes the outcome say the same words; drawing them again as a notice
    // underneath would be the one event said twice.
    final outcomeMessage = outcome?['message'];
    final spoken =
        outcomeMessage is String &&
        sends.any((send) => send.send.payload?['text'] == outcomeMessage);
    switch (status) {
      case 'running':
        lines.add(
          TranscriptLine(
            id: '$runId:assistant',
            runId: runId,
            role: LineRole.assistant,
            text: text,
            at: admittedAt,
            status: LineStatus.streaming,
            // A Turn that has not started shows nothing of its own: the greyed
            // user message is the whole of what the thread says about it.
            pending: queued,
            stopRequested: run['stopRequestedAt'] != null,
            tools: tools,
          ),
        );
      case 'superseded':
        // Quieter than a stopped Turn: it keeps everything it already sent and
        // carries no notice at all. The message that superseded it is sitting
        // right underneath, in the person's own words.
        lines.add(
          TranscriptLine(
            id: '$runId:assistant',
            runId: runId,
            role: LineRole.assistant,
            text: text,
            at: admittedAt,
            status: LineStatus.aborted,
            tools: tools,
          ),
        );
      case 'cancelled':
        lines.add(
          TranscriptLine(
            id: '$runId:assistant',
            runId: runId,
            role: LineRole.assistant,
            text: text,
            at: admittedAt,
            status: LineStatus.aborted,
            notice: spoken ? null : 'You stopped this.',
            tools: tools,
          ),
        );
      case 'failed':
        // The reason is on the run's `outcome`: the stored `failure` is a
        // provider diagnostic and never crosses the wire at all. Reading a
        // field the wire does not carry made every failed Turn say the one
        // generic line, whatever had actually gone wrong.
        //
        // Unless the person has already been sent it. A firing that broke
        // before it could speak is told as an ordinary message, and the cloud
        // projects that message onto the run and makes the outcome say the
        // same words; drawing them again underneath would be the one event
        // said twice. The row stays — it is where the Turn's tools hang, and
        // the run is still `failed` — it just says nothing of its own.
        final failure = failureNotice(outcome?['message'] as String?);
        // Named as its own message. The cloud counts a failed Turn unread
        // under this id, so the line the person is shown is the line their
        // read clears, and "Mark unread from here" can name it too.
        lines.add(
          TranscriptLine(
            id: '$runId:failed',
            runId: runId,
            role: LineRole.assistant,
            // A Turn that broke after it had started talking keeps what it
            // said, with the reason underneath it.
            text: text,
            at: admittedAt,
            status: LineStatus.error,
            notice: spoken ? null : failure.notice,
            retry: spoken ? null : failure.action,
            tools: tools,
          ),
        );
      default:
        lines.add(
          TranscriptLine(
            id: '$runId:assistant',
            runId: runId,
            role: LineRole.assistant,
            text: text,
            at: admittedAt,
            status: LineStatus.completed,
            tools: tools,
          ),
        );
    }
  }
  return lines;
}

/// What a compaction says. The summary itself is deliberately not on the wire:
/// every Turn it covers is still readable, unchanged, immediately above this
/// line, and the summary is what the model carries rather than what a person
/// reads.
const compactedAnnouncementText =
    'Earlier messages are now carried as a summary. They are all still here to read.';

/// Projects the conversation's announcements as system lines.
///
/// They belong to the Session rather than to a Turn, and they carry the
/// timestamp of the place they belong — a compaction is dated at the end of
/// the range it covers, not when the summariser ran — so `orderTranscript`
/// seats each one between the Turns it happened between.
List<TranscriptLine> projectAnnouncements(List<Object?> announcements) {
  final lines = <TranscriptLine>[];
  for (final value in announcements) {
    if (value is! Map) continue;
    final announcement = value.cast<String, Object?>();
    final id = announcement['announcementId'];
    if (id is! String) continue;
    final renamed = announcement['type'] == 'bot/renamed';
    lines.add(
      TranscriptLine(
        id: id,
        runId: id,
        role: LineRole.system,
        text: renamed
            ? 'Renamed to ${announcement['to']} by ${announcement['namedBy']}'
            : compactedAnnouncementText,
        at: announcement['at'] as String?,
        status: LineStatus.completed,
      ),
    );
  }
  return lines;
}

/// The text a failed Turn would be retried with, or nothing where there is no
/// such text. The same size rule as the composer, because a resend is an
/// ordinary Turn: a message that could not be sent again is not offered again.
String? resendableTurnText(String? text, {required int maxCharacters}) {
  final trimmed = text?.trim() ?? '';
  return trimmed.isNotEmpty && trimmed.length <= maxCharacters ? trimmed : null;
}
