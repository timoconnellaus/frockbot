/// Quick actions on one Bot in the list, without opening it.
///
/// Every action here is a state a Bot already has — read, pinned, muted,
/// labelled, hidden, archived — flipped from the row instead of from the
/// Bot's page. What the sheet offers is decided once, from that state, by
/// [botActionsFor]; the shell decides what each one does.
///
/// A phone reaches them by a long press and by two swipes; a desktop by a
/// secondary click and a control that appears on the row. Delete is not here:
/// it is rare, it destroys, and it stays in the Danger card at the foot of the
/// Bot's Settings.
library;

import 'package:flutter/material.dart';

import '../theme/caret.dart';
import '../theme/dialogs.dart';
import 'semantics.dart';

/// What one Bot row can be asked to do.
enum BotAction {
  markRead,
  markUnread,
  pin,
  unpin,
  mute,
  unmute,
  label,
  hide,
  show,
  archive,
  restore,
}

/// What the row knows about its Bot, which is all the sheet needs.
class BotActionState {
  final bool unread;
  final bool pinned;
  final bool muted;
  final bool hidden;
  final bool archived;

  /// Whether the fan-out has said anything about this Bot yet. A Bot with no
  /// read cursor cannot be marked read — there is nothing to mark up to.
  final bool hasActivity;
  const BotActionState({
    this.unread = false,
    this.pinned = false,
    this.muted = false,
    this.hidden = false,
    this.archived = false,
    this.hasActivity = true,
  });
}

class BotActionItem {
  final BotAction action;
  final String label;
  final IconData icon;

  /// Whether choosing it needs a confirmation before anything is sent.
  final bool confirms;
  const BotActionItem(
    this.action,
    this.label,
    this.icon, {
    this.confirms = false,
  });
}

/// The actions a Bot in [state] offers, in the order they are drawn.
///
/// Each pair is one item whose direction follows the state, so the sheet
/// never offers to pin a pinned Bot. An archived Bot is not read, pinned or
/// labelled from here: it has stopped, and the one thing to do with it is
/// bring it back.
List<BotActionItem> botActionsFor(BotActionState state) {
  if (state.archived) {
    return const [
      BotActionItem(BotAction.restore, 'Restore Bot', Icons.unarchive_outlined),
    ];
  }
  return [
    if (state.unread)
      const BotActionItem(
        BotAction.markRead,
        'Mark as read',
        Icons.mark_chat_read_outlined,
      )
    else if (state.hasActivity)
      const BotActionItem(
        BotAction.markUnread,
        'Mark as unread',
        Icons.mark_chat_unread_outlined,
      ),
    if (state.pinned)
      const BotActionItem(BotAction.unpin, 'Unpin', Icons.push_pin)
    else
      const BotActionItem(BotAction.pin, 'Pin', Icons.push_pin_outlined),
    if (state.muted)
      const BotActionItem(
        BotAction.unmute,
        'Turn notifications on',
        Icons.notifications_outlined,
      )
    else
      const BotActionItem(
        BotAction.mute,
        'Mute notifications',
        Icons.notifications_off_outlined,
      ),
    const BotActionItem(BotAction.label, 'Label…', Icons.label_outline),
    if (state.hidden)
      const BotActionItem(
        BotAction.show,
        'Show in list',
        Icons.visibility_outlined,
      )
    else
      const BotActionItem(
        BotAction.hide,
        'Hide from list',
        Icons.visibility_off_outlined,
      ),
    const BotActionItem(
      BotAction.archive,
      'Archive Bot',
      Icons.archive_outlined,
      confirms: true,
    ),
  ];
}

/// Offers [actions] for [botName]: a sheet from the bottom on touch, the same
/// list at the pointer when [position] is where a secondary click landed.
Future<BotAction?> showBotActions({
  required BuildContext context,
  required String botName,
  required List<BotActionItem> actions,
  Offset? position,
}) {
  if (position != null) {
    final overlay =
        Overlay.of(context).context.findRenderObject()! as RenderBox;
    final point = overlay.globalToLocal(position);
    return showMenu<BotAction>(
      context: context,
      position: RelativeRect.fromRect(
        Rect.fromLTWH(point.dx, point.dy, 0, 0),
        Offset.zero & overlay.size,
      ),
      items: [
        for (final item in actions)
          PopupMenuItem(
            value: item.action,
            child: identified(
              BotActionIds.item(item.action),
              Row(
                children: [
                  Icon(item.icon, size: 20),
                  const SizedBox(width: 12),
                  Flexible(child: Text(item.label)),
                ],
              ),
            ),
          ),
      ],
    );
  }
  return showModalBottomSheet<BotAction>(
    context: context,
    showDragHandle: true,
    // The list is short, but a phone on its side is shorter: it scrolls
    // rather than clips its last action.
    builder: (context) => SafeArea(
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
              child: Text(
                botName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ),
            for (final item in actions)
              identified(
                BotActionIds.item(item.action),
                ListTile(
                  leading: Icon(item.icon),
                  title: Text(item.label),
                  visualDensity: VisualDensity.compact,
                  onTap: () => Navigator.pop(context, item.action),
                ),
              ),
          ],
        ),
      ),
    ),
  );
}

/// Chooses a label for one Bot: one of the labels the list already groups by,
/// a new one, or none. Returns null when nothing was chosen and the empty
/// string for no label, the way the profile stores it.
Future<String?> showBotLabelPicker({
  required BuildContext context,
  required String botName,
  required String current,
  required Iterable<String> existing,
}) {
  final choices = <String>{
    for (final label in existing)
      if (label.trim().isNotEmpty) label.trim(),
  }.toList()..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
  return showDialog<String>(
    context: context,
    builder: (dialog) =>
        _LabelPicker(botName: botName, current: current, choices: choices),
  );
}

class _LabelPicker extends StatefulWidget {
  final String botName;
  final String current;
  final List<String> choices;
  const _LabelPicker({
    required this.botName,
    required this.current,
    required this.choices,
  });

  @override
  State<_LabelPicker> createState() => _LabelPickerState();
}

class _LabelPickerState extends State<_LabelPicker> {
  late final TextEditingController controller = TextEditingController(
    text: widget.current,
  );

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final current = widget.current;
    return AlertDialog(
      insetPadding: frockDialogInset,
      title: frockDialogTitle(Text('Label ${widget.botName}')),
      content: identified(
        BotActionIds.labelPicker,
        frockDialogBody(
          Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (widget.choices.isNotEmpty) ...[
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final label in widget.choices)
                      identified(
                        BotActionIds.labelChoice(label),
                        ChoiceChip(
                          label: Text(label),
                          selected:
                              label.toLowerCase() == current.toLowerCase(),
                          onSelected: (_) => Navigator.pop(context, label),
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 12),
              ],
              SteadyCaret(
                child: TextField(
                  controller: controller,
                  autofocus: widget.choices.isEmpty,
                  maxLength: 120,
                  textInputAction: TextInputAction.done,
                  decoration: const InputDecoration(
                    labelText: 'Label',
                    hintText: 'Work, Home, Projects…',
                    counterText: '',
                  ),
                  onSubmitted: (value) => Navigator.pop(context, value.trim()),
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        if (current.isNotEmpty)
          identified(
            BotActionIds.labelClear,
            TextButton(
              onPressed: () => Navigator.pop(context, ''),
              child: const Text('Remove label'),
            ),
          ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, controller.text.trim()),
          child: const Text('Save'),
        ),
      ],
    );
  }
}
