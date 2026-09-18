import 'package:flutter/material.dart';

/// The colours a product hands the theme builder.
///
/// Radii, typefaces and motion stay the kit's. The palette is the
/// product's and does not move — unless the product says so here.
@immutable
class ProductThemeTokens {
  final Color accent;
  final Color accentSoft;
  final Color accentDeep;
  final Color success;
  final Color successInk;
  final Color warning;
  final Color warningInk;
  final Color window;
  final Color surface;
  final Color raised;
  final Color border;
  final Color muted;
  final Color subtle;
  final Color text;
  final Color cream;
  final Color paper;
  final Color ink;
  final Color inkMuted;
  final Color line;
  final Color blush;
  final Color blushInk;
  final Color blushDark;
  final Color blushDarkInk;
  final Color lightPrimary;

  const ProductThemeTokens({
    required this.accent,
    required this.accentSoft,
    required this.accentDeep,
    required this.success,
    required this.successInk,
    required this.warning,
    required this.warningInk,
    required this.window,
    required this.surface,
    required this.raised,
    required this.border,
    required this.muted,
    required this.subtle,
    required this.text,
    required this.cream,
    required this.paper,
    required this.ink,
    required this.inkMuted,
    required this.line,
    required this.blush,
    required this.blushInk,
    required this.blushDark,
    required this.blushDarkInk,
    required this.lightPrimary,
  });

  /// FrockBot's reviewed palette. A consumer starts here and replaces
  /// the colours that are theirs.
  static const frockbot = ProductThemeTokens(
    accent: Color(0xffdb4b6d),
    accentSoft: Color(0xfff59ab6),
    accentDeep: Color(0xff9c1a44),
    success: Color(0xff44a877),
    successInk: Color(0xff1c7a4e),
    warning: Color(0xffd9a441),
    warningInk: Color(0xff8a6000),
    window: Color(0xff1f1e24),
    surface: Color(0xff1a191e),
    raised: Color(0xff2c2a33),
    border: Color(0xff3a3742),
    muted: Color(0xffa8a3a6),
    subtle: Color(0xff8d8896),
    text: Color(0xfff6f2ee),
    cream: Color(0xfffaf7f2),
    paper: Color(0xffffffff),
    ink: Color(0xff1e1d27),
    inkMuted: Color(0xff6d6974),
    line: Color(0xffe7e0d9),
    blush: Color(0xfffce2ea),
    blushInk: Color(0xffb11f4b),
    blushDark: Color(0xff3a2229),
    blushDarkInk: Color(0xfff6d2db),
    lightPrimary: Color(0xffc23359),
  );
}
