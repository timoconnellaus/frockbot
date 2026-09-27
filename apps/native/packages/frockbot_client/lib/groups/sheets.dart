/// Making a Group Chat and changing one: who is in it, what it is called,
/// and whether it is kept.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/semantics.dart';
import '../theme/caret.dart';
import '../theme/dialogs.dart';
import 'directory.dart';
import 'faces.dart';
import 'model.dart';

/// Fewest and most Bots a group holds.
const groupMinMembers = 2;
const groupMaxMembers = 8;

/// The longest name a group takes.
const groupNameMaxCharacters = 80;

/// Chooses the Bots for a new group and, if the person likes, its name.
/// Answers with the group made, or null.
class CreateGroupSheet extends StatefulWidget {
  final GroupDirectoryController directory;

  /// The Bots a group can be made of: every Bot that is not archived.
  final List<GroupFace> bots;

  /// Chosen already, as when the sheet opens from one Bot's actions.
  final Set<String> initial;
  const CreateGroupSheet({
    super.key,
    required this.directory,
    required this.bots,
    this.initial = const {},
  });

  static Future<GroupRecord?> show(
    BuildContext context, {
    required GroupDirectoryController directory,
    required List<GroupFace> bots,
    Set<String> initial = const {},
  }) => showModalBottomSheet<GroupRecord>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheet) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(sheet).bottom),
      child: CreateGroupSheet(
        directory: directory,
        bots: bots,
        initial: initial,
      ),
    ),
  );

  @override
  State<CreateGroupSheet> createState() => _CreateGroupSheetState();
}

class _CreateGroupSheetState extends State<CreateGroupSheet> {
  final name = TextEditingController();
  late final Set<String> chosen = {...widget.initial};
  bool creating = false;
  String? error;

  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  bool get _ready =>
      chosen.length >= groupMinMembers && chosen.length <= groupMaxMembers;

  Future<void> _create() async {
    if (!_ready || creating) return;
    setState(() {
      creating = true;
      error = null;
    });
    try {
      final trimmed = name.text.trim();
      // In the order the list shows them, which is the order the group's
      // name is spelled in until someone names it.
      final members = [
        for (final bot in widget.bots)
          if (chosen.contains(bot.botId)) bot.botId,
      ];
      final made = await widget.directory.create(
        members,
        name: trimmed.isEmpty ? null : trimmed,
      );
      if (mounted) Navigator.pop(context, made);
    } catch (failure) {
      if (mounted) {
        setState(() {
          creating = false;
          error = failure is RequestFailure
              ? failure.message
              : 'Couldn’t create the group. Please try again.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final count = chosen.length;
    final hint = count < groupMinMembers
        ? 'Choose at least $groupMinMembers Bots.'
        : count > groupMaxMembers
        ? 'A group holds up to $groupMaxMembers Bots.'
        : '$count Bots';
    return identified(
      GroupIds.createSheet,
      SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.85,
            maxWidth: 560,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 4),
                child: Text(
                  'New Group Chat',
                  style: theme.textTheme.titleLarge,
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 12),
                child: Text(
                  'Every Bot in the group reads every message, and the ones '
                  'with something to add reply.',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                child: identified(
                  GroupIds.createName,
                  SteadyCaret(
                    child: TextField(
                      controller: name,
                      maxLength: groupNameMaxCharacters,
                      textInputAction: TextInputAction.done,
                      decoration: const InputDecoration(
                        labelText: 'Name (optional)',
                        hintText: 'Named after its members until you name it',
                        counterText: '',
                      ),
                    ),
                  ),
                ),
              ),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (final bot in widget.bots)
                      identified(
                        GroupIds.createMember(bot.botId),
                        CheckboxListTile(
                          value: chosen.contains(bot.botId),
                          onChanged: creating
                              ? null
                              : (value) => setState(() {
                                  if (value == true) {
                                    chosen.add(bot.botId);
                                  } else {
                                    chosen.remove(bot.botId);
                                  }
                                }),
                          secondary: GroupAvatars(faces: [bot], size: 32),
                          title: Text(bot.name),
                          controlAffinity: ListTileControlAffinity.trailing,
                        ),
                      ),
                  ],
                ),
              ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 8, 24, 0),
                  child: Text(
                    error!,
                    style: TextStyle(color: theme.colorScheme.error),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        hint,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    identified(
                      GroupIds.createConfirm,
                      FilledButton(
                        onPressed: _ready && !creating
                            ? () => unawaited(_create())
                            : null,
                        child: Text(creating ? 'Creating…' : 'Create'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Who is in a group and what it is called, with the ways to change either,
/// and to archive or delete it.
class GroupMembersSheet extends StatefulWidget {
  final GroupDirectoryController directory;
  final String groupId;

  /// Every Bot a group can hold, for the faces and for adding one.
  final List<GroupFace> bots;
  final GroupFace? Function(String botId) faceOf;
  final String Function(GroupRecord group) nameOf;

  /// The group is gone: the shell closes it.
  final VoidCallback onDeleted;
  const GroupMembersSheet({
    super.key,
    required this.directory,
    required this.groupId,
    required this.bots,
    required this.faceOf,
    required this.nameOf,
    required this.onDeleted,
  });

  static Future<void> show(
    BuildContext context, {
    required GroupDirectoryController directory,
    required String groupId,
    required List<GroupFace> bots,
    required GroupFace? Function(String botId) faceOf,
    required String Function(GroupRecord group) nameOf,
    required VoidCallback onDeleted,
  }) => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheet) => GroupMembersSheet(
      directory: directory,
      groupId: groupId,
      bots: bots,
      faceOf: faceOf,
      nameOf: nameOf,
      onDeleted: onDeleted,
    ),
  );

  @override
  State<GroupMembersSheet> createState() => _GroupMembersSheetState();
}

class _GroupMembersSheetState extends State<GroupMembersSheet> {
  bool adding = false;
  bool busy = false;
  String? error;

  @override
  void initState() {
    super.initState();
    widget.directory.addListener(_changed);
  }

  @override
  void dispose() {
    widget.directory.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _run(Future<void> Function() command) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await command();
    } catch (failure) {
      error = failure is RequestFailure
          ? failure.message
          : 'That didn’t work. Please try again.';
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _rename(GroupRecord group) async {
    final chosen = await showDialog<String>(
      context: context,
      builder: (dialog) => _RenameDialog(current: group.name ?? ''),
    );
    if (chosen == null || !mounted) return;
    final trimmed = chosen.trim();
    if (trimmed == (group.name ?? '')) return;
    await _run(
      () => widget.directory.rename(
        widget.groupId,
        trimmed.isEmpty ? null : trimmed,
      ),
    );
  }

  Future<void> _delete(GroupRecord group) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        insetPadding: frockDialogInset,
        title: frockDialogTitle(Text('Delete ${widget.nameOf(group)}?')),
        content: frockDialogBody(
          const Text(
            'The thread and everything the group remembers are deleted for '
            'good. The Bots themselves are not touched.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog, false),
            child: const Text('Cancel'),
          ),
          identified(
            GroupIds.deleteConfirm,
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: Theme.of(dialog).colorScheme.error,
                foregroundColor: Theme.of(dialog).colorScheme.onError,
              ),
              onPressed: () => Navigator.pop(dialog, true),
              child: const Text('Delete'),
            ),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _run(() => widget.directory.delete(widget.groupId));
    if (!mounted || error != null) return;
    Navigator.pop(context);
    widget.onDeleted();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final group = widget.directory.byId(widget.groupId);
    if (group == null) return const SizedBox(height: 120);
    final members = group.members;
    final outside = [
      for (final bot in widget.bots)
        if (!members.contains(bot.botId)) bot,
    ];
    GroupFace face(String botId) =>
        widget.faceOf(botId) ??
        GroupFace(botId: botId, name: 'A Bot', characterId: '');
    return identified(
      GroupIds.members,
      SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.85,
          ),
          child: ListView(
            shrinkWrap: true,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                child: Row(
                  children: [
                    GroupAvatars(
                      faces: [for (final botId in members) face(botId)],
                      size: 36,
                      ring: theme.colorScheme.surfaceContainerLow,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        widget.nameOf(group),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.titleMedium,
                      ),
                    ),
                  ],
                ),
              ),
              identified(
                GroupIds.rename,
                ListTile(
                  leading: const Icon(Icons.edit_outlined),
                  title: Text(group.name == null ? 'Name the group' : 'Rename'),
                  enabled: !busy && !group.archived,
                  onTap: () => unawaited(_rename(group)),
                ),
              ),
              const Divider(height: 16),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 4, 24, 4),
                child: Text(
                  '${members.length} MEMBERS',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              for (final botId in members)
                identified(
                  GroupIds.member(botId),
                  ListTile(
                    leading: GroupAvatars(faces: [face(botId)], size: 32),
                    title: Text(face(botId).name),
                    trailing: identified(
                      GroupIds.removeMember(botId),
                      IconButton(
                        tooltip: members.length <= groupMinMembers
                            ? 'A group needs at least $groupMinMembers Bots'
                            : 'Remove ${face(botId).name}',
                        onPressed:
                            busy ||
                                group.archived ||
                                members.length <= groupMinMembers
                            ? null
                            : () => unawaited(
                                _run(
                                  () => widget.directory.removeMember(
                                    widget.groupId,
                                    botId,
                                  ),
                                ),
                              ),
                        icon: const Icon(Icons.remove_circle_outline),
                      ),
                    ),
                  ),
                ),
              if (!group.archived && members.length < groupMaxMembers)
                identified(
                  GroupIds.addMember,
                  ListTile(
                    leading: const Icon(Icons.person_add_alt_outlined),
                    title: const Text('Add a Bot'),
                    enabled: !busy && outside.isNotEmpty,
                    trailing: Icon(
                      adding ? Icons.expand_less : Icons.expand_more,
                    ),
                    onTap: () => setState(() => adding = !adding),
                  ),
                ),
              if (adding && !group.archived)
                for (final bot in outside)
                  identified(
                    GroupIds.addCandidate(bot.botId),
                    ListTile(
                      contentPadding: const EdgeInsets.only(
                        left: 40,
                        right: 24,
                      ),
                      leading: GroupAvatars(faces: [bot], size: 28),
                      title: Text(bot.name),
                      enabled: !busy,
                      onTap: () => unawaited(
                        _run(
                          () => widget.directory.addMember(
                            widget.groupId,
                            bot.botId,
                          ),
                        ),
                      ),
                    ),
                  ),
              const Divider(height: 16),
              if (group.archived)
                identified(
                  GroupIds.restore,
                  ListTile(
                    leading: const Icon(Icons.unarchive_outlined),
                    title: const Text('Restore group'),
                    enabled: !busy,
                    onTap: () => unawaited(
                      _run(() => widget.directory.restore(widget.groupId)),
                    ),
                  ),
                )
              else
                identified(
                  GroupIds.archive,
                  ListTile(
                    leading: const Icon(Icons.archive_outlined),
                    title: const Text('Archive group'),
                    subtitle: const Text(
                      'Its Bots stop replying here until you restore it.',
                    ),
                    enabled: !busy,
                    onTap: () => unawaited(
                      _run(() => widget.directory.archive(widget.groupId)),
                    ),
                  ),
                ),
              identified(
                GroupIds.delete,
                ListTile(
                  leading: Icon(
                    Icons.delete_outline,
                    color: theme.colorScheme.error,
                  ),
                  title: Text(
                    'Delete group',
                    style: TextStyle(color: theme.colorScheme.error),
                  ),
                  enabled: !busy,
                  onTap: () => unawaited(_delete(group)),
                ),
              ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
                  child: Text(
                    error!,
                    style: TextStyle(color: theme.colorScheme.error),
                  ),
                ),
              const SizedBox(height: 12),
            ],
          ),
        ),
      ),
    );
  }
}

class _RenameDialog extends StatefulWidget {
  final String current;
  const _RenameDialog({required this.current});

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final controller = TextEditingController(text: widget.current);

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    insetPadding: frockDialogInset,
    title: frockDialogTitle(const Text('Name the group')),
    content: frockDialogBody(
      identified(
        GroupIds.renameField,
        SteadyCaret(
          child: TextField(
            controller: controller,
            autofocus: true,
            maxLength: groupNameMaxCharacters,
            textInputAction: TextInputAction.done,
            decoration: const InputDecoration(
              labelText: 'Name',
              hintText: 'Leave empty to name it after its members',
              counterText: '',
            ),
            onSubmitted: (value) => Navigator.pop(context, value),
          ),
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      identified(
        GroupIds.renameSave,
        FilledButton(
          onPressed: () => Navigator.pop(context, controller.text),
          child: const Text('Save'),
        ),
      ),
    ],
  );
}
