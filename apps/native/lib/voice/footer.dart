/// Account-wide voice controls, below the app's navigation and conversations.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shell/semantics.dart';
import '../flock/avatar.dart';
import '../theme/frock_theme.dart';
import 'assistant.dart';
import 'motion.dart';
import 'protocol.dart';
import 'waveform.dart';

const double voiceFooterHeight = 96;
const double voiceFooterStageMaxWidth = 420;
const double voiceFooterStageInset = 24;
const double voiceFooterControlsWidth = 144;
const Key voiceFooterAnimationKey = ValueKey('voice-footer-animation');

class VoiceFooter extends StatefulWidget {
  final AssistantSessionController session;
  final VoidCallback onEnd;
  final ({String characterId, String primary})? Function(String botId)?
  botAppearance;
  const VoiceFooter({
    super.key,
    required this.session,
    required this.onEnd,
    this.botAppearance,
  });

  @override
  State<VoiceFooter> createState() => _VoiceFooterState();
}

class _VoiceFooterState extends State<VoiceFooter> {
  late (
    bool,
    String?,
    String?,
    VoiceSessionPhase,
    String?,
    VoiceDelegationStateV1?,
  )
  _presentation;

  @override
  void initState() {
    super.initState();
    _presentation = _readPresentation();
    widget.session.addListener(_changed);
  }

  (bool, String?, String?, VoiceSessionPhase, String?, VoiceDelegationStateV1?)
  _readPresentation() => (
    widget.session.muted,
    widget.session.error,
    widget.session.notice,
    widget.session.phase,
    widget.session.delegatedBotId,
    widget.session.delegationState,
  );

  void _changed() {
    final next = _readPresentation();
    if (_presentation == next) return;
    setState(() => _presentation = next);
  }

  @override
  void didUpdateWidget(VoiceFooter oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.session != widget.session) {
      oldWidget.session.removeListener(_changed);
      widget.session.addListener(_changed);
      _presentation = _readPresentation();
    }
  }

  @override
  void dispose() {
    widget.session.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final session = widget.session;
    final failure = session.error;
    // A failure ends the call and takes the stage for good; a notice borrows
    // it for a few seconds while the call goes on, controls and all.
    final text = failure ?? session.notice;
    return identified(
      VoiceIds.footer,
      Material(
        color: theme.colorScheme.primary,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        clipBehavior: Clip.antiAlias,
        child: SafeArea(
          top: false,
          child: SizedBox(
            height: voiceFooterHeight,
            child: Stack(
              children: [
                Positioned.fill(
                  child: text == null
                      ? _stage()
                      : Padding(
                          padding: const EdgeInsets.fromLTRB(24, 16, 96, 16),
                          child: Center(
                            child: Semantics(
                              liveRegion: true,
                              child: Text(
                                text,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: Colors.white,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                          ),
                        ),
                ),
                Align(
                  alignment: Alignment.centerRight,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (failure == null) ...[
                        identified(
                          VoiceIds.mute,
                          Semantics(
                            toggled: session.muted,
                            child: _circle(
                              label: session.muted
                                  ? 'Unmute microphone'
                                  : 'Mute microphone',
                              selected: session.muted,
                              onPressed: () =>
                                  session.setMuted(!session.userMuted),
                              icon: session.muted ? Icons.mic_off : Icons.mic,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                      ],
                      identified(
                        VoiceIds.end,
                        _circle(
                          label: 'End voice session',
                          onPressed: widget.onEnd,
                          icon: Icons.close,
                        ),
                      ),
                      const SizedBox(width: 24),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _circle({
    required String label,
    required VoidCallback onPressed,
    required IconData icon,
    bool selected = false,
  }) => Semantics(
    label: label,
    button: true,
    child: Tooltip(
      message: label,
      excludeFromSemantics: true,
      child: IconButton(
        onPressed: onPressed,
        icon: voiceIconTransition(context, Icon(icon, key: ValueKey(icon))),
        iconSize: 22,
        constraints: const BoxConstraints.tightFor(width: 48, height: 48),
        style: IconButton.styleFrom(
          foregroundColor: selected ? FrockTheme.accentDeep : Colors.white,
          backgroundColor: Colors.white.withValues(
            alpha: selected ? 0.95 : 0.18,
          ),
          shape: const CircleBorder(),
        ),
      ),
    ),
  );

  Widget _stage() => identified(
    VoiceIds.footerAnimation,
    LayoutBuilder(
      builder: (context, constraints) {
        final available =
            constraints.maxWidth -
            voiceFooterStageInset -
            voiceFooterControlsWidth;
        final width = math.min(
          voiceFooterStageMaxWidth,
          math.max(0.0, available),
        );
        if (width == 0) return const SizedBox.shrink();
        final left = ((constraints.maxWidth - width) / 2).clamp(
          voiceFooterStageInset,
          constraints.maxWidth - voiceFooterControlsWidth - width,
        );
        final botId = widget.session.delegatedBotId;
        final appearance = botId == null
            ? null
            : widget.botAppearance?.call(botId);
        final botName = widget.session.delegatedBotName;
        final delegation = widget.session.delegationState;
        return Stack(
          children: [
            Positioned(
              left: left,
              top: 0,
              width: width,
              height: voiceFooterHeight,
              child: VoiceWaveform(
                key: voiceFooterAnimationKey,
                source: widget.session,
                microphone: () =>
                    widget.session.muted ? 0 : widget.session.micLevel,
                playback: () => widget.session.playbackLevel,
                mode: () => widget.session.meterMode,
                enabled: widget.session.active,
                onAccent: true,
              ),
            ),
            Positioned(
              left: left,
              top: 4,
              width: width,
              height: voiceFooterHeight - 8,
              child: IgnorePointer(
                child: AnimatedSwitcher(
                  duration: FrockTheme.motion(
                    context,
                    const Duration(milliseconds: 350),
                  ),
                  switchInCurve: Curves.easeOutBack,
                  switchOutCurve: Curves.easeInCubic,
                  transitionBuilder: (child, animation) => FadeTransition(
                    opacity: animation,
                    child: SlideTransition(
                      position: Tween<Offset>(
                        begin: const Offset(0, 0.45),
                        end: Offset.zero,
                      ).animate(animation),
                      child: ScaleTransition(
                        scale: Tween<double>(
                          begin: 0.82,
                          end: 1,
                        ).animate(animation),
                        child: child,
                      ),
                    ),
                  ),
                  child: appearance == null || botId == null
                      ? const SizedBox.shrink(key: ValueKey('voice-no-bot'))
                      : Semantics(
                          key: ValueKey('voice-bot-$botId'),
                          liveRegion: true,
                          label: delegation == VoiceDelegationStateV1.answering
                              ? '$botName is answering'
                              : delegation == VoiceDelegationStateV1.finished
                              ? '$botName finished'
                              : 'Asked $botName',
                          // The character alone: its pose says whether the
                          // Bot is being asked, answering or done, which is
                          // what the animations are for. The words stay on
                          // the semantics label for a screen reader.
                          child: Align(
                            alignment: Alignment.centerLeft,
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                CharacterAvatar(
                                  size: 76,
                                  characterId: appearance.characterId,
                                  primary: appearance.primary,
                                  activity:
                                      delegation ==
                                          VoiceDelegationStateV1.finished
                                      ? CharacterActivity.success
                                      : CharacterActivity.thinking,
                                  emotion:
                                      delegation ==
                                          VoiceDelegationStateV1.answering
                                      ? CharacterEmotion.content
                                      : CharacterEmotion.curious,
                                ),
                              ],
                            ),
                          ),
                        ),
                ),
              ),
            ),
          ],
        );
      },
    ),
  );
}
