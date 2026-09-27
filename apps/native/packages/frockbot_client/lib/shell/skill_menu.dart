/// The composer's Skill-invocation menu.
///
/// A person invokes a Skill with `/` or `@`. Choosing one does *not* paste its
/// text into the message: it attaches a ref, and the backend expands the body
/// it resolves at the exact generation the Turn loads. That distinction is the
/// whole point — a pasted body is a message the person could edit into
/// something the Skill never said, while a ref is a name the Bot resolves.
///
/// The ranking, the keyboard model and the three-chip bound are kept free of
/// any widget, so they are testable without a frame.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../client/transport.dart';
import 'semantics.dart';

/// The most Skills one Turn may carry, matching the send route's decoder.
const int maxInvokedSkills = 3;

/// `/stop`: the running reply, stopped from the composer.
const stopCommandName = 'stop';

/// Something the composer does itself. Its name is typed after `/` like a
/// Skill's, but it is never attached and never reaches the Bot.
class ComposerCommand {
  final String name;
  final String description;
  final IconData icon;
  const ComposerCommand(this.name, this.description, this.icon);
}

const stopComposerCommand = ComposerCommand(
  stopCommandName,
  'Stop the current reply',
  Icons.stop_circle_outlined,
);

/// One invocable Skill, as a client sees it. It carries a name, a description
/// and a ref — never a body.
class SkillCatalogEntry {
  final String ref;
  final Map<String, Object?> skill;
  final String name;
  final String description;
  final String path;
  const SkillCatalogEntry({
    required this.ref,
    required this.skill,
    required this.name,
    required this.description,
    required this.path,
  });

  static SkillCatalogEntry? decode(Object? value) {
    if (value is! Map) return null;
    final ref = value['ref'];
    final skill = value['skill'];
    if (ref is! String || skill is! Map) return null;
    return SkillCatalogEntry(
      ref: ref,
      skill: Map<String, Object?>.from(skill),
      name: '${value['name'] ?? ref}',
      description: '${value['description'] ?? ''}',
      path: '${value['path'] ?? ''}',
    );
  }
}

/// The open popover: which trigger opened it, and what has been typed since.
class SkillPopover {
  final String trigger;

  /// Index in the text where the trigger character sits.
  final int at;
  final String query;
  const SkillPopover(this.trigger, this.at, this.query);
}

class SkillCandidate {
  final SkillCatalogEntry entry;

  /// Lower sorts first. Exposed so a test can assert the ordering's reason.
  final int rank;
  const SkillCandidate(this.entry, this.rank);
}

const int _noMatch = 1 << 30;

final RegExp _whitespace = RegExp(r'\s');

/// How far back a trigger may be from the caret. A Skill's name is a word, so
/// nothing further back than a long one can be the query being typed — and the
/// scan runs on every edit of a draft that may be the length of a whole Turn.
const int _skillTriggerReach = 128;

int _matchScore(SkillCatalogEntry entry, String query) {
  // 0 is "no query": everything matches and the catalog's own order stands.
  if (query.isEmpty) return 0;
  final needle = query.toLowerCase();
  final slug = '${entry.skill['slug'] ?? ''}'.toLowerCase();
  final name = entry.name.toLowerCase();
  final description = entry.description.toLowerCase();
  if (slug == needle || name == needle) return 1;
  if (slug.startsWith(needle) || name.startsWith(needle)) return 2;
  if (slug.contains(needle) || name.contains(needle)) return 3;
  if (description.contains(needle)) return 4;
  return _noMatch;
}

/// The candidates a query offers, best first.
///
/// Ties break on the canonical ref rather than on catalog order, so the list a
/// person navigates with the arrow keys does not reshuffle when the backend
/// enumerates the instruction root in a different order.
List<SkillCandidate> rankSkillCandidates(
  List<SkillCatalogEntry> catalog,
  String query, {
  List<String> exclude = const [],
}) {
  final excluded = exclude.toSet();
  final candidates = [
    for (final entry in catalog)
      if (!excluded.contains(entry.ref))
        SkillCandidate(entry, _matchScore(entry, query)),
  ]..removeWhere((candidate) => candidate.rank == _noMatch);
  candidates.sort(
    (left, right) => left.rank != right.rank
        ? left.rank - right.rank
        : left.entry.ref.compareTo(right.entry.ref),
  );
  return candidates;
}

/// Reads the open popover out of the composer's text and caret.
///
/// A trigger opens the popover only at the start of the message or after
/// whitespace, so an email address or a path in prose does not turn into a
/// Skill picker, and any whitespace after the trigger closes it again.
SkillPopover? skillPopoverFor(String text, int caret) {
  final position = caret.clamp(0, text.length);
  // A trigger is a word away at most, so a run of anything longer than a word
  // is not one — and this is read on every edit, including a draft the length
  // of the whole Turn limit.
  final floor = position - _skillTriggerReach < 0
      ? 0
      : position - _skillTriggerReach;
  for (var index = position - 1; index >= floor; index -= 1) {
    final character = text[index];
    if (_whitespace.hasMatch(character)) return null;
    if (character == '/' || character == '@') {
      final before = index == 0 ? '' : text[index - 1];
      if (before.isNotEmpty && !_whitespace.hasMatch(before)) return null;
      return SkillPopover(
        character,
        index,
        text.substring(index + 1, position),
      );
    }
  }
  return null;
}

/// The text after a selection: the trigger and its query are removed.
({String text, int caret}) textWithoutSkillTrigger(
  String text,
  SkillPopover popover,
  int caret,
) {
  final end = caret.clamp(popover.at, text.length);
  return (
    text: text.substring(0, popover.at) + text.substring(end),
    caret: popover.at,
  );
}

/// The highlight to keep once the candidate list has been recomputed.
///
/// Carried by ref rather than by index: the Skill under it keeps its place for
/// as long as the query still offers it, and only a Skill that has dropped out
/// of the list hands the highlight back to the first row.
int keptSkillHighlight(
  String? highlightedRef,
  List<SkillCandidate> candidates,
) {
  if (candidates.isEmpty) return 0;
  final index = candidates.indexWhere(
    (candidate) => candidate.entry.ref == highlightedRef,
  );
  return index == -1 ? 0 : index;
}

/// Moves the popover's highlight, wrapping at both ends.
int nextSkillHighlight(int highlighted, int count, int direction) {
  if (count <= 0) return 0;
  return (highlighted + direction + count) % count;
}

/// The attached refs, bounded and ordered.
///
/// `attach`, `detach` and `take` are the only ways the list changes, so the
/// composer can never submit more refs than the decoder admits, and can never
/// submit the same one twice.
class SkillAttachmentStore {
  List<SkillCatalogEntry> _attached = const [];

  List<SkillCatalogEntry> get attached => List.unmodifiable(_attached);
  List<Map<String, Object?>> get refs => [
    for (final entry in _attached) entry.skill,
  ];
  bool get full => _attached.length >= maxInvokedSkills;

  /// True when the entry was attached; false when it was full or a duplicate.
  bool attach(SkillCatalogEntry entry) {
    if (full) return false;
    if (_attached.any((existing) => existing.ref == entry.ref)) return false;
    _attached = [..._attached, entry];
    return true;
  }

  void detach(String ref) {
    _attached = [
      for (final entry in _attached)
        if (entry.ref != ref) entry,
    ];
  }

  /// Empties the store and hands back what it held, for one submission.
  List<Map<String, Object?>> take() {
    final taken = refs;
    _attached = const [];
    return taken;
  }

  /// Puts a rejected submission's entries back, so nothing is lost on failure.
  void restore(List<SkillCatalogEntry> entries) {
    _attached = entries.take(maxInvokedSkills).toList();
  }
}

/// The popover's state and the catalog behind it.
class SkillMenuController extends ChangeNotifier {
  final NativeApi api;
  final String botId;
  final SkillAttachmentStore attachments = SkillAttachmentStore();
  List<SkillCatalogEntry> catalog = const [];
  SkillPopover? popover;
  List<SkillCandidate> candidates = const [];

  /// The commands the composer can run right now, and the ones the open
  /// popover offers. They are listed ahead of the Skills.
  List<ComposerCommand> commands = const [];
  List<ComposerCommand> commandCandidates = const [];

  /// Across the commands and then the Skills, in the order they are drawn.
  int highlighted = 0;
  bool _disposed = false;
  SkillMenuController({required this.api, required this.botId});

  bool get open =>
      popover != null &&
      (candidates.isNotEmpty || commandCandidates.isNotEmpty);

  int get optionCount => commandCandidates.length + candidates.length;

  ComposerCommand? get highlightedCommand =>
      highlighted < commandCandidates.length
      ? commandCandidates[highlighted]
      : null;

  SkillCandidate? get highlightedSkill {
    final index = highlighted - commandCandidates.length;
    return index >= 0 && index < candidates.length ? candidates[index] : null;
  }

  List<ComposerCommand> _commandsFor(SkillPopover? popover) {
    if (popover == null || popover.trigger != '/') return const [];
    final query = popover.query.toLowerCase();
    return [
      for (final command in commands)
        if (command.name.startsWith(query)) command,
    ];
  }

  /// What the composer can run now. Set as it builds, so it never notifies:
  /// the composer is already drawing the answer.
  void offerCommands(List<ComposerCommand> next) {
    commands = next;
    commandCandidates = _commandsFor(popover);
    if (highlighted >= optionCount) highlighted = 0;
  }

  List<SkillCatalogEntry> get attached => attachments.attached;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  /// A deployment with no Skills route, or one that cannot be read, is a
  /// composer with no popover rather than a broken one.
  Future<void> load() async {
    try {
      final answer = await api.request(
        '/api/bots/${Uri.encodeComponent(botId)}/skills',
      );
      if (answer is! Map) return;
      catalog = [
        for (final entry in (answer['skills'] as List? ?? const []))
          ?SkillCatalogEntry.decode(entry),
      ];
      _changed();
    } catch (_) {
      catalog = const [];
    }
  }

  /// Re-reads the trigger out of the composer's text.
  ///
  /// Silent when nothing about the popover changed. This is called on every
  /// edit of the draft, and a listener that fired anyway would rebuild the
  /// composer a second time for every keystroke that has nothing to do with a
  /// Skill — which is most of them.
  void readFrom(String text, int caret) {
    final next = skillPopoverFor(text, caret < 0 ? text.length : caret);
    final previous = highlightedSkill?.entry.ref;
    popover = next;
    commandCandidates = _commandsFor(next);
    if (next == null) {
      candidates = const [];
      _changed();
      return;
    }
    candidates = rankSkillCandidates(
      catalog,
      next.query,
      exclude: [for (final entry in attached) entry.ref],
    );
    highlighted = commandCandidates.isNotEmpty
        ? 0
        : keptSkillHighlight(previous, candidates);
    _changed();
  }

  void move(int direction) {
    highlighted = nextSkillHighlight(highlighted, optionCount, direction);
    _changed();
  }

  void close() {
    popover = null;
    candidates = const [];
    commandCandidates = const [];
    _changed();
  }

  /// Takes the typed `/command` back out of the composer's text, and answers
  /// with what is left, or null when the popover has already closed.
  ({String text, int caret})? takeTrigger(String text, int caret) {
    final current = popover;
    if (current == null) return null;
    final replaced = textWithoutSkillTrigger(
      text,
      current,
      caret < 0 ? text.length : caret,
    );
    close();
    return replaced;
  }

  /// Attaches [entry] and answers with the composer text the trigger left
  /// behind, or null when the popover has already closed.
  ({String text, int caret})? attachFromComposer(
    String text,
    int caret,
    SkillCatalogEntry entry,
  ) {
    final current = popover;
    if (current == null) return null;
    attachments.attach(entry);
    final replaced = textWithoutSkillTrigger(
      text,
      current,
      caret < 0 ? text.length : caret,
    );
    close();
    return replaced;
  }

  void detach(String ref) {
    attachments.detach(ref);
    _changed();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

class SkillMenu extends StatelessWidget {
  final SkillMenuController controller;
  final void Function(SkillCandidate candidate) onChoose;
  final void Function(ComposerCommand command)? onCommand;
  const SkillMenu({
    super.key,
    required this.controller,
    required this.onChoose,
    this.onCommand,
  });

  static double _maxHeight(BuildContext context) {
    final room =
        MediaQuery.sizeOf(context).height -
        MediaQuery.viewInsetsOf(context).bottom -
        MediaQuery.paddingOf(context).vertical;
    return math.min(240, math.max(96, room * 0.3));
  }

  Widget _section(ThemeData theme, String label) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 8, 16, 2),
    child: Text(
      label,
      style: theme.textTheme.labelSmall?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
        letterSpacing: 0.3,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return identified(
      ShellIds.skillMenu,
      Container(
        margin: const EdgeInsets.fromLTRB(12, 0, 12, 4),
        // A share of the room above the keyboard, never more than a short
        // list: at large text on a phone a fixed height pushed the draft
        // and the `/stop` row it is about off the screen.
        constraints: BoxConstraints(maxHeight: _maxHeight(context)),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest,
          border: Border.all(color: theme.colorScheme.outlineVariant),
          borderRadius: BorderRadius.circular(12),
        ),
        // The rows are `ListTile`s, which paint their selection and their ink
        // on the nearest Material: without one of their own that is the
        // surface behind the popover, and the box's own colour hides both.
        child: Material(
          type: MaterialType.transparency,
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.symmetric(vertical: 4),
            children: [
              if (controller.commandCandidates.isNotEmpty) ...[
                _section(theme, 'Commands'),
                for (final (index, command)
                    in controller.commandCandidates.indexed)
                  ListTile(
                    key: ValueKey('command:${command.name}'),
                    dense: true,
                    selected: index == controller.highlighted,
                    leading: Icon(command.icon, size: 20),
                    minLeadingWidth: 20,
                    title: Text('/${command.name}'),
                    subtitle: Text(command.description),
                    onTap: () => onCommand?.call(command),
                  ),
                if (controller.candidates.isNotEmpty) _section(theme, 'Skills'),
              ],
              for (final (index, candidate) in controller.candidates.indexed)
                _skillRow(theme, candidate, index),
            ],
          ),
        ),
      ),
    );
  }

  Widget _skillRow(ThemeData theme, SkillCandidate candidate, int index) =>
      identified(
        ShellIds.skillOption(candidate.entry.ref),
        ListTile(
          dense: true,
          selected:
              index + controller.commandCandidates.length ==
              controller.highlighted,
          title: Text(candidate.entry.name),
          subtitle: candidate.entry.description.isEmpty
              ? null
              : Text(
                  candidate.entry.description,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
          trailing: Text(candidate.entry.ref, style: theme.textTheme.bodySmall),
          onTap: () => onChoose(candidate),
        ),
      );
}
