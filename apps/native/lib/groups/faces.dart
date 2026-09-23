/// How a Group Chat draws its members: the overlapping stills that stand for
/// the group, the badge that opens every Bot message, and the chip a mention
/// is drawn as.
library;

import 'package:flutter/material.dart';

import '../flock/avatar.dart';

/// A member as a group draws it: its name and what it wears.
class GroupFace {
  final String botId;
  final String name;
  final String characterId;

  /// The Bot's chosen colour, `#rrggbb`, or null for its character's own.
  final String? primary;
  const GroupFace({
    required this.botId,
    required this.name,
    required this.characterId,
    this.primary,
  });

  Color get colour => characterColourV1(primary, characterId);
}

/// Black or white, whichever reads on [fill].
Color badgeInkFor(Color fill) {
  double contrast(Color a, Color b) {
    final x = a.computeLuminance();
    final y = b.computeLuminance();
    return x > y ? (x + 0.05) / (y + 0.05) : (y + 0.05) / (x + 0.05);
  }

  return contrast(Colors.white, fill) >= contrast(Colors.black, fill)
      ? Colors.white
      : Colors.black;
}

/// Near-white and near-black fills vanish into one of the two grounds, so
/// they carry a hairline.
bool badgeNeedsOutline(Color fill) {
  final luminance = fill.computeLuminance();
  return luminance > 0.8 || luminance < 0.02;
}

/// Up to three members' stills, overlapping, and `+N` for the rest. The
/// sidebar row, the pinned tile and the thread header all draw a group so.
class GroupAvatars extends StatelessWidget {
  final List<GroupFace> faces;
  final double size;

  /// The ground the stack sits on, which each face is ringed in so the one
  /// in front reads as in front.
  final Color? ring;

  /// How much of each face the next one covers.
  final double overlap;
  const GroupAvatars({
    super.key,
    required this.faces,
    this.size = 28,
    this.ring,
    this.overlap = 0.38,
  });

  static const shown = 3;

  static double widthFor(int count, double size, {double overlap = 0.38}) {
    final drawn = count > shown ? shown + 1 : count;
    if (drawn <= 0) return size;
    return size + (drawn - 1) * size * (1 - overlap);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final ground = ring ?? scheme.surface;
    final visible = faces.take(shown).toList();
    final more = faces.length - visible.length;
    final step = size * (1 - overlap);
    final discs = <Widget>[
      for (final face in visible)
        _Disc(
          size: size,
          ring: ground,
          fill: Color.alphaBlend(
            face.colour.withValues(alpha: 0.32),
            scheme.surfaceContainerHigh,
          ),
          child: Padding(
            padding: EdgeInsets.all(size * 0.08),
            child: Image.asset(
              'assets/characters/${_known(face.characterId)}.png',
              fit: BoxFit.contain,
              excludeFromSemantics: true,
            ),
          ),
        ),
      if (more > 0)
        _Disc(
          size: size,
          ring: ground,
          fill: scheme.surfaceContainerHighest,
          child: Center(
            child: Text(
              '+$more',
              style: TextStyle(
                fontSize: size * 0.36,
                fontWeight: FontWeight.w600,
                color: scheme.onSurfaceVariant,
                height: 1,
              ),
            ),
          ),
        ),
    ];
    return ExcludeSemantics(
      child: SizedBox(
        width: widthFor(faces.length, size, overlap: overlap),
        height: size,
        child: Stack(
          children: [
            // The first face is in front, so it is drawn last.
            for (var index = discs.length - 1; index >= 0; index--)
              Positioned(left: index * step, top: 0, child: discs[index]),
          ],
        ),
      ),
    );
  }

  static String _known(String characterId) =>
      characterCatalogV1.containsKey(characterId)
      ? characterId
      : defaultCharacterIdV1;
}

class _Disc extends StatelessWidget {
  final double size;
  final Color ring;
  final Color fill;
  final Widget child;
  const _Disc({
    required this.size,
    required this.ring,
    required this.fill,
    required this.child,
  });

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      color: fill,
      border: Border.all(color: ring, width: size >= 32 ? 2 : 1.5),
    ),
    clipBehavior: Clip.antiAlias,
    child: child,
  );
}

/// The pill every Bot message in a group opens with: the Bot's colour and
/// its name. Two Bots of one character share a colour and are told apart by
/// the name.
class BotBadge extends StatelessWidget {
  final GroupFace face;
  final bool small;
  const BotBadge({super.key, required this.face, this.small = false});

  @override
  Widget build(BuildContext context) {
    final fill = face.colour;
    final ink = badgeInkFor(fill);
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: small ? 7 : 9,
        vertical: small ? 1.5 : 2.5,
      ),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(999),
        border: badgeNeedsOutline(fill)
            ? Border.all(
                color: Theme.of(context).colorScheme.outlineVariant,
                width: 0.75,
              )
            : null,
      ),
      child: Text(
        face.name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.labelMedium?.copyWith(
          color: ink,
          fontSize: small ? 11 : 12,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.1,
          height: 1.25,
        ),
      ),
    );
  }
}

/// `@Name` in a message, in the named Bot's colour.
InlineSpan mentionChipSpan(
  BuildContext context,
  String text,
  Color fill,
  TextStyle base,
) {
  final ink = badgeInkFor(fill);
  return WidgetSpan(
    alignment: PlaceholderAlignment.baseline,
    baseline: TextBaseline.alphabetic,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 0.5),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(6),
        border: badgeNeedsOutline(fill)
            ? Border.all(
                color: Theme.of(context).colorScheme.outlineVariant,
                width: 0.75,
              )
            : null,
      ),
      child: Text(
        text,
        style: base.copyWith(
          color: ink,
          fontWeight: FontWeight.w600,
          fontSize: (base.fontSize ?? 15) * 0.94,
        ),
      ),
    ),
  );
}
