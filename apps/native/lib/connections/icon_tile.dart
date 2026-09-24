/// An app's mark: its own logo when this build bundles one, a letter tile
/// otherwise. Drawn on a Connectors row and on a Card's `ConnectApp` alike, so
/// an app looks the same wherever the person is asked to connect it.
library;

import 'package:flutter/material.dart';

/// The 40-point mark at the head of a row: the app's own logo when the
/// deployment bundles one, otherwise a letter tile — never a broken image.
class ConnectorIconTile extends StatelessWidget {
  final String? asset;
  final String? label;
  final IconData icon;
  const ConnectorIconTile({
    super.key,
    this.asset,
    this.label,
    this.icon = Icons.link_rounded,
  });

  String get _letter {
    final source = (label ?? '').trim();
    if (source.isEmpty) return '?';
    return String.fromCharCode(source.runes.first).toUpperCase();
  }

  Widget _letterMark(ColorScheme scheme) {
    return Text(
      _letter,
      style: TextStyle(
        fontSize: 18,
        fontWeight: FontWeight.w700,
        height: 1,
        color: scheme.onSurface,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final hasAsset = asset != null;
    final Widget mark = hasAsset
        ? Image.asset(
            'assets/connectors/$asset.png',
            width: 26,
            height: 26,
            filterQuality: FilterQuality.medium,
            errorBuilder: (_, _, _) => _letterMark(scheme),
          )
        : label != null
        ? _letterMark(scheme)
        : Icon(icon, size: 22, color: scheme.onSurface);
    // Brand marks are drawn for a light ground, so the tile is one in both
    // themes; a letter or glyph of our own takes the surface colour instead.
    return Container(
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        color: hasAsset ? Colors.white : scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: scheme.outlineVariant),
      ),
      alignment: Alignment.center,
      child: ExcludeSemantics(child: mark),
    );
  }
}
