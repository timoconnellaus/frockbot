import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import 'model.dart';

/// The Group Chat routes, each answer validated against the wire schema
/// before anything reads it. Commands are validated on the way out too, so a
/// client bug is a local error rather than a refusal from the server.
class GroupChatApi {
  final NativeApi api;
  const GroupChatApi(this.api);

  Future<List<GroupRecord>> list() async {
    final json =
        wire.GroupChatList.fromJson(await api.request('/api/groups')).toJson()
            as Map;
    return [
      for (final group in json['groups'] as List) GroupRecord.fromJson(group),
    ];
  }

  /// Starts a group. The id comes from the command id, so sending the same
  /// command again is the same group.
  Future<GroupRecord> create({
    required String commandId,
    required List<String> members,
    String? name,
  }) async {
    final receipt = await _command('/api/groups', {
      'type': 'group/create',
      'commandId': commandId,
      'members': members,
      'name': ?name,
    });
    return receipt!;
  }

  Future<GroupRecord?> command(String groupId, Map<String, Object?> command) =>
      _command('/api/groups/$groupId/commands', {
        ...command,
        'groupId': groupId,
      });

  Future<GroupRecord?> _command(String path, Map<String, Object?> body) async {
    wire.GroupChatCommand.fromJson(body);
    final json =
        wire.GroupChatReceipt.fromJson(await api.request(path, body: body))
                .toJson()
            as Map;
    final group = json['group'];
    return group == null ? null : GroupRecord.fromJson(group);
  }

  Future<GroupView> view(String groupId) async =>
      GroupView.fromJson(await api.request('/api/groups/$groupId'));

  /// The newest page, or the one before or after a position.
  Future<GroupPage> page(
    String groupId, {
    int? before,
    int? after,
    int limit = 50,
  }) async {
    final query = [
      if (before != null) 'before=$before',
      if (after != null) 'after=$after',
      'limit=$limit',
    ].join('&');
    return GroupPage.fromJson(
      await api.request('/api/groups/$groupId/messages?$query'),
    );
  }

  Future<GroupMessage> post(
    String groupId, {
    required String commandId,
    required String text,
  }) async {
    final body = {'schemaVersion': 1, 'commandId': commandId, 'text': text};
    wire.GroupPostCommand.fromJson(body);
    final json =
        wire.GroupPostReceipt.fromJson(
              await api.request('/api/groups/$groupId/messages', body: body),
            ).toJson()
            as Map;
    return GroupMessage.fromJson(json['message']);
  }

  Future<int> read(String groupId, int upTo) async {
    final body = {'schemaVersion': 1, 'upTo': upTo};
    wire.GroupReadCommand.fromJson(body);
    final json =
        wire.GroupReadReceipt.fromJson(
              await api.request('/api/groups/$groupId/read', body: body),
            ).toJson()
            as Map;
    return (json['readThrough'] as num).toInt();
  }

  /// Stops every member Turn running for this group, or one member's.
  Future<List<String>> stop(
    String groupId, {
    required String commandId,
    String? botId,
  }) async {
    final body = {'schemaVersion': 1, 'commandId': commandId, 'botId': ?botId};
    wire.GroupStopCommand.fromJson(body);
    final json =
        wire.GroupStopReceipt.fromJson(
              await api.request('/api/groups/$groupId/stop', body: body),
            ).toJson()
            as Map;
    return List<String>.from(json['stopped'] as List);
  }

  /// Runs a member again for the message its failed Turn was answering.
  Future<void> retry(
    String groupId, {
    required String commandId,
    required String botId,
    required String runId,
  }) async {
    final body = {
      'schemaVersion': 1,
      'commandId': commandId,
      'botId': botId,
      'runId': runId,
    };
    wire.GroupRetryCommand.fromJson(body);
    wire.GroupRetryReceipt.fromJson(
      await api.request('/api/groups/$groupId/retry', body: body),
    );
  }
}
