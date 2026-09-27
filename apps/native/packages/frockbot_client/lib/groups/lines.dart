/// What a Group Chat's thread says in words where nobody said them: the
/// lines for a rename, a member coming or going, a Turn that stopped.
library;

import 'model.dart';

/// "You", or the member who did it.
String groupActorName(String? botId, String Function(String botId) nameOf) =>
    botId == null ? 'You' : nameOf(botId);

/// The line an event is drawn as. [author] is who wrote it: null for the
/// person, a Bot's id otherwise.
String groupEventText(
  GroupEvent event,
  String? author,
  String Function(String botId) nameOf,
) {
  final who = groupActorName(author, nameOf);
  String named(String? botId) => botId == null ? 'a Bot' : nameOf(botId);
  switch (event.type) {
    case 'created':
      final names = [for (final botId in event.members) nameOf(botId)];
      final members = names.length <= 1
          ? names.join()
          : '${names.sublist(0, names.length - 1).join(', ')} & ${names.last}';
      final name = event.name;
      return name == null || name.isEmpty
          ? '$who started the group with $members.'
          : '$who started “$name” with $members.';
    case 'renamed':
      final name = event.name;
      return name == null || name.isEmpty
          ? '$who removed the group’s name.'
          : '$who renamed the group “$name”.';
    case 'member-added':
      return '$who added ${named(event.botId)}.';
    case 'member-removed':
      return author != null && author == event.botId
          ? '${named(event.botId)} left the group.'
          : '$who removed ${named(event.botId)}.';
    case 'archived':
      return '$who archived the group.';
    case 'restored':
      return '$who restored the group.';
    case 'turn-stopped':
      return '${named(event.botId)} stopped.';
    case 'turn-failed':
      return '${named(event.botId)} couldn’t finish its reply.';
    case 'bot-message':
      return '${named(event.botId)} messaged ${named(event.toBotId)}';
  }
  return '';
}

/// What `/stop` in a group's composer asks for: every member, one member by
/// name, or a name that is no member's.
sealed class GroupStopCommand {
  const GroupStopCommand();
}

class GroupStopAll extends GroupStopCommand {
  const GroupStopAll();
}

class GroupStopOne extends GroupStopCommand {
  final String botId;
  const GroupStopOne(this.botId);
}

class GroupStopUnknown extends GroupStopCommand {
  final String name;
  const GroupStopUnknown(this.name);
}

/// Reads `/stop` or `/stop @Name` from a draft, or null when the draft is a
/// message. Names match whole and without regard to case, so a member called
/// "Xero Books" is stopped by `/stop @xero books`.
GroupStopCommand? parseGroupStop(String draft, List<GroupMemberInfo> members) {
  final match = RegExp(
    r'^/stop(?:\s+@?(.+))?$',
    caseSensitive: false,
  ).firstMatch(draft.trim());
  if (match == null) return null;
  final wanted = match.group(1)?.trim();
  if (wanted == null || wanted.isEmpty) return const GroupStopAll();
  for (final member in members) {
    if (member.name.toLowerCase() == wanted.toLowerCase()) {
      return GroupStopOne(member.botId);
    }
  }
  return GroupStopUnknown(wanted);
}

/// The `@` the caret is in, if any: where it starts and what has been typed
/// after it. A mention starts a word, so `name@host` is not one.
({int start, String query})? activeMention(String text, int caret) {
  if (caret < 0 || caret > text.length) return null;
  final before = text.substring(0, caret);
  final at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !RegExp(r'\s').hasMatch(before[at - 1])) return null;
  final query = before.substring(at + 1);
  // A name may have a space in it; a line break or a second @ ends it, and
  // so does a query no longer than any name could be.
  if (query.contains('\n') || query.contains('@') || query.length > 60) {
    return null;
  }
  return (start: at, query: query);
}

/// The members a query names, those whose name starts with it first.
List<GroupMemberInfo> mentionCandidates(
  List<GroupMemberInfo> members,
  String query,
) {
  final wanted = query.toLowerCase();
  final starts = <GroupMemberInfo>[];
  final contains = <GroupMemberInfo>[];
  for (final member in members) {
    final name = member.name.toLowerCase();
    if (name.startsWith(wanted)) {
      starts.add(member);
    } else if (name.contains(wanted)) {
      contains.add(member);
    }
  }
  return [...starts, ...contains];
}
