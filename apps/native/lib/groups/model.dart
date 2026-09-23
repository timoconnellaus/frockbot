import '../protocol/client_wire.generated.dart' as wire;

/// A Group Chat as the User's list holds it: who is in it, what it is called
/// and where it sits in the sidebar. Every value here was validated against
/// the wire schema before it was read.
class GroupRecord {
  final String groupId;
  final String? name;
  final List<String> members;
  final String createdAt;
  final String updatedAt;
  final String? archivedAt;
  final String? label;
  final String? pinnedAt;
  final num? sidebarOrder;
  final bool hidden;

  const GroupRecord({
    required this.groupId,
    this.name,
    required this.members,
    required this.createdAt,
    required this.updatedAt,
    this.archivedAt,
    this.label,
    this.pinnedAt,
    this.sidebarOrder,
    this.hidden = false,
  });

  bool get archived => archivedAt != null;

  static GroupRecord fromJson(Object? value) {
    final json = wire.GroupChatRecord.fromJson(value).toJson() as Map;
    return GroupRecord(
      groupId: json['groupId'] as String,
      name: json['name'] as String?,
      members: List<String>.unmodifiable(json['members'] as List),
      createdAt: json['createdAt'] as String,
      updatedAt: json['updatedAt'] as String,
      archivedAt: json['archivedAt'] as String?,
      label: json['label'] as String?,
      pinnedAt: json['pinnedAt'] as String?,
      sidebarOrder: json['sidebarOrder'] as num?,
      hidden: json['hiddenFromSidebar'] == true,
    );
  }

  /// This group with an arrangement change applied, as the server will
  /// apply it: a pin is stamped now, and an empty label clears the label.
  GroupRecord arranged({
    String? label,
    bool clearLabel = false,
    bool? pinned,
    num? sidebarOrder,
    bool clearOrder = false,
    bool? hidden,
    String? now,
  }) => GroupRecord(
    groupId: groupId,
    name: name,
    members: members,
    createdAt: createdAt,
    updatedAt: updatedAt,
    archivedAt: archivedAt,
    label: clearLabel ? null : (label ?? this.label),
    pinnedAt: pinned == null
        ? pinnedAt
        : pinned
        ? (pinnedAt ?? now ?? DateTime.now().toUtc().toIso8601String())
        : null,
    sidebarOrder: clearOrder ? null : (sidebarOrder ?? this.sidebarOrder),
    hidden: hidden ?? this.hidden,
  );
}

class GroupMemberInfo {
  final String botId;
  final String name;
  final String? description;
  const GroupMemberInfo(this.botId, this.name, {this.description});
}

/// What an open group shows before its thread: its members by name, how far
/// the thread goes, how far the person has read, and who is working now.
class GroupView {
  final GroupRecord group;
  final List<GroupMemberInfo> members;
  final int head;
  final int readThrough;
  final int unread;
  final List<String> working;

  const GroupView({
    required this.group,
    required this.members,
    required this.head,
    required this.readThrough,
    required this.unread,
    required this.working,
  });

  static GroupView fromJson(Object? value) {
    final json = wire.GroupChatView.fromJson(value).toJson() as Map;
    return GroupView(
      group: GroupRecord.fromJson(json['group']),
      members: [
        for (final member in json['members'] as List)
          GroupMemberInfo(
            (member as Map)['botId'] as String,
            member['name'] as String,
            description: member['description'] as String?,
          ),
      ],
      head: (json['head'] as num).toInt(),
      readThrough: (json['readThrough'] as num).toInt(),
      unread: (json['unread'] as num).toInt(),
      working: List<String>.unmodifiable(json['working'] as List),
    );
  }

  String nameOf(String botId) {
    for (final member in members) {
      if (member.botId == botId) return member.name;
    }
    return botId;
  }
}

/// `@Name` in a message, resolved to the member it names when it was posted.
class GroupMention {
  final String botId;
  final int start;
  final int end;
  const GroupMention(this.botId, this.start, this.end);
}

sealed class GroupBody {
  const GroupBody();
}

class GroupText extends GroupBody {
  final String text;
  final List<GroupMention> mentions;

  /// A member called the person with `@User`; they were notified.
  final bool mentionsUser;
  const GroupText(this.text, this.mentions, {this.mentionsUser = false});
}

/// A line in the thread that nobody said: a rename, a member joining, a
/// member's Turn that stopped or failed, a question put to a Bot outside.
class GroupEvent extends GroupBody {
  final String type;
  final String? botId;
  final String? toBotId;
  final String? runId;
  final String? callId;
  final String? name;
  final List<String> members;
  const GroupEvent(
    this.type, {
    this.botId,
    this.toBotId,
    this.runId,
    this.callId,
    this.name,
    this.members = const [],
  });

  /// Whether the group itself — its name or its members — changed, so what
  /// the client holds about the group has to be read again.
  bool get changesGroup => const {
    'created',
    'renamed',
    'member-added',
    'member-removed',
    'archived',
    'restored',
  }.contains(type);
}

class GroupMessage {
  final int seq;
  final String messageId;
  final String at;

  /// The member who wrote it, or null for the person.
  final String? botId;
  final GroupBody body;

  const GroupMessage({
    required this.seq,
    required this.messageId,
    required this.at,
    required this.botId,
    required this.body,
  });

  bool get fromUser => botId == null;

  static GroupMessage fromJson(Object? value) {
    final json = wire.GroupMessage.fromJson(value).toJson() as Map;
    final author = json['author'] as Map;
    final body = json['body'] as Map;
    return GroupMessage(
      seq: (json['seq'] as num).toInt(),
      messageId: json['messageId'] as String,
      at: json['at'] as String,
      botId: author['kind'] == 'bot' ? author['botId'] as String : null,
      body: switch (body['kind']) {
        'text' => GroupText(body['text'] as String, [
          for (final mention in body['mentions'] as List)
            GroupMention(
              (mention as Map)['botId'] as String,
              (mention['start'] as num).toInt(),
              (mention['end'] as num).toInt(),
            ),
        ], mentionsUser: body['mentionsUser'] == true),
        _ => _event(body['event'] as Map),
      },
    );
  }

  static GroupEvent _event(Map event) => GroupEvent(
    event['type'] as String,
    botId: event['botId'] as String?,
    toBotId: event['toBotId'] as String?,
    runId: event['runId'] as String?,
    callId: event['callId'] as String?,
    name: event['name'] as String?,
    members: [...?(event['members'] as List?)?.cast<String>()],
  );
}

class GroupPage {
  final List<GroupMessage> messages;
  final bool hasMore;
  const GroupPage(this.messages, this.hasMore);

  static GroupPage fromJson(Object? value) {
    final json = wire.GroupMessagePage.fromJson(value).toJson() as Map;
    return GroupPage([
      for (final message in json['messages'] as List)
        GroupMessage.fromJson(message),
    ], json['hasMore'] as bool);
  }
}

/// What the group's channel says on connect and on every change.
class GroupState {
  final int head;
  final int readThrough;
  final List<String> working;
  const GroupState(this.head, this.readThrough, this.working);

  static GroupState fromJson(Object? value) {
    final json = wire.GroupStateFrame.fromJson(value).toJson() as Map;
    return GroupState(
      (json['head'] as num).toInt(),
      (json['readThrough'] as num).toInt(),
      List<String>.unmodifiable(json['working'] as List),
    );
  }
}

/// "General, Xero Books & Codex": what an unnamed group is called, exactly as
/// the server names it in a notification.
String groupDisplayName(GroupRecord group, String Function(String) nameOf) {
  final name = group.name;
  if (name != null && name.isNotEmpty) return name;
  final names = [for (final botId in group.members) nameOf(botId)];
  if (names.length <= 1) return names.join();
  return '${names.sublist(0, names.length - 1).join(', ')} & ${names.last}';
}
