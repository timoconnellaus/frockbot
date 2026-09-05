import 'dart:convert';

import 'package:flutter/material.dart';

import 'frock_widgets.dart';

/// A receipt is one line of what the Bot did: tile, verb-first sentence, and
/// a mono word at the end (running / done / failed / a count). This maps the
/// wire's run events onto that line without pretending to know more than the
/// event carries.
class Receipt {
  const Receipt({
    required this.icon,
    required this.text,
    this.detail,
    this.time,
    this.tone = TileTone.neutral,
  });
  final IconData icon;
  final String text;
  final String? detail;
  final String? time;
  final TileTone tone;
}

/// Folds a run's events into receipts, in order. Tool results attach to their
/// call; a call with no result yet reads as running.
List<Receipt> receiptsFor(List<dynamic> events) {
  final results = <String, Map<String, dynamic>>{};
  for (final event in events) {
    if (event is Map && event['type'] == 'tool/result') {
      results[event['callId'] as String] = Map<String, dynamic>.from(event);
    }
  }
  final out = <Receipt>[];
  for (final raw in events) {
    if (raw is! Map) continue;
    final event = Map<String, dynamic>.from(raw);
    switch (event['type']) {
      case 'tool/call':
        final call = Map<String, dynamic>.from(event['call'] as Map);
        final input = call['input'] is Map
            ? Map<String, dynamic>.from(call['input'] as Map)
            : null;
        final name = (input?['toolName'] ?? call['name'] ?? '') as String;
        final namespace = input?['namespace'] as String?;
        final result = results[call['id']];
        final failed = result?['isError'] == true;
        final attachments = result?['attachments'];
        final files = attachments is List ? attachments.length : 0;
        out.add(
          Receipt(
            icon: iconForTool(namespace, name),
            text: sentenceForTool(name),
            detail: detailForArguments(input?['argumentsJson'] as String?),
            time: result == null
                ? 'running'
                : failed
                ? 'failed'
                : files > 0
                ? '$files ${files == 1 ? 'file' : 'files'}'
                : 'done',
            tone: result == null
                ? TileTone.accent
                : failed
                ? TileTone.danger
                : TileTone.neutral,
          ),
        );
      case 'task/dispatched':
        out.add(
          Receipt(
            icon: Icons.account_tree_outlined,
            text: event['background'] == true
                ? 'Started a background task'
                : 'Handed off a task',
            detail: event['description'] as String?,
            time: event['model'] as String?,
          ),
        );
      case 'computer/sync':
        out.add(
          Receipt(
            icon: Icons.cloud_off_outlined,
            text: 'Computer sync ${event['status']}',
            detail: event['message'] as String?,
            tone: TileTone.warn,
          ),
        );
      case 'wake/parent':
        out.add(
          Receipt(
            icon: Icons.reply_outlined,
            text: 'Reported back',
            detail: event['message'] as String?,
          ),
        );
      case 'run/events-truncated':
        final n = event['omittedInteractions'];
        out.add(
          Receipt(
            icon: Icons.more_horiz_rounded,
            text: '$n earlier ${n == 1 ? 'step' : 'steps'} not shown',
          ),
        );
    }
  }
  return out;
}

/// "gmail_search_messages" → "Gmail search messages". Tool names are the
/// only vocabulary the wire gives us; the sentence stays honest to them.
String sentenceForTool(String name) {
  final words = name
      .replaceAll(RegExp(r'[._\-/]+'), ' ')
      .replaceAllMapped(RegExp(r'([a-z])([A-Z])'), (m) => '${m[1]} ${m[2]}')
      .trim()
      .toLowerCase();
  if (words.isEmpty) return 'Used a tool';
  return words[0].toUpperCase() + words.substring(1);
}

IconData iconForTool(String? namespace, String name) {
  final key = '${namespace ?? ''} $name'.toLowerCase();
  bool has(String s) => key.contains(s);
  if (has('mail') || has('gmail')) return Icons.mail_outline_rounded;
  if (has('calendar') || has('event')) return Icons.event_outlined;
  if (has('search') || has('web') || has('fetch')) return Icons.search_rounded;
  if (has('sheet') || has('table') || has('csv')) {
    return Icons.table_chart_outlined;
  }
  if (has('exec') || has('shell') || has('command') || has('computer')) {
    return Icons.terminal_rounded;
  }
  if (has('write') || has('draft') || has('edit') || has('create')) {
    return Icons.edit_outlined;
  }
  if (has('read') || has('file') || has('doc') || has('note')) {
    return Icons.description_outlined;
  }
  if (has('memory') || has('remember') || has('recall')) {
    return Icons.bookmark_border_rounded;
  }
  if (has('task') || has('routine') || has('schedule')) {
    return Icons.schedule_outlined;
  }
  if (has('send') || has('message') || has('slack') || has('chat')) {
    return Icons.send_outlined;
  }
  return Icons.build_outlined;
}

/// The first short string in the arguments, quoted, so a search reads as
/// `Searched · “Thursday numbers”`. Anything long or structured is left out.
String? detailForArguments(String? argumentsJson) {
  if (argumentsJson == null || argumentsJson.isEmpty) return null;
  Object? parsed;
  try {
    parsed = jsonDecode(argumentsJson);
  } catch (_) {
    return null;
  }
  if (parsed is! Map) return null;
  for (final value in parsed.values) {
    if (value is String) {
      final text = value.replaceAll(RegExp(r'\s+'), ' ').trim();
      if (text.isEmpty) continue;
      return text.length > 40 ? '“${text.substring(0, 39)}…”' : '“$text”';
    }
  }
  return null;
}
