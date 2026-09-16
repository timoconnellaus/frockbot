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

/// One model call a Plugin made in the Turn, itemised on the run view: which
/// Plugin, which model, the tokens, and the cost when the deployment bills.
class PluginModelCall {
  final String pluginId;
  final String model;
  final int inputTokens;
  final int outputTokens;
  final int? costMicros;
  const PluginModelCall({
    required this.pluginId,
    required this.model,
    required this.inputTokens,
    required this.outputTokens,
    this.costMicros,
  });

  /// "US\$0.0012", or nothing when the deployment did not bill the call.
  String? get cost => costMicros == null
      ? null
      : 'US\$${(costMicros! / 1e6).toStringAsFixed(4)}';
}

enum LineRole { user, assistant, system }

/// `streaming` is a Turn in flight; `aborted` is one that was stopped or
/// superseded; `error` is one that broke.
enum LineStatus { streaming, completed, aborted, error }

/// The way out of an ending the person cannot otherwise act on. `resendTurn`
/// starts a fresh attempt over the same visible user message.
/// The way out of a failed Turn a client can offer: sending the same message
/// again, or opening Billing when the account could not pay for the reply.
enum LineRetry { resendTurn, openBilling }

enum ExchangeStatus { queued, working, answered, stopped, failed }

/// Whether this Bot asked or was asked.
enum ExchangeDirection { inbound, outbound }

/// Who the Bot exchanged messages with: another Bot of the same User, or the
/// account's voice session. A Bot is named by the id the wire carried, and the
/// name recorded at the time — a Bot since renamed or deleted still reads as
/// who it was when it spoke.
class ExchangeCounterpart {
  final String kind;
  final String? botId;
  final String? name;
  const ExchangeCounterpart.bot({required this.botId, required this.name})
    : kind = 'bot';
  const ExchangeCounterpart.voice() : kind = 'voice', botId = null, name = null;
  bool get isVoice => kind == 'voice';

  /// What the thread calls the counterpart.
  String get label => isVoice ? 'Voice' : (name ?? 'a Bot');

  /// The same party, whatever name it carried at the time.
  bool same(ExchangeCounterpart other) =>
      kind == other.kind && botId == other.botId;
}

/// One question and its answer between this Bot and a counterpart. Inbound,
/// the request is the counterpart's and the reply is this Bot's; outbound the
/// other way round.
class Exchange {
  /// This exchange's own identity — its Turn, and the call that sent it —
  /// so two messages to the same Bot in one Turn stay two rows. Their
  /// timestamps are the Turn's, and are equal.
  final String id;
  final ExchangeCounterpart counterpart;
  final ExchangeDirection direction;
  final String request;
  final String? reply;
  final ExchangeStatus status;

  /// When the request was admitted, ISO-8601, when the projection knows.
  final String? at;
  const Exchange({
    required this.id,
    required this.counterpart,
    required this.direction,
    required this.request,
    required this.status,
    this.reply,
    this.at,
  });

  /// What the status says beside the marker, or nothing when the thread
  /// already says it: a running Turn has its own working row, and an answered
  /// exchange has nothing left to report.
  String? get statusLabel => switch (status) {
    ExchangeStatus.queued => 'queued',
    ExchangeStatus.working => null,
    ExchangeStatus.answered => null,
    ExchangeStatus.stopped => 'stopped',
    ExchangeStatus.failed => 'couldn’t answer',
  };
}

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

  /// The cloud counts a failed attempt even when its notice is on the user bubble.
  final String? failureMessageId;
  final String? readAt;
  final List<ToolActivity> tools;
  final List<SendPayloadLine> sends;
  final List<PluginModelCall> pluginCalls;
  final Exchange? exchange;
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
    this.failureMessageId,
    this.readAt,
    this.tools = const [],
    this.sends = const [],
    this.pluginCalls = const [],
    this.exchange,
  });

  bool get empty =>
      text.isEmpty &&
      notice == null &&
      sends.isEmpty &&
      retry == null &&
      exchange == null;
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
    if (line.exchange == null &&
        line.role == LineRole.assistant &&
        line.status == LineStatus.streaming &&
        line.pending) {
      waiting = line;
    }
  }
  if (waiting == null) return SupersedeDrainState.none;
  final admittedAt = waiting.readAt ?? waiting.at;
  final startedAt = admittedAt == null ? null : DateTime.tryParse(admittedAt);
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

List<PluginModelCall> _pluginCallsFrom(List<Object?> events) {
  final calls = <PluginModelCall>[];
  for (final event in events) {
    if (event is! Map || event['type'] != 'plugin/model-usage') continue;
    final pluginId = event['pluginId'];
    final model = event['model'];
    final input = event['inputTokens'];
    final output = event['outputTokens'];
    if (pluginId is! String || model is! String) continue;
    if (input is! int || output is! int) continue;
    final cost = event['costMicros'];
    calls.add(
      PluginModelCall(
        pluginId: pluginId,
        model: model,
        inputTokens: input,
        outputTokens: output,
        costMicros: cost is int ? cost : null,
      ),
    );
  }
  return calls;
}

/// Who asked for a Turn, read off its `via` marker; null for the person.
ExchangeCounterpart? _counterpartOf(Map<String, dynamic> run) {
  final via = run['via'];
  if (via is! Map) return null;
  if (via['kind'] == 'voice') return const ExchangeCounterpart.voice();
  if (via['kind'] == 'bot' && via['botId'] is String) {
    return ExchangeCounterpart.bot(
      botId: via['botId'] as String,
      name: via['name'] is String ? via['name'] as String : null,
    );
  }
  return null;
}

ExchangeStatus _exchangeStatus({
  required bool answered,
  required String? status,
  required bool queued,
}) => answered
    ? ExchangeStatus.answered
    : status == 'running'
    ? (queued ? ExchangeStatus.queued : ExchangeStatus.working)
    : status == 'cancelled' || status == 'superseded'
    ? ExchangeStatus.stopped
    : ExchangeStatus.failed;

/// The Turn's answer to the caller that asked for it, when it has one.
String? _callerReply(List<Object?> events, ExchangeCounterpart counterpart) {
  String? reply;
  for (final event in events) {
    if (event is Map &&
        event['type'] == 'reply/to-caller' &&
        event['caller'] == counterpart.kind &&
        event['text'] is String) {
      reply = event['text'] as String;
    }
  }
  return reply;
}

/// A Turn asked for by a counterpart, as one exchange: their request, this
/// Bot's addressed answer, and where it stands.
Exchange? inboundExchange(Map<String, dynamic> run) {
  final counterpart = _counterpartOf(run);
  if (counterpart == null) return null;
  final events = (run['events'] as List?) ?? const [];
  final reply = _callerReply(events, counterpart);
  return Exchange(
    id: '${run['runId']}:inbound',
    counterpart: counterpart,
    direction: ExchangeDirection.inbound,
    request: (run['input'] as String?) ?? '',
    reply: reply,
    at: run['messageAdmittedAt'] as String? ?? run['admittedAt'] as String?,
    status: _exchangeStatus(
      answered: reply != null,
      status: run['status'] as String?,
      queued: run['queued'] == true,
    ),
  );
}

/// The Turn's own words and questions, in the order it said them: each
/// `send_to_user` as a line, and each message to another Bot as an exchange
/// line with the answer that came back on its call.
List<TranscriptLine> _spokenLines(
  Map<String, dynamic> run,
  List<Object?> events,
) {
  final runId = run['runId'] as String;
  final at =
      run['messageAdmittedAt'] as String? ?? run['admittedAt'] as String?;
  final results = <String, Map>{};
  for (final event in events) {
    if (event is Map &&
        event['type'] == 'tool/result' &&
        event['callId'] is String) {
      results[event['callId'] as String] = event;
    }
  }
  final lines = <TranscriptLine>[];
  for (final event in events) {
    if (event is! Map) continue;
    if (event['type'] == 'send/to-user') {
      final payload = event['payload'];
      final ordinal = event['ordinal'];
      // The ordinal is the message's durable identity, and the wire gate
      // makes every server that can reach this build emit it. A send without
      // one cannot be read, marked unread, or matched to a notification, so
      // it is dropped rather than given a position that shifts under it.
      if (ordinal is! int || ordinal < 0) continue;
      lines.add(
        TranscriptLine(
          id: '$runId:send:$ordinal',
          runId: runId,
          role: LineRole.assistant,
          text: '',
          at: at,
          readAt: run['admittedAt'] as String?,
          status: LineStatus.completed,
          sends: [
            SendPayloadLine(
              payload is Map && payload['type'] is String
                  ? Map<String, Object?>.from(payload)
                  : null,
            ),
          ],
        ),
      );
    } else if (event['type'] == 'message/to-bot' &&
        event['callId'] is String &&
        event['botId'] is String &&
        event['text'] is String) {
      final callId = event['callId'] as String;
      final result = results[callId];
      final answered = result != null && result['isError'] != true;
      lines.add(
        TranscriptLine(
          id: '$runId:exchange:$callId',
          runId: runId,
          role: LineRole.assistant,
          text: '',
          at: at,
          status: LineStatus.completed,
          exchange: Exchange(
            id: '$runId:exchange:$callId',
            // Named by id alone: the wire does not carry the target's name,
            // and the client's directory does.
            counterpart: ExchangeCounterpart.bot(
              botId: event['botId'] as String,
              name: null,
            ),
            direction: ExchangeDirection.outbound,
            request: event['text'] as String,
            reply: answered ? result['content'] as String? : null,
            at: at,
            status: result == null
                ? _exchangeStatus(
                    answered: false,
                    status: run['status'] as String?,
                    queued: false,
                  )
                : answered
                ? ExchangeStatus.answered
                : ExchangeStatus.failed,
          ),
        ),
      );
    }
  }
  return lines;
}

/// Projects durable runs into the lines the thread draws.
///
/// One line per `send_to_user` in the order the Bot sent them, then the Turn's
/// own closing line under them. A bubble is never edited once it is in the
/// transcript: a later send appends, it does not replace. Retry attempts share
/// one user bubble, whose status comes from the most recent attempt.
///
/// A Turn another party asked for — a Bot, or the voice session — opens with
/// an exchange marker in place of a user bubble: nobody typed it, and the
/// request and its answer are read on the exchange view, not in the thread.
List<TranscriptLine> projectRuns(List<Map<String, dynamic>> runs) {
  final latest = <String, Map<String, dynamic>>{};
  for (final run in runs) {
    final messageId = run['messageRunId'] as String? ?? run['runId'] as String;
    final previous = latest[messageId];
    if (previous == null ||
        run['retryOf'] == previous['runId'] ||
        (run['admittedAt'] as String? ?? '').compareTo(
              previous['admittedAt'] as String? ?? '',
            ) >
            0) {
      latest[messageId] = run;
    }
  }
  final emitted = <String>{};
  final lines = <TranscriptLine>[];
  for (final run in runs) {
    final runId = run['runId'] as String;
    final events = (run['events'] as List?) ?? const [];
    final status = run['status'] as String?;
    final queued = run['queued'] == true;
    final admittedAt =
        run['messageAdmittedAt'] as String? ?? run['admittedAt'] as String?;
    final messageId = run['messageRunId'] as String? ?? runId;
    final inbound = inboundExchange(run);
    // A Routine's Turn is projected with no input at all: nobody typed it. A
    // chat Turn cannot be admitted empty, so an empty input means there is no
    // person's message to draw above the Bot's — not an empty one. A Turn a
    // counterpart asked for has input, but it is theirs, not the person's.
    final input = inbound == null ? (run['input'] as String?) ?? '' : '';
    if (inbound != null) {
      lines.add(
        TranscriptLine(
          id: '$runId:exchange',
          runId: runId,
          role: LineRole.assistant,
          text: '',
          at: admittedAt,
          status: LineStatus.completed,
          exchange: inbound,
        ),
      );
    }
    if (input.isNotEmpty && emitted.add(messageId)) {
      final current = latest[messageId]!;
      final currentId = current['runId'] as String;
      final failed =
          current['status'] == 'failed' && current['retriedBy'] == null;
      final failure = failed
          ? failureNotice((current['outcome'] as Map?)?['message'] as String?)
          : null;
      lines.add(
        TranscriptLine(
          id: '$messageId:user',
          runId: currentId,
          role: LineRole.user,
          text: current['input'] as String? ?? input,
          at: admittedAt,
          readAt: current['admittedAt'] as String?,
          status: failed ? LineStatus.error : LineStatus.completed,
          pending:
              current['status'] == 'running' &&
              (current['queued'] == true || current['retryOf'] != null),
          notice: failure?.notice,
          retry:
              failure?.action == LineRetry.resendTurn &&
                  current['canRetry'] != true
              ? null
              : failure?.action,
          failureMessageId: failed ? '$currentId:failed' : null,
        ),
      );
    }
    final spoken = _spokenLines(run, events);
    lines.addAll(spoken);
    final sends = [for (final line in spoken) ...line.sends];
    final tools = _toolsFrom(events);
    final pluginCalls = _pluginCallsFrom(events);
    // Only explicit sends carry the Bot's voice; outcome text is private.
    const text = '';
    final outcome = run['outcome'] as Map?;
    // Whether the outcome's words have already been said to the person. A
    // firing that broke or was stopped before it could speak is told as an
    // ordinary message, and the cloud projects that message onto the run and
    // makes the outcome say the same words; drawing them again as a notice
    // underneath would be the one event said twice. An exchange's ending is
    // already on its marker, so it is not said under it either.
    final outcomeMessage = outcome?['message'];
    final told =
        inbound != null ||
        outcomeMessage is String &&
            sends.any((send) => send.payload?['text'] == outcomeMessage);
    switch (status) {
      case 'running':
        lines.add(
          TranscriptLine(
            id: '$runId:assistant',
            runId: runId,
            role: LineRole.assistant,
            text: text,
            at: admittedAt,
            readAt: run['admittedAt'] as String?,
            status: LineStatus.streaming,
            // A Turn that has not started shows nothing of its own: the greyed
            // user message is the whole of what the thread says about it. A
            // queued exchange says so on its marker instead, and is not a
            // supersede the thread should report as draining.
            pending: queued && inbound == null,
            stopRequested: run['stopRequestedAt'] != null,
            tools: tools,
            pluginCalls: pluginCalls,
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
            readAt: run['admittedAt'] as String?,
            status: LineStatus.aborted,
            tools: tools,
            pluginCalls: pluginCalls,
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
            readAt: run['admittedAt'] as String?,
            status: LineStatus.aborted,
            notice: told ? null : 'You stopped this.',
            tools: tools,
            pluginCalls: pluginCalls,
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
            // Chat failures live on the input; background failures need a notice.
            text: text,
            at: admittedAt,
            readAt: run['admittedAt'] as String?,
            status: LineStatus.error,
            failureMessageId: run['retriedBy'] != null ? '$runId:failed' : null,
            notice: input.isNotEmpty || told ? null : failure.notice,
            retry:
                input.isNotEmpty ||
                    told ||
                    (failure.action == LineRetry.resendTurn &&
                        run['canRetry'] != true)
                ? null
                : failure.action,
            tools: tools,
            pluginCalls: pluginCalls,
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
            readAt: run['admittedAt'] as String?,
            status: LineStatus.completed,
            tools: tools,
            pluginCalls: pluginCalls,
          ),
        );
    }
  }
  return lines;
}

/// Every exchange between this Bot and one counterpart, oldest first, read
/// off the same runs the thread draws. A Bot's own runs hold both directions
/// of its pairs: what it asked, and what it was asked.
List<Exchange> projectExchanges(
  List<Map<String, dynamic>> runs,
  ExchangeCounterpart counterpart,
) {
  final exchanges = <Exchange>[];
  for (final run in runs) {
    final inbound = inboundExchange(run);
    if (inbound != null && inbound.counterpart.same(counterpart)) {
      exchanges.add(inbound);
    }
    for (final line in _spokenLines(
      run,
      (run['events'] as List?) ?? const [],
    )) {
      final exchange = line.exchange;
      if (exchange != null && exchange.counterpart.same(counterpart)) {
        exchanges.add(exchange);
      }
    }
  }
  // Every exchange of one Turn carries that Turn's admission time, so the
  // sort must not be free to reorder them: they are already appended in the
  // order the Turn made them, and a tie keeps that order.
  final ordered = exchanges.indexed.toList()
    ..sort((a, b) {
      final at = (a.$2.at ?? '').compareTo(b.$2.at ?? '');
      return at != 0 ? at : a.$1.compareTo(b.$1);
    });
  return [for (final entry in ordered) entry.$2];
}

/// When an exchange happened, for the view: the time today, the weekday and
/// time inside the last week, the date and time beyond it.
String formatExchangeTime(String? at, [DateTime? clock]) {
  final message = at == null ? null : DateTime.tryParse(at)?.toLocal();
  if (message == null) return '';
  final now = clock ?? DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final tomorrow = today.add(const Duration(days: 1));
  final hour = message.hour % 12 == 0 ? 12 : message.hour % 12;
  final minute = message.minute.toString().padLeft(2, '0');
  final time = '$hour:$minute ${message.hour < 12 ? 'am' : 'pm'}';
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  if (!message.isBefore(today) && message.isBefore(tomorrow)) {
    return 'Today $time';
  }
  if (!message.isBefore(today.subtract(const Duration(days: 1))) &&
      message.isBefore(today)) {
    return 'Yesterday $time';
  }
  final day = days[message.weekday - 1];
  final date = '${months[message.month - 1]} ${message.day}';
  if (!message.isBefore(today.subtract(const Duration(days: 6))) &&
      message.isBefore(tomorrow)) {
    return '$day $time';
  }
  return message.year == now.year
      ? '$day, $date $time'
      : '$date, ${message.year} $time';
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
