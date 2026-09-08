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

import 'package:flutter/material.dart';

import '../client/transport.dart';
import 'semantics.dart';

/// The most Skills one Turn may carry, matching the send route's decoder.
const int maxInvokedSkills = 3;

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
  int highlighted = 0;
  bool _disposed = false;
  SkillMenuController({required this.api, required this.botId});

  bool get open => popover != null && candidates.isNotEmpty;
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
    popover = next;
    if (next == null) {
      if (candidates.isEmpty) return;
      candidates = const [];
      _changed();
      return;
    }
    final previous = highlighted < candidates.length
        ? candidates[highlighted].entry.ref
        : null;
    candidates = rankSkillCandidates(
      catalog,
      next.query,
      exclude: [for (final entry in attached) entry.ref],
    );
    highlighted = keptSkillHighlight(previous, candidates);
    _changed();
  }

  void move(int direction) {
    highlighted = nextSkillHighlight(highlighted, candidates.length, direction);
    _changed();
  }

  void close() {
    popover = null;
    candidates = const [];
    _changed();
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
  const SkillMenu({
    super.key,
    required this.controller,
    required this.onChoose,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return identified(
      ShellIds.skillMenu,
      Container(
        margin: const EdgeInsets.fromLTRB(12, 0, 12, 4),
        constraints: const BoxConstraints(maxHeight: 240),
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
          child: ListView.builder(
            shrinkWrap: true,
            padding: const EdgeInsets.symmetric(vertical: 4),
            itemCount: controller.candidates.length,
            itemBuilder: (context, index) {
              final candidate = controller.candidates[index];
              return identified(
                ShellIds.skillOption(candidate.entry.ref),
                ListTile(
                  dense: true,
                  selected: index == controller.highlighted,
                  title: Text(candidate.entry.name),
                  subtitle: candidate.entry.description.isEmpty
                      ? null
                      : Text(
                          candidate.entry.description,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                  trailing: Text(
                    candidate.entry.ref,
                    style: theme.textTheme.bodySmall,
                  ),
                  onTap: () => onChoose(candidate),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}
