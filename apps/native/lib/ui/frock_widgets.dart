import 'package:flutter/material.dart';

import 'frock_tokens.dart';
import 'sheep_layers.dart';

export 'sheep_layers.dart' show SheepLook;

/// Frock UI widgets. Each mirrors one component on docs/design/frock-ui.html.

enum BotState { working, ready, idle, none }

/// The sheep avatar with its state ring. Radius is 27% of size, the ring sits
/// 3px outside at 2px, so every size reads as one family.
class FrockSheep extends StatelessWidget {
  const FrockSheep({
    super.key,
    this.look = SheepLook.plain,
    this.size = FrockTokens.avatarMd,
    this.state = BotState.none,
  });

  /// The Bot's own sheep: the Flock's recipe, drawn as the same stacked
  /// layers the web draws, so a Bot is recognisably itself everywhere.
  final SheepLook look;
  final double size;
  final BotState state;

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final ringColor = switch (state) {
      BotState.working => t.accent,
      BotState.ready => t.good,
      BotState.idle => t.line2,
      BotState.none => null,
    };
    final image = ClipRRect(
      borderRadius: BorderRadius.circular(size * FrockTokens.avatarRadiusRatio),
      child: SizedBox(
        width: size,
        height: size,
        child: Stack(
          fit: StackFit.expand,
          children: [
            for (final id in sheepLayerIds(look))
              Image.asset(
                sheepLayerAsset(id),
                fit: BoxFit.fill,
                excludeFromSemantics: true,
                // Filter at the sizes a row uses; the art is 256px.
                filterQuality: FilterQuality.medium,
                // A layer that fails to load leaves a sheep, not a hole.
                errorBuilder: (_, _, _) => const SizedBox.shrink(),
              ),
          ],
        ),
      ),
    );
    if (ringColor == null) return image;
    // The ring is a box 3px outside the avatar with a 2px border. Its corner
    // radius is the avatar's radius plus the 3px offset, so the two curves are
    // concentric, the way the CSS `inset: -3px` ring is. OverflowBox keeps the
    // widget's layout size at `size`, so a ringed and an unringed avatar line
    // up in the same row.
    const grow = FrockTokens.ringInset;
    final outer = size + grow * 2;
    return SizedBox(
      width: size,
      height: size,
      child: OverflowBox(
        maxWidth: outer,
        maxHeight: outer,
        child: Container(
          width: outer,
          height: outer,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(
              size * FrockTokens.avatarRadiusRatio + grow,
            ),
            border: Border.all(color: ringColor, width: FrockTokens.ringWidth),
          ),
          child: Center(child: image),
        ),
      ),
    );
  }
}

/// The accent as light: a radial glow placed behind whatever is working.
class FrockGlow extends StatelessWidget {
  const FrockGlow({super.key, this.size = FrockTokens.glowSize});
  final double size;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return IgnorePointer(
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            radius: 0.7071,
            colors: [t.accentGlow, t.accentGlow.withValues(alpha: 0)],
            stops: const [0, 0.62],
          ),
        ),
      ),
    );
  }
}

/// An eyebrow: the small tracked caps label above a group.
class FrockEyebrow extends StatelessWidget {
  const FrockEyebrow(this.text, {super.key, this.color});
  final String text;
  final Color? color;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: FrockTokens.eyebrowToGroup),
      child: Text(text.toUpperCase(), style: t.eyebrow.copyWith(color: color)),
    );
  }
}

/// One tonal sheet holding rows. Rows have no gap; hairlines start at the
/// text edge. `needsYou` is the only bordered group: accent at 35% plus a halo.
class FrockGroup extends StatelessWidget {
  const FrockGroup({super.key, required this.children, this.needsYou = false});
  final List<Widget> children;
  final bool needsYou;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Container(
      decoration: BoxDecoration(
        color: t.sheet,
        borderRadius: BorderRadius.circular(FrockTokens.radiusGroup),
        border: needsYou
            ? Border.all(color: t.accent.withValues(alpha: 0.35))
            : null,
        boxShadow: [
          if (needsYou) BoxShadow(color: t.accentTint, spreadRadius: 4),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(FrockTokens.radiusGroup),
        child: Stack(
          children: [
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Container(height: 1, color: t.highlight),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
              child: Column(
                children: [
                  for (var i = 0; i < children.length; i++)
                    if (i == 0) children[i] else _Hairline(child: children[i]),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Hairline extends StatelessWidget {
  const _Hairline({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Stack(
      children: [
        child,
        Positioned(
          top: 0,
          left: 44,
          right: 0,
          child: Container(height: 1, color: t.line),
        ),
      ],
    );
  }
}

enum TileTone { neutral, accent, good, warn, danger }

/// The 32px rounded tile behind a row's icon.
class FrockIconTile extends StatelessWidget {
  const FrockIconTile(
    this.icon, {
    super.key,
    this.tone = TileTone.neutral,
    this.size = FrockTokens.tileSize,
  });
  final IconData icon;
  final TileTone tone;
  final double size;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final (bg, fg) = switch (tone) {
      TileTone.neutral => (t.tile, t.ink2),
      TileTone.accent => (t.accentTint, t.accentInk),
      TileTone.good => (t.goodTint, t.good),
      TileTone.warn => (t.warnTint, t.warn),
      TileTone.danger => (t.dangerTint, t.danger),
    };
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(size * 0.28),
      ),
      child: Icon(icon, size: size * 0.53, color: fg),
    );
  }
}

/// A row inside a group: leading tile or avatar, title, caption, trailing.
class FrockRow extends StatelessWidget {
  const FrockRow({
    super.key,
    this.leading,
    required this.title,
    this.caption,
    this.trailing,
    this.onTap,
    this.chevron = false,
  });
  final Widget? leading;
  final String title;
  final String? caption;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool chevron;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: FrockTokens.rowHeight),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: LayoutBuilder(
            builder: (context, constraints) => Row(
              children: [
                if (leading != null) ...[leading!, const SizedBox(width: 12)],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        style: t.row,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      if (caption != null)
                        Text(
                          caption!,
                          style: t.caption,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                    ],
                  ),
                ),
                if (trailing != null) ...[
                  const SizedBox(width: 12),
                  // The title keeps most of the row; a wide trailing (a chip
                  // at 200% text) shrinks to fit rather than overflowing.
                  ConstrainedBox(
                    constraints: BoxConstraints(
                      maxWidth: constraints.maxWidth * 0.4,
                    ),
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerRight,
                      child: trailing!,
                    ),
                  ),
                ],
                if (chevron)
                  Icon(Icons.chevron_right_rounded, size: 18, color: t.ink3),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A receipt: what a Bot did, in one line. Tile, verb-first sentence, mono time.
class FrockReceipt extends StatelessWidget {
  const FrockReceipt({
    super.key,
    required this.icon,
    required this.text,
    this.detail,
    this.time,
    this.tone = TileTone.neutral,
    this.trailing,
    this.needsYou = false,
  });
  final IconData icon;
  final String text;
  final String? detail;
  final String? time;
  final TileTone tone;
  final Widget? trailing;
  final bool needsYou;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 7, 10, 7),
      decoration: BoxDecoration(
        color: t.sheet,
        borderRadius: BorderRadius.circular(FrockTokens.radiusReceipt),
        border: needsYou
            ? Border.all(color: t.accent.withValues(alpha: 0.3))
            : null,
      ),
      child: Row(
        children: [
          FrockIconTile(
            icon,
            tone: needsYou ? TileTone.accent : tone,
            size: FrockTokens.receiptTile,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(text: text),
                  if (detail != null)
                    TextSpan(
                      text: ' · $detail',
                      style: TextStyle(
                        color: t.ink2,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                ],
              ),
              style: t.row.copyWith(fontSize: 13, height: 17 / 13),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (time != null) ...[
            const SizedBox(width: 10),
            Text(time!, style: t.monoStyle.copyWith(fontSize: 11)),
          ],
          if (trailing != null) ...[const SizedBox(width: 10), trailing!],
        ],
      ),
    );
  }
}

enum PillKind { primary, tonal, ghost }

enum PillSize { sm, md, lg }

/// The button. One primary pill per screen; it carries the glow.
class FrockPill extends StatelessWidget {
  const FrockPill(
    this.label, {
    super.key,
    this.kind = PillKind.tonal,
    this.size = PillSize.md,
    this.icon,
    this.onTap,
    this.color,
    this.expand = false,
  });
  final String label;
  final PillKind kind;
  final PillSize size;
  final IconData? icon;
  final VoidCallback? onTap;
  final Color? color;
  final bool expand;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final height = switch (size) {
      PillSize.sm => FrockTokens.controlSm,
      PillSize.md => FrockTokens.controlMd,
      PillSize.lg => FrockTokens.controlLg,
    };
    final pad = switch (size) {
      PillSize.sm => 12.0,
      PillSize.md => 16.0,
      PillSize.lg => 22.0,
    };
    final fs = switch (size) {
      PillSize.sm => 13.0,
      PillSize.md => 14.0,
      PillSize.lg => 15.0,
    };
    final (bg, fg) = switch (kind) {
      PillKind.primary => (t.accent, t.onAccent),
      PillKind.tonal => (t.tile, color ?? t.ink),
      PillKind.ghost => (Colors.transparent, color ?? t.ink2),
    };
    final child = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (icon != null) ...[
          Icon(icon, size: 16, color: fg),
          const SizedBox(width: 6),
        ],
        // A pill keeps one line. At very large text sizes the label scales
        // down inside the pill rather than spilling out of it.
        Flexible(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              label,
              style: t.pillLabel.copyWith(color: fg, fontSize: fs),
            ),
          ),
        ),
      ],
    );
    return DecoratedBox(
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(FrockTokens.radiusPill),
        // The glow lives on the outer box so it falls behind the pill, never
        // on top of it.
        boxShadow: kind == PillKind.primary
            ? [
                BoxShadow(
                  color: t.accentGlow.withValues(alpha: 0.22),
                  blurRadius: 28,
                  offset: const Offset(0, 8),
                ),
              ]
            : null,
      ),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(FrockTokens.radiusPill),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(FrockTokens.radiusPill),
          child: Container(
            height: height,
            padding: EdgeInsets.symmetric(horizontal: pad),
            child: child,
          ),
        ),
      ),
    );
  }
}

/// A round icon button. Ghost by default, filled when it needs a ground.
class FrockIconButton extends StatelessWidget {
  const FrockIconButton(
    this.icon, {
    super.key,
    this.filled = false,
    this.primary = false,
    this.size = FrockTokens.controlMd,
    this.onTap,
    this.semanticLabel,
  });
  final IconData icon;
  final bool filled;
  final bool primary;
  final double size;
  final VoidCallback? onTap;
  final String? semanticLabel;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Semantics(
      button: true,
      label: semanticLabel,
      child: Material(
        color: primary ? t.accent : (filled ? t.tile : Colors.transparent),
        shape: const CircleBorder(),
        child: InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: SizedBox(
            width: size,
            height: size,
            child: Icon(
              icon,
              size: size * 0.5,
              color: primary ? t.onAccent : t.ink,
            ),
          ),
        ),
      ),
    );
  }
}

/// The 52px pill composer with 40px buttons inside it.
class FrockComposer extends StatelessWidget {
  const FrockComposer({
    super.key,
    required this.hint,
    this.field,
    this.onVoice,
    this.onSend,
    this.onStop,
    this.stopping = false,
    this.sendKey,
    this.stopKey,
  });
  final String hint;

  /// The live text field. When null the composer draws [hint] as a placeholder
  /// (the gallery and the match check use that form).
  final Widget? field;
  final VoidCallback? onVoice;

  /// Null disables Send: the button stays, dimmed, so the pill keeps its shape.
  final VoidCallback? onSend;

  /// Non-null while a reply is running; shows Stop beside Send.
  final VoidCallback? onStop;
  final bool stopping;
  final Key? sendKey;
  final Key? stopKey;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Container(
      constraints: const BoxConstraints(minHeight: FrockTokens.composer),
      padding: const EdgeInsets.fromLTRB(18, 6, 6, 6),
      decoration: BoxDecoration(
        color: t.sheet,
        borderRadius: BorderRadius.circular(FrockTokens.composer / 2),
        border: Border.all(color: t.line),
        // Soft lift, not a band: a wide, faint shadow that the dock's hairline
        // reads through. Flutter's blur is tighter than CSS at the same radius.
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.18),
            blurRadius: 36,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            // One line of text sits centred against the buttons; a taller
            // field grows upward while the buttons keep the bottom line.
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minHeight: FrockTokens.composerButton,
              ),
              child: Align(
                alignment: Alignment.centerLeft,
                child:
                    field ??
                    Text(hint, style: t.composerText.copyWith(color: t.ink3)),
              ),
            ),
          ),
          if (onVoice != null)
            FrockIconButton(
              Icons.mic_none_rounded,
              size: FrockTokens.composerButton,
              onTap: onVoice,
              semanticLabel: 'Voice',
            ),
          if (onStop != null) ...[
            const SizedBox(width: 4),
            Opacity(
              opacity: stopping ? 0.5 : 1,
              child: FrockIconButton(
                Icons.stop_rounded,
                key: stopKey,
                filled: true,
                size: FrockTokens.composerButton,
                onTap: stopping ? null : onStop,
                semanticLabel: 'Stop',
              ),
            ),
          ],
          const SizedBox(width: 4),
          Opacity(
            opacity: onSend == null ? 0.45 : 1,
            child: FrockIconButton(
              Icons.arrow_upward_rounded,
              key: sendKey,
              primary: true,
              size: FrockTokens.composerButton,
              onTap: onSend,
              semanticLabel: 'Send',
            ),
          ),
        ],
      ),
    );
  }
}

/// A stat: a display-face number over an eyebrow label. Three across, never more.
class FrockStat extends StatelessWidget {
  const FrockStat({super.key, required this.value, required this.label});
  final String value;
  final String label;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
      decoration: BoxDecoration(
        color: t.sheet,
        borderRadius: BorderRadius.circular(14),
        border: Border(top: BorderSide(color: t.highlight)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value, style: t.numberStyle),
          const SizedBox(height: 2),
          Text(label.toUpperCase(), style: t.eyebrow),
        ],
      ),
    );
  }
}

/// A chip: a small pill naming a state or filter. Never looks like a button.
class FrockChip extends StatelessWidget {
  const FrockChip(
    this.label, {
    super.key,
    this.tone = TileTone.neutral,
    this.dot = false,
  });
  final String label;
  final TileTone tone;
  final bool dot;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final (bg, fg) = switch (tone) {
      TileTone.neutral => (t.tile, t.ink),
      TileTone.accent => (t.accentTint, t.accentInk),
      TileTone.good => (t.goodTint, t.good),
      TileTone.warn => (t.warnTint, t.warn),
      TileTone.danger => (t.dangerTint, t.danger),
    };
    return Container(
      height: 28,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dot) ...[
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(color: fg, shape: BoxShape.circle),
            ),
            const SizedBox(width: 6),
          ],
          Text(label, style: t.pillLabel.copyWith(fontSize: 12, color: fg)),
        ],
      ),
    );
  }
}

/// A working indicator: a 7px dot that breathes.
class FrockPulse extends StatefulWidget {
  const FrockPulse({super.key, this.color});
  final Color? color;
  @override
  State<FrockPulse> createState() => _FrockPulseState();
}

class _FrockPulseState extends State<FrockPulse>
    with SingleTickerProviderStateMixin {
  late final AnimationController c = AnimationController(
    vsync: this,
    duration: FrockTokens.pulse,
  );

  // Reduced motion means no ticker at all, not a hidden one: a dot that still
  // schedules frames keeps the screen awake and never lets a test settle.
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      c.stop();
    } else if (!c.isAnimating) {
      c.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final reduce = MediaQuery.disableAnimationsOf(context);
    return FadeTransition(
      opacity: reduce
          ? const AlwaysStoppedAnimation(1)
          : Tween(
              begin: 0.5,
              end: 1.0,
            ).animate(CurvedAnimation(parent: c, curve: Curves.easeInOut)),
      child: Container(
        width: 7,
        height: 7,
        decoration: BoxDecoration(
          color: widget.color ?? t.accent,
          shape: BoxShape.circle,
        ),
      ),
    );
  }
}

/// The 44px app bar: leading, centred title, trailing.
class FrockBar extends StatelessWidget {
  const FrockBar({super.key, this.leading, this.title, this.trailing});
  final Widget? leading;
  final Widget? title;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) {
    // The ends size to what they hold (one or two icon buttons); the title
    // is centred on the whole bar and keeps clear of the wider end, so a
    // second action on the right never pushes the first off the screen.
    return SizedBox(
      height: FrockTokens.bar,
      child: LayoutBuilder(
        builder: (context, constraints) {
          const room = FrockTokens.controlMd * 2 + 8;
          return Stack(
            children: [
              Positioned.fill(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: room),
                  child: Center(child: title),
                ),
              ),
              if (leading != null)
                Positioned(
                  left: 0,
                  top: 0,
                  bottom: 0,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [leading!],
                  ),
                ),
              if (trailing != null)
                Positioned(
                  right: 0,
                  top: 0,
                  bottom: 0,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [trailing!],
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

/// The User's message: a soft bubble, one step above the ground, right-aligned.
class FrockUserMessage extends StatelessWidget {
  const FrockUserMessage(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Align(
      alignment: Alignment.centerRight,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.78,
        ),
        child: Container(
          padding: const EdgeInsets.fromLTRB(13, 8, 13, 8),
          decoration: BoxDecoration(
            color: t.tile,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(18),
              topRight: Radius.circular(18),
              bottomLeft: Radius.circular(18),
              bottomRight: Radius.circular(6),
            ),
          ),
          child: Text(text, style: t.message),
        ),
      ),
    );
  }
}

/// The Bot's reply: plain text, no bubble, receipts inline.
class FrockBotMessage extends StatelessWidget {
  const FrockBotMessage({super.key, required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return DefaultTextStyle(
      style: t.message,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    );
  }
}
