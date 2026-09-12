/// The composer: the draft, what makes Send available, and the size rule.
///
/// The draft, send readiness and the turn limit are three separate rules, and
/// deliberately so. A draft belongs to the Bot it was typed for and survives a
/// refused send. "Can this client send at all" and "is there something worth
/// sending" are different questions, and folding them into one predicate is
/// what disabled Try again for the exact case it exists for.
library;

import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../acceptance_metrics.dart';
import '../orientation.dart' show isNativeMobile;
import '../theme/frock_theme.dart';
import '../voice/dictation.dart';
import '../voice/motion.dart';
import '../voice/waveform.dart';
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

/// Whether a bare Enter sends. Where there is a keyboard with a Shift key,
/// Enter is Send and Shift+Enter is the line break. A phone's soft keyboard
/// has no such pair, so there Enter keeps breaking the line and Send stays the
/// button; Cmd+Enter and Ctrl+Enter send everywhere.
bool get enterSends => !isNativeMobile;

/// The field's vertical inset, in one place because the corner button is
/// centred against the one-line field this produces.
const EdgeInsets composerFieldPadding = EdgeInsets.fromLTRB(15, 14, 4, 14);

/// An [AnimatedSwitcher] layout where the outgoing child is only a picture:
/// it stays visible for the cross-fade but cannot be pressed, and a screen
/// reader is not read the label it is leaving behind on top of the new one.
Widget _quietOutgoing(Widget? currentChild, List<Widget> previousChildren) =>
    Stack(
      alignment: Alignment.center,
      children: [
        for (final child in previousChildren)
          ExcludeSemantics(child: IgnorePointer(child: child)),
        ?currentChild,
      ],
    );

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
  final DictationState dictationState;
  bool get dictating => dictationState.active;

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
    this.dictationState = DictationState.idle,
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

  void _enter() {
    final skills = widget.skills;
    if (skills != null && skills.open) {
      if (skills.highlighted < skills.candidates.length) {
        _choose(skills.candidates[skills.highlighted]);
      }
      return;
    }
    if (!widget.dictating &&
        widget.ready &&
        draftSendable(widget.editor.text.trim())) {
      widget.onSend();
    }
  }

  Widget _actionButton(
    BuildContext context, {
    required bool dictatable,
    required bool canSend,
  }) => KeyedSubtree(
    key: ValueKey(
      widget.dictating
          ? 'recording-action'
          : dictatable
          ? 'dictate-action'
          : 'send-action',
    ),
    child: widget.dictating
        ? identified(
            VoiceIds.composerDictationStop,
            IconButton.filled(
              key: const ValueKey('dictation-stop'),
              tooltip: widget.dictationState == DictationState.stopping
                  ? 'Finishing dictation'
                  : 'Stop dictation',
              onPressed: widget.dictationState == DictationState.stopping
                  ? null
                  : widget.onStopDictation,
              style: IconButton.styleFrom(
                shape: const CircleBorder(),
                minimumSize: const Size(48, 48),
              ),
              icon: voiceIconTransition(
                context,
                widget.dictationState == DictationState.stopping
                    ? SizedBox(
                        key: const ValueKey('finishing'),
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          value: MediaQuery.disableAnimationsOf(context)
                              ? 0.75
                              : null,
                        ),
                      )
                    : const Icon(
                        Icons.stop_rounded,
                        key: ValueKey('recording'),
                        size: 24,
                      ),
              ),
            ),
          )
        : dictatable
        ? identified(
            VoiceIds.composerDictate,
            IconButton.filled(
              key: const ValueKey('dictate'),
              tooltip: 'Dictate message',
              onPressed: widget.onDictate,
              style: IconButton.styleFrom(
                minimumSize: const Size(48, 48),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
              ),
              icon: const ChatIcon(ChatIconKind.mic),
            ),
          )
        : identified(
            ShellIds.sendButton,
            IconButton.filled(
              key: const ValueKey('send'),
              tooltip: 'Send',
              onPressed: canSend ? widget.onSend : null,
              style: IconButton.styleFrom(
                minimumSize: const Size(48, 48),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
              ),
              icon: const ChatIcon(ChatIconKind.send),
            ),
          ),
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = widget.editor.text;
    final canSend =
        !widget.dictating && widget.ready && draftSendable(text.trim());
    final fieldStyle = theme.textTheme.bodyLarge?.copyWith(
      fontWeight: FontWeight.w300,
    );
    // The height of the field with one line in it, as the decorator sizes
    // it: the inset around one line, adjusted for the theme's density and
    // never under the interactive minimum. The corner button is centred
    // against this, so on a one-line draft it sits level with the text, and
    // as the draft grows the row's end alignment keeps it in the bottom
    // corner beside the last line.
    final oneLine = math.max(
      kMinInteractiveDimension,
      composerFieldPadding.vertical +
          MediaQuery.textScalerOf(context).scale(fieldStyle?.fontSize ?? 15) *
              (fieldStyle?.height ?? 1.0) +
          theme.visualDensity.baseSizeAdjustment.dy,
    );
    Widget corner(Widget button) => Padding(
      padding: const EdgeInsets.symmetric(horizontal: 3),
      child: SizedBox(
        height: oneLine,
        child: Center(child: button),
      ),
    );
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
          child: AnimatedContainer(
            duration: FrockTheme.motion(context, voiceEnterDuration),
            curve: Curves.easeOutCubic,
            decoration: BoxDecoration(
              color: Color.alphaBlend(
                theme.colorScheme.primary.withValues(
                  alpha: widget.dictating ? 0.07 : 0,
                ),
                theme.colorScheme.surfaceContainerHighest,
              ),
              borderRadius: BorderRadius.circular(19),
              border: Border.all(
                color: widget.dictating || widget.focus.hasFocus
                    ? Color.alphaBlend(
                        theme.colorScheme.primary.withValues(alpha: 0.4),
                        theme.colorScheme.outlineVariant,
                      )
                    : theme.colorScheme.outlineVariant,
              ),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: CallbackShortcuts(
                        bindings: {
                          const SingleActivator(
                            LogicalKeyboardKey.enter,
                            meta: true,
                          ): () {
                            if (canSend) widget.onSend();
                          },
                          const SingleActivator(
                            LogicalKeyboardKey.enter,
                            control: true,
                          ): () {
                            if (canSend) widget.onSend();
                          },
                          // A bare Enter (Shift+Enter is left to the field, which
                          // breaks the line) sends, or takes the highlighted Skill
                          // while the popover is up. An empty or oversized draft
                          // swallows it rather than growing by a blank line.
                          if (enterSends) ...{
                            const SingleActivator(LogicalKeyboardKey.enter):
                                _enter,
                            const SingleActivator(
                              LogicalKeyboardKey.numpadEnter,
                            ): _enter,
                          },
                          if (skills != null && skills.open) ...{
                            const SingleActivator(
                              LogicalKeyboardKey.arrowUp,
                            ): () =>
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
                              style: fieldStyle,
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
                                contentPadding: composerFieldPadding,
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
                    corner(
                      AnimatedSwitcher(
                        duration: FrockTheme.motion(context, FrockTheme.enter),
                        switchInCurve: Curves.easeOutCubic,
                        switchOutCurve: Curves.easeInCubic,
                        // Outgoing controls remain visible, but cannot be pressed
                        // or announced after the current action has changed.
                        layoutBuilder: _quietOutgoing,
                        transitionBuilder: (child, animation) => FadeTransition(
                          opacity: animation,
                          child: ScaleTransition(
                            scale: Tween<double>(
                              begin: 0.8,
                              end: 1,
                            ).animate(animation),
                            child: child,
                          ),
                        ),
                        child: _actionButton(
                          context,
                          dictatable: dictatable,
                          canSend: canSend,
                        ),
                      ),
                    ),
                  ],
                ),
                VoiceReveal(
                  visible: widget.dictating,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(18, 0, 18, 10),
                    child: Row(
                      children: [
                        Flexible(
                          child: Semantics(
                            liveRegion: true,
                            child: AnimatedSwitcher(
                              duration: FrockTheme.motion(
                                context,
                                FrockTheme.fast,
                              ),
                              layoutBuilder: _quietOutgoing,
                              child: Text(
                                switch (widget.dictationState) {
                                  DictationState.starting => 'Starting…',
                                  DictationState.stopping => 'Finishing…',
                                  _ => 'Listening',
                                },
                                key: ValueKey(widget.dictationState),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.labelMedium?.copyWith(
                                  color: theme.brightness == Brightness.dark
                                      ? FrockTheme.accentSoft
                                      : theme.colorScheme.primary,
                                ),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 20),
                        Expanded(
                          flex: 2,
                          child: SizedBox(
                            height: 44,
                            child: widget.dictationLevel != null
                                ? identified(
                                    VoiceIds.composerDictationLevel,
                                    VoiceWaveform(
                                      source: widget.dictationLevel!,
                                      microphone: () =>
                                          widget.dictationLevel!.value,
                                      enabled:
                                          widget.dictationState ==
                                          DictationState.capturing,
                                    ),
                                  )
                                : const SizedBox.shrink(),
                          ),
                        ),
                      ],
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
