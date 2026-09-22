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
import '../theme/caret.dart';
import '../theme/frock_theme.dart';
import '../voice/dictation.dart';
import '../voice/motion.dart';
import '../voice/protocol.dart';
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
const EdgeInsets composerFieldPadding = EdgeInsets.fromLTRB(16, 12, 4, 12);

/// How far a control inside the field sits from the field's edge — the same
/// number on every side, so a round control is concentric with the round end
/// it sits in.
const double composerControlInset = 4;

/// The painted size of a control inside the field, from the field's own
/// height. The touch target stays the platform minimum: the circle shrinks,
/// the thing a thumb has to hit does not.
double composerControlExtent(double fieldHeight) =>
    fieldHeight - 2 * composerControlInset;

/// The glyph inside one of those controls, at half its circle.
double composerControlIconSize(double extent) => (extent / 2).roundToDouble();

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

/// Shared with the transcript's idle spacer so text scaling reserves the
/// same height that the Stop control takes while a Turn is running.
class ComposerStopButton extends StatelessWidget {
  final bool stopping;
  final VoidCallback? onStop;
  const ComposerStopButton({super.key, this.stopping = false, this.onStop});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Align(
      alignment: Alignment.centerRight,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(0, 0, 16, 6),
        child: identified(
          ShellIds.stopButton,
          OutlinedButton.icon(
            key: onStop == null ? null : const ValueKey('stop'),
            onPressed: stopping || onStop == null
                ? null
                : () {
                    unawaitedHaptic();
                    onStop!();
                  },
            icon: const Icon(Icons.stop_rounded, size: 14),
            label: Text(stopping ? 'Stopping…' : 'Stop'),
            style: OutlinedButton.styleFrom(
              foregroundColor: theme.colorScheme.onSurface,
              minimumSize: const Size(0, 30),
              padding: const EdgeInsets.fromLTRB(10, 0, 12, 0),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              shape: const StadiumBorder(),
              side: BorderSide(color: FrockTheme.hairline(theme.colorScheme)),
              textStyle: theme.textTheme.labelMedium,
              backgroundColor: theme.colorScheme.surface,
            ),
          ),
        ),
      ),
    );
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

  /// Abandons the dictation and takes its words back out of the draft.
  final VoidCallback? onDiscardDictation;

  /// Starts a voice call with this Bot, or moves the open one to it
  /// (ADR 0029).
  ///
  /// Its own control, outside the field and to the right of it: voice is not
  /// a mode of the draft, and a target that moved under the thumb would be
  /// pressed by accident. Absent on a client with no microphone, like
  /// dictation.
  final VoidCallback? onVoice;

  /// Whether a call is still closing: the control is held until it finishes,
  /// because a press now would be refused. Drawn held rather than inviting a
  /// press that goes nowhere.
  final bool voiceClosing;

  /// Whether this Bot is the one on the call. The control stays put and
  /// wears the Bot's primary so the press that started it is still the mark.
  final bool voiceActive;

  /// Whether this composer's Bot is the one being dictated into.
  final DictationState dictationState;
  bool get dictating => dictationState.active;

  /// The capture level, 0..1, which is what the bars are drawn from.
  final ValueListenable<double>? dictationLevel;

  /// How long the capture has been running, drawn as `00:05` on the pill.
  final ValueListenable<Duration>? dictationElapsed;

  /// Whether the draft holds a tidied transcript that can be put back, asked
  /// of the draft as it stands on every build. The offer disappears the moment
  /// they edit inside it, because from then on the words in the field are
  /// partly theirs and swapping them would lose the edit.
  final bool Function()? canRevertDictation;

  /// Puts the raw transcript back. Null leaves the offer off entirely.
  final VoidCallback? onRevertDictation;
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
    this.onDiscardDictation,
    this.onVoice,
    this.voiceClosing = false,
    this.voiceActive = false,
    this.dictationState = DictationState.idle,
    this.dictationLevel,
    this.dictationElapsed,
    this.canRevertDictation,
    this.onRevertDictation,
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

  @override
  void didUpdateWidget(Composer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.dictating && !oldWidget.dictating) widget.focus.unfocus();
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
    _send();
  }

  void _send() {
    if (!widget.dictating &&
        widget.ready &&
        draftSendable(widget.editor.text.trim())) {
      widget.onSend();
    }
  }

  /// The voice control: always this one thing, whatever the draft is doing.
  ///
  /// It does not morph with the action beside it (ADR 0029), so the target
  /// under the thumb never moves. It starts a call with this Bot, and the
  /// same press ends that call. While a previous call is still closing it
  /// is held.
  Widget _voiceButton(BuildContext context, double extent) {
    final theme = Theme.of(context);
    final closing = widget.voiceClosing;
    final active = widget.voiceActive && !closing;
    return identified(
      VoiceIds.composerVoice,
      IconButton(
        key: const ValueKey('composer-voice'),
        tooltip: active ? 'End voice' : 'Talk to this Bot',
        onPressed: closing ? null : widget.onVoice,
        style: IconButton.styleFrom(
          minimumSize: Size.square(extent),
          fixedSize: Size.square(extent),
          padding: EdgeInsets.zero,
          iconSize: composerControlIconSize(extent),
          shape: const CircleBorder(),
          foregroundColor: closing
              ? theme.disabledColor
              : active
              ? theme.colorScheme.primary
              : theme.colorScheme.onSurfaceVariant,
        ),
        icon: const Icon(Icons.graphic_eq_rounded),
      ),
    );
  }

  /// The one action in the field's corner. [dictating] is passed rather than
  /// read, because the draft's own corner keeps the draft's action even while
  /// a capture is standing in front of it.
  Widget _actionButton(
    BuildContext context, {
    required bool dictating,
    required bool dictatable,
    required bool canSend,
    required double extent,
  }) {
    final theme = Theme.of(context);
    return KeyedSubtree(
      key: ValueKey(
        dictating
            ? 'recording-action'
            : dictatable
            ? 'dictate-action'
            : 'send-action',
      ),
      child: dictating
          ? identified(
              VoiceIds.composerDictationStop,
              IconButton.filled(
                key: const ValueKey('dictation-stop'),
                tooltip: widget.dictationState.finishing
                    ? 'Finishing dictation'
                    : 'Stop dictation',
                onPressed: widget.dictationState.finishing
                    ? null
                    : widget.onStopDictation,
                style: IconButton.styleFrom(
                  shape: const CircleBorder(),
                  minimumSize: Size.square(extent),
                  fixedSize: Size.square(extent),
                  padding: EdgeInsets.zero,
                ),
                icon: voiceIconTransition(
                  context,
                  widget.dictationState.finishing
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
                      : Icon(
                          Icons.stop_rounded,
                          key: const ValueKey('recording'),
                          size: composerControlIconSize(extent),
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
                  minimumSize: Size.square(extent),
                  fixedSize: Size.square(extent),
                  padding: EdgeInsets.zero,
                  iconSize: composerControlIconSize(extent),
                  backgroundColor: theme.colorScheme.onSurface.withValues(
                    alpha: 0.08,
                  ),
                  foregroundColor: theme.colorScheme.onSurface,
                  shape: const CircleBorder(),
                ),
                icon: const ChatIcon(ChatIconKind.mic),
              ),
            )
          : identified(
              ShellIds.sendButton,
              IconButton.filled(
                key: const ValueKey('send'),
                tooltip: 'Send',
                onPressed: canSend ? _send : null,
                style: IconButton.styleFrom(
                  minimumSize: Size.square(extent),
                  fixedSize: Size.square(extent),
                  padding: EdgeInsets.zero,
                  iconSize: composerControlIconSize(extent),
                  shape: const CircleBorder(),
                  disabledBackgroundColor: theme.colorScheme.onSurface
                      .withValues(alpha: 0.06),
                  disabledForegroundColor: theme.colorScheme.onSurfaceVariant
                      .withValues(alpha: 0.5),
                ),
                icon: const ChatIcon(ChatIconKind.send),
              ),
            ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = widget.editor.text;
    final canSend =
        !widget.dictating && widget.ready && draftSendable(text.trim());
    final fieldStyle = theme.textTheme.bodyLarge?.copyWith(
      fontWeight: FontWeight.w400,
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
          MediaQuery.textScalerOf(context).scale(fieldStyle?.fontSize ?? 14) *
              (fieldStyle?.height ?? 1.0) +
          theme.visualDensity.baseSizeAdjustment.dy,
    );
    final dictatable = widget.onDictate != null && text.trim().isEmpty;
    final skills = widget.skills;
    final field = _field(
      context,
      oneLine: oneLine,
      dictatable: dictatable,
      canSend: canSend,
    );
    final draft = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (skills != null && skills.open)
          SkillMenu(controller: skills, onChoose: _choose),
        if (skills != null && skills.attached.isNotEmpty)
          identified(
            ShellIds.skillChips,
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
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
          ComposerStopButton(stopping: widget.stopping, onStop: widget.onStop),
        // Said once, quietly, and only while it is still true. Tidying is
        // something done to the person's words without being asked, so the
        // way back has to be visible — but it is not an action anybody came
        // here to take, so it does not get a button's weight.
        if (widget.canRevertDictation?.call() == true &&
            widget.onRevertDictation != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: TextButton.icon(
                key: const ValueKey('dictation-revert'),
                onPressed: widget.onRevertDictation,
                icon: const Icon(Icons.undo_rounded, size: 16),
                label: const Text('Use what I said'),
                style: TextButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  foregroundColor: theme.colorScheme.onSurfaceVariant,
                  textStyle: theme.textTheme.labelMedium,
                ),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                // The draft keeps its place in the layout even while it is
                // covered. A capture is exactly the size of the field it
                // stands in for, so neither the row nor the thread above it
                // moves when one begins or ends.
                child: Stack(
                  children: [
                    Visibility(
                      visible: !widget.dictating,
                      maintainSize: true,
                      maintainAnimation: true,
                      maintainState: true,
                      child: field,
                    ),
                    if (widget.dictating)
                      Positioned.fill(child: _capturePill(context, oneLine)),
                  ],
                ),
              ),
              // Voice, outside the field and never part of it (ADR 0029). It
              // is the same target whatever the draft is doing, so the thumb
              // can find it without looking and the field beside it never
              // changes width under a capture.
              if (widget.onVoice != null)
                SizedBox(
                  height: oneLine,
                  child: Center(
                    child: _voiceButton(
                      context,
                      composerControlExtent(oneLine),
                    ),
                  ),
                ),
            ],
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
    return SafeArea(top: false, child: draft);
  }

  /// The capture in the field's place: the meter, the elapsed time, the way
  /// out, and the way to throw it away.
  ///
  /// The draft is not editable while it runs — there are no captions, and the
  /// words have not landed — so the field is stood in for rather than
  /// disabled in place.
  Widget _capturePill(BuildContext context, double oneLine) {
    final theme = Theme.of(context);
    final extent = composerControlExtent(oneLine);
    Widget corner(Widget button) => SizedBox(
      height: oneLine,
      child: Center(child: button),
    );
    final listening = !widget.dictationState.finishing;
    return Container(
      key: const ValueKey('dictation-pill'),
      decoration: BoxDecoration(
        color: Color.alphaBlend(
          theme.colorScheme.primary.withValues(alpha: 0.07),
          theme.colorScheme.surfaceContainerHighest,
        ),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(
          color: theme.colorScheme.primary.withValues(alpha: 0.5),
        ),
      ),
      child: Row(
        children: [
          // The way out of the capture at one end, the way to keep it at the
          // other, and everything between them is the sound and the clock:
          // the strip runs the width of whatever the row happens to be, so a
          // phone and a desktop both show as much of the capture as they
          // have room for.
          corner(_discardButton(context, extent)),
          _elapsed(context),
          Expanded(
            child: Semantics(
              container: true,
              liveRegion: true,
              label: switch (widget.dictationState) {
                DictationState.starting => 'Starting dictation',
                DictationState.stopping ||
                DictationState.cleaning => 'Finishing dictation',
                _ => 'Listening for dictation',
              },
              child: Center(
                child: SizedBox(
                  key: const ValueKey('dictation-strip'),
                  height: 26,
                  width: double.infinity,
                  child: widget.dictationLevel == null
                      ? const SizedBox.shrink()
                      : identified(
                          VoiceIds.composerDictationLevel,
                          DictationWaveform(
                            level: widget.dictationLevel!,
                            capturing: listening,
                          ),
                        ),
                ),
              ),
            ),
          ),
          corner(
            _actionButton(
              context,
              dictating: true,
              dictatable: false,
              canSend: false,
              extent: extent,
            ),
          ),
        ],
      ),
    );
  }

  /// `00:05`, reserved at a fixed width so the waveform does not jump as
  /// the seconds roll.
  Widget _elapsed(BuildContext context) {
    final theme = Theme.of(context);
    final style = theme.textTheme.labelLarge?.copyWith(
      fontFeatures: const [FontFeature.tabularFigures()],
      fontWeight: FontWeight.w600,
      color: theme.colorScheme.onSurface,
    );
    final listenable = widget.dictationElapsed;
    Widget clock(Duration value) => identified(
      VoiceIds.composerDictationElapsed,
      Text(
        formatDictationElapsedV1(value),
        key: const ValueKey('dictation-elapsed'),
        style: style,
        textAlign: TextAlign.center,
      ),
    );
    return Padding(
      padding: const EdgeInsets.only(left: 4, right: 8),
      child: SizedBox(
        width: MediaQuery.textScalerOf(context).scale(48),
        child: listenable == null
            ? clock(Duration.zero)
            : ValueListenableBuilder<Duration>(
                valueListenable: listenable,
                builder: (context, value, _) => clock(value),
              ),
      ),
    );
  }

  /// The draft itself: the field, and the action in its corner.
  Widget _field(
    BuildContext context, {
    required double oneLine,
    required bool dictatable,
    required bool canSend,
  }) {
    final theme = Theme.of(context);
    final extent = composerControlExtent(oneLine);
    Widget corner(Widget button) => SizedBox(
      height: oneLine,
      child: Center(child: button),
    );
    final fieldStyle = theme.textTheme.bodyLarge?.copyWith(
      fontWeight: FontWeight.w400,
    );
    final skills = widget.skills;
    return AnimatedContainer(
      duration: FrockTheme.motion(context, voiceEnterDuration),
      curve: Curves.easeOutCubic,
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(
          color: widget.focus.hasFocus
              ? Color.alphaBlend(
                  theme.colorScheme.primary.withValues(alpha: 0.55),
                  theme.colorScheme.outlineVariant,
                )
              : FrockTheme.hairline(theme.colorScheme),
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
                    const SingleActivator(LogicalKeyboardKey.enter, meta: true):
                        _send,
                    const SingleActivator(
                      LogicalKeyboardKey.enter,
                      control: true,
                    ): _send,
                    if (enterSends) ...{
                      const SingleActivator(LogicalKeyboardKey.enter): _enter,
                      const SingleActivator(LogicalKeyboardKey.numpadEnter):
                          _enter,
                    },
                    if (skills != null && skills.open) ...{
                      const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
                          skills.move(-1),
                      const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
                          skills.move(1),
                      const SingleActivator(LogicalKeyboardKey.escape):
                          skills.close,
                    },
                  },
                  child: identified(
                    ShellIds.composer,
                    Semantics(
                      label: 'Message your Bot',
                      child: SteadyCaret(
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
                            constraints: BoxConstraints(minHeight: oneLine),
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
              ),
              corner(
                AnimatedSwitcher(
                  duration: FrockTheme.motion(context, FrockTheme.enter),
                  switchInCurve: Curves.easeOutCubic,
                  switchOutCurve: Curves.easeInCubic,
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
                    dictating: false,
                    dictatable: dictatable,
                    canSend: canSend,
                    extent: extent,
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// Throws the capture away: the words it put in the draft go with it, which
  /// is the whole difference between this and the control beside it.
  Widget _discardButton(BuildContext context, double extent) {
    final theme = Theme.of(context);
    return identified(
      VoiceIds.composerDictationDiscard,
      IconButton(
        key: const ValueKey('dictation-discard'),
        tooltip: 'Discard dictation',
        onPressed: widget.onDiscardDictation,
        style: IconButton.styleFrom(
          minimumSize: Size.square(extent),
          fixedSize: Size.square(extent),
          padding: EdgeInsets.zero,
          iconSize: composerControlIconSize(extent),
          shape: const CircleBorder(),
          backgroundColor: theme.colorScheme.onSurface.withValues(alpha: 0.08),
          foregroundColor: theme.colorScheme.onSurfaceVariant,
        ),
        icon: const Icon(Icons.delete_outline_rounded),
      ),
    );
  }
}

void unawaitedHaptic() {
  HapticFeedback.mediumImpact().catchError((Object _) {});
}
