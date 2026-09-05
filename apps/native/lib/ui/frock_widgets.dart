import 'package:flutter/material.dart';

import 'frock_tokens.dart';

/// Frock UI widgets. Each mirrors one component on docs/design/frock-ui.html.

enum BotState { working, ready, idle, none }

/// The sheep avatar with its state ring. Radius is 27% of size, the ring sits
/// 3px outside at 2px, so every size reads as one family.
class FrockSheep extends StatelessWidget {
  const FrockSheep({
    super.key,
    this.size = FrockTokens.avatarMd,
    this.state = BotState.none,
  });
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
      child: Image.asset(
        'assets/sheep.png',
        width: size,
        height: size,
        excludeFromSemantics: true,
      ),
    );
    if (ringColor == null) return image;
    return Stack(
      clipBehavior: Clip.none,
      children: [
        image,
        Positioned.fill(
          child: Transform.scale(
            scale: (size + FrockTokens.ringInset * 2) / size,
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(
                  (size + 6) * FrockTokens.ringRadiusRatio,
                ),
                border: Border.all(
                  color: ringColor,
                  width: FrockTokens.ringWidth,
                ),
              ),
            ),
          ),
        ),
      ],
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
          child: Row(
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
              if (trailing != null) ...[const SizedBox(width: 12), trailing!],
              if (chevron)
                Icon(Icons.chevron_right_rounded, size: 18, color: t.ink3),
            ],
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
        Text(
          label,
          style: t.pillLabel.copyWith(color: fg, fontSize: fs),
        ),
      ],
    );
    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(FrockTokens.radiusPill),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(FrockTokens.radiusPill),
        child: Container(
          height: height,
          padding: EdgeInsets.symmetric(horizontal: pad),
          decoration: kind == PillKind.primary
              ? BoxDecoration(
                  borderRadius: BorderRadius.circular(FrockTokens.radiusPill),
                  boxShadow: [
                    BoxShadow(
                      color: t.accentGlow,
                      blurRadius: 24,
                      offset: const Offset(0, 8),
                    ),
                  ],
                )
              : null,
          child: child,
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

/// The 44px pill composer with buttons inside it.
class FrockComposer extends StatelessWidget {
  const FrockComposer({
    super.key,
    required this.hint,
    this.onVoice,
    this.onSend,
  });
  final String hint;
  final VoidCallback? onVoice;
  final VoidCallback? onSend;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Container(
      height: FrockTokens.composer,
      padding: const EdgeInsets.fromLTRB(16, 4, 4, 4),
      decoration: BoxDecoration(
        color: t.sheet,
        borderRadius: BorderRadius.circular(FrockTokens.composer / 2),
        border: Border.all(color: t.line),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.35),
            blurRadius: 30,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(hint, style: t.message.copyWith(color: t.ink3)),
          ),
          if (onVoice != null)
            FrockIconButton(
              Icons.mic_none_rounded,
              size: FrockTokens.composerButton,
              onTap: onVoice,
              semanticLabel: 'Voice',
            ),
          const SizedBox(width: 4),
          FrockIconButton(
            Icons.arrow_upward_rounded,
            primary: true,
            size: FrockTokens.composerButton,
            onTap: onSend,
            semanticLabel: 'Send',
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
  )..repeat(reverse: true);
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
    return SizedBox(
      height: FrockTokens.bar,
      child: Row(
        children: [
          SizedBox(width: FrockTokens.controlMd, child: leading),
          Expanded(child: Center(child: title)),
          SizedBox(width: FrockTokens.controlMd, child: trailing),
        ],
      ),
    );
  }
}

/// The dock: four destinations, the active glyph takes the accent.
class FrockDock extends StatelessWidget {
  const FrockDock({
    super.key,
    required this.items,
    required this.active,
    this.onSelect,
  });
  final List<(IconData, String)> items;
  final int active;
  final ValueChanged<int>? onSelect;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Container(
      height: FrockTokens.dock,
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: t.line)),
      ),
      child: Row(
        children: [
          for (var i = 0; i < items.length; i++)
            Expanded(
              child: InkWell(
                onTap: onSelect == null ? null : () => onSelect!(i),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      items[i].$1,
                      size: 20,
                      color: i == active ? t.accent : t.ink3,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      items[i].$2.toUpperCase(),
                      style: t.eyebrow.copyWith(
                        fontSize: 10,
                        letterSpacing: 0.4,
                        color: i == active ? t.ink : t.ink3,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
