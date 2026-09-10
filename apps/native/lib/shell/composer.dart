/// The composer: the draft, what makes Send available, and the size rule.
///
/// The draft, send readiness and the turn limit are three separate rules, and
/// deliberately so. A draft belongs to the Bot it was typed for and survives a
/// refused send. "Can this client send at all" and "is there something worth
/// sending" are different questions, and folding them into one predicate is
/// what disabled Try again for the exact case it exists for.
library;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../acceptance_metrics.dart';
import '../voice/footer.dart' show VoiceDictationBars;
import 'semantics.dart';
import 'chat_icons.dart';
import 'skill_menu.dart';

/// The composer's copy of the send route's size rule.
///
/// The gateway refuses an oversized Turn with 413 before it reaches a Bot. A
/// refusal the person could have seen coming is a bad refusal, so the composer
/// enforces the same number and the server's rule stays the authority for
/// anything that reaches it another way.
const int turnTextMaxCharacters = 32000;

/// Where the counter appears. A character count beside a half-written sentence
/// is noise; it is only news as the budget runs out.
const int turnTextCounterFrom = 28800;

int turnTextRemaining(String text) => turnTextMaxCharacters - text.length;
bool turnTextTooLong(String text) => turnTextRemaining(text) < 0;
bool turnTextCounterVisible(String text) => text.length >= turnTextCounterFrom;

/// Whether this client could start a Turn, whatever the text turns out to be.
bool sendReady({
  required String connection,
  required bool modelReady,
  String? activeBotId,
}) =>
    connection == 'ready' &&
    modelReady &&
    activeBotId != null &&
    activeBotId.isNotEmpty;

/// Whether the draft is something the send route would accept.
bool draftSendable(String text) => text.isNotEmpty && !turnTextTooLong(text);

/// One submission in flight, and the draft generation it displaced.
class ComposerSubmission {
  final int generation;
  final Object context;
  final String text;
  const ComposerSubmission(this.generation, this.context, this.text);
}

/// Drafts, one per Bot, and what happens to a submission that is refused.
///
/// A refused submission goes back into the draft it came out of — not into
/// whichever Bot is open by then — and never over a newer submission for the
/// same Bot, which is what the generation counts.
class ComposerDraftStore {
  final Map<Object, String> _drafts = {};
  final Map<Object, int> _generations = {};

  String draftFor(Object context) => _drafts[context] ?? '';

  void setDraft(Object context, String draft) => _drafts[context] = draft;

  ComposerSubmission begin(Object context, String text) {
    final generation = (_generations[context] ?? 0) + 1;
    _generations[context] = generation;
    _drafts[context] = '';
    return ComposerSubmission(generation, context, text);
  }

  /// Restores a refused submission, and answers with the draft it restored, or
  /// null when a newer submission for the same Bot has superseded it.
  String? reject(ComposerSubmission token) {
    if (_generations[token.context] != token.generation) return null;
    final existing = draftFor(token.context);
    final restored = existing.isEmpty
        ? token.text
        : '${token.text}\n\n$existing';
    _drafts[token.context] = restored;
    return restored;
  }
}

/// The composer row: the field, the Skill popover above it, the attached Skill
/// chips, the counter as the budget runs out, Stop and Send.
class Composer extends StatefulWidget {
  final TextEditingController editor;
  final FocusNode focus;

  /// Whether this client could start a Turn at all, ignoring the draft.
  final bool ready;
  final bool stoppable;
  final bool stopping;
  final Future<void> Function() onSend;
  final Future<void> Function() onStop;
  final void Function(String text) onChanged;

  /// Absent where no catalog has been read — a composer with no popover
  /// rather than a broken one.
  final SkillMenuController? skills;

  /// Starts dictating into this composer. Absent on a client that has no
  /// microphone at all; the button is shown whenever it is present, even on a
  /// deployment without the keys, which answers the press in one line.
  final VoidCallback? onDictate;

  /// Commits the dictation into the editable draft. It never sends.
  final VoidCallback? onStopDictation;

  /// Whether this composer's Bot is the one being dictated into.
  final bool dictating;

  /// The capture level, 0..1, which is what the bars are drawn from.
  final ValueListenable<double>? dictationLevel;
  const Composer({
    super.key,
    required this.editor,
    required this.focus,
    required this.ready,
    required this.stoppable,
    required this.stopping,
    required this.onSend,
    required this.onStop,
    required this.onChanged,
    required this.skills,
    this.onDictate,
    this.onStopDictation,
    this.dictating = false,
    this.dictationLevel,
  });

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  @override
  void initState() {
    super.initState();
    widget.skills?.addListener(_changed);
    widget.focus.addListener(_changed);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.skills?.removeListener(_changed);
    widget.focus.removeListener(_changed);
    super.dispose();
  }

  void _refreshPopover() {
    widget.skills?.readFrom(
      widget.editor.text,
      widget.editor.selection.baseOffset,
    );
  }

  void _choose(SkillCandidate candidate) {
    final replaced = widget.skills?.attachFromComposer(
      widget.editor.text,
      widget.editor.selection.baseOffset,
      candidate.entry,
    );
    if (replaced == null) return;
    widget.editor.value = TextEditingValue(
      text: replaced.text,
      selection: TextSelection.collapsed(offset: replaced.caret),
    );
    widget.onChanged(replaced.text);
    // The rewrite came from Dart, so no `onChanged` will follow it: the
    // popover's view of the text is brought up to date here, or the next
    // trigger is matched against the message this one was taken out of.
    _refreshPopover();
    widget.focus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = widget.editor.text;
    final canSend = widget.ready && draftSendable(text.trim());
    final dictatable = widget.onDictate != null && text.trim().isEmpty;
    final skills = widget.skills;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (skills != null && skills.open)
          SkillMenu(controller: skills, onChoose: _choose),
        if (skills != null && skills.attached.isNotEmpty)
          identified(
            ShellIds.skillChips,
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final entry in skills.attached)
                    identified(
                      ShellIds.skillChip(entry.ref),
                      InputChip(
                        label: Text(entry.name),
                        onDeleted: () => skills.detach(entry.ref),
                      ),
                    ),
                ],
              ),
            ),
          ),
        if (widget.stoppable)
          Align(
            alignment: Alignment.centerRight,
            child: Padding(
              padding: const EdgeInsets.only(right: 12),
              child: identified(
                ShellIds.stopButton,
                TextButton.icon(
                  key: const ValueKey('stop'),
                  onPressed: widget.stopping
                      ? null
                      : () {
                          unawaitedHaptic();
                          widget.onStop();
                        },
                  icon: const Icon(Icons.stop_rounded, size: 14),
                  label: Text(widget.stopping ? 'Stopping…' : 'Stop'),
                  style: TextButton.styleFrom(
                    foregroundColor: theme.colorScheme.onSurfaceVariant,
                    textStyle: theme.textTheme.bodySmall,
                  ),
                ),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 4, 14, 10),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(19),
              border: Border.all(
                color: widget.focus.hasFocus
                    ? Color.alphaBlend(
                        theme.colorScheme.primary.withValues(alpha: 0.4),
                        theme.colorScheme.outlineVariant,
                      )
                    : theme.colorScheme.outlineVariant,
              ),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: CallbackShortcuts(
                    bindings: {
                      const SingleActivator(
                        LogicalKeyboardKey.enter,
                        meta: true,
                      ): widget.onSend,
                      const SingleActivator(
                        LogicalKeyboardKey.enter,
                        control: true,
                      ): widget.onSend,
                      if (skills != null && skills.open) ...{
                        const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
                            skills.move(-1),
                        const SingleActivator(
                          LogicalKeyboardKey.arrowDown,
                        ): () =>
                            skills.move(1),
                        const SingleActivator(LogicalKeyboardKey.escape):
                            skills.close,
                      },
                    },
                    child: identified(
                      ShellIds.composer,
                      Semantics(
                        label: 'Message your Bot',
                        child: TextField(
                          key: const ValueKey('composer'),
                          controller: widget.editor,
                          focusNode: widget.focus,
                          style: theme.textTheme.bodyLarge?.copyWith(
                            fontWeight: FontWeight.w300,
                          ),
                          minLines: 1,
                          maxLines: 6,
                          keyboardType: TextInputType.multiline,
                          textInputAction: TextInputAction.newline,
                          decoration: InputDecoration(
                            hintText: 'Message your Bot',
                            filled: false,
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            contentPadding: const EdgeInsets.fromLTRB(
                              15,
                              14,
                              4,
                              14,
                            ),
                            counterText: '',
                          ),
                          onChanged: (value) {
                            AcceptanceMetrics.instance.inputChanged();
                            widget.onChanged(value);
                            _refreshPopover();
                            setState(() {});
                          },
                        ),
                      ),
                    ),
                  ),
                ),
                // Dictating: what the person needs is the level and a way to
                // stop, so the bars and Stop take the corner. Nothing here
                // sends — Stop flushes into the draft and Send stays theirs.
                if (widget.dictating) ...[
                  if (widget.dictationLevel case final level?)
                    VoiceDictationBars(level: level),
                  identified(
                    VoiceIds.composerDictationStop,
                    Padding(
                      padding: const EdgeInsets.all(3),
                      child: IconButton.filledTonal(
                        key: const ValueKey('dictation-stop'),
                        tooltip: 'Stop dictation',
                        onPressed: widget.onStopDictation,
                        style: IconButton.styleFrom(
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(11),
                          ),
                        ),
                        icon: const Icon(Icons.stop_rounded, size: 20),
                      ),
                    ),
                  ),
                ]
                // An empty draft has nothing to send, so the corner offers
                // the other way to fill it.
                else if (dictatable)
                  identified(
                    VoiceIds.composerDictate,
                    Padding(
                      padding: const EdgeInsets.all(3),
                      child: IconButton.filled(
                        key: const ValueKey('dictate'),
                        tooltip: 'Dictate message',
                        onPressed: widget.onDictate,
                        style: IconButton.styleFrom(
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(11),
                          ),
                        ),
                        icon: const Icon(Icons.mic_none, size: 20),
                      ),
                    ),
                  )
                else
                  identified(
                    ShellIds.sendButton,
                    Padding(
                      padding: const EdgeInsets.all(3),
                      child: IconButton.filled(
                        key: const ValueKey('send'),
                        tooltip: 'Send',
                        onPressed: canSend ? widget.onSend : null,
                        style: IconButton.styleFrom(
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(11),
                          ),
                        ),
                        icon: const ChatIcon(ChatIconKind.send),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
        if (turnTextCounterVisible(text))
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(
              '${turnTextRemaining(text)} characters left',
              style: theme.textTheme.bodySmall?.copyWith(
                color: turnTextTooLong(text) ? theme.colorScheme.error : null,
              ),
            ),
          ),
      ],
    );
  }
}

void unawaitedHaptic() {
  HapticFeedback.mediumImpact().catchError((Object _) {});
}
