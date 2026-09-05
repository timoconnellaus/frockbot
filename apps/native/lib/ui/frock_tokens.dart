import 'package:flutter/material.dart';

/// Frock UI tokens. Mirrors `docs/design/tokens.json` name for name; the
/// numbers here are the phone (touch) density. The web shell reads the same
/// file at compact density. If a value here and the HTML disagree, the JSON
/// is the referee.
@immutable
class FrockTokens extends ThemeExtension<FrockTokens> {
  const FrockTokens({
    required this.ground,
    required this.window,
    required this.sheet,
    required this.tile,
    required this.tile2,
    required this.line,
    required this.line2,
    required this.highlight,
    required this.ink,
    required this.ink2,
    required this.ink3,
    required this.accent,
    required this.accentPressed,
    required this.onAccent,
    required this.accentInk,
    required this.accentTint,
    required this.accentGlow,
    required this.good,
    required this.goodTint,
    required this.warn,
    required this.warnTint,
    required this.danger,
    required this.dangerTint,
    required this.well,
  });

  final Color ground;
  final Color window;
  final Color sheet;
  final Color tile;
  final Color tile2;
  final Color line;
  final Color line2;
  final Color highlight;
  final Color ink;
  final Color ink2;
  final Color ink3;
  final Color accent;
  final Color accentPressed;
  final Color onAccent;
  final Color accentInk;
  final Color accentTint;
  final Color accentGlow;
  final Color good;
  final Color goodTint;
  final Color warn;
  final Color warnTint;
  final Color danger;
  final Color dangerTint;
  final Color well;

  static const _paper = Color(0xfff4f2f6);
  static const _night = Color(0xff1f1e24);

  /// The product default.
  static const dark = FrockTokens(
    ground: Color(0xff151419),
    window: Color(0xff1b1a20),
    sheet: Color(0xff221f27),
    tile: Color(0xff2b282f),
    tile2: Color(0xff35313a),
    line: Color(0x14f4f2f6),
    line2: Color(0x29f4f2f6),
    highlight: Color(0x0dffffff),
    ink: Color(0xebf4f2f6),
    ink2: Color(0x99f4f2f6),
    ink3: Color(0x6bf4f2f6),
    accent: Color(0xffec386b),
    accentPressed: Color(0xffc62656),
    onAccent: Color(0xffffffff),
    accentInk: Color(0xfff3a3ba),
    accentTint: Color(0x24ec386b),
    accentGlow: Color(0x57ec386b),
    good: Color(0xff7cc9a6),
    goodTint: Color(0x247cc9a6),
    warn: Color(0xffdfc07f),
    warnTint: Color(0x24dfc07f),
    danger: Color(0xffef9aa5),
    dangerTint: Color(0x24ef9aa5),
    well: Color(0xff0f0e12),
  );

  /// A real second palette for Applets and previews, not an inversion.
  static const light = FrockTokens(
    ground: Color(0xffefece8),
    window: Color(0xfff3f1ee),
    sheet: Color(0xfffaf9f7),
    tile: Color(0xffffffff),
    tile2: Color(0xffeeebe6),
    line: Color(0x141f1e24),
    line2: Color(0x291f1e24),
    highlight: Color(0xb3ffffff),
    ink: Color(0xeb1f1e24),
    ink2: Color(0x9e1f1e24),
    ink3: Color(0x731f1e24),
    accent: Color(0xffd92d5f),
    accentPressed: Color(0xffb0204b),
    onAccent: Color(0xffffffff),
    accentInk: Color(0xffb0204b),
    accentTint: Color(0x1fd92d5f),
    accentGlow: Color(0x38d92d5f),
    good: Color(0xff1f8f5f),
    goodTint: Color(0x1f1f8f5f),
    warn: Color(0xff9a6a00),
    warnTint: Color(0x1f9a6a00),
    danger: Color(0xffc8323f),
    dangerTint: Color(0x1fc8323f),
    well: _night,
  );

  static FrockTokens of(BuildContext context) =>
      Theme.of(context).extension<FrockTokens>() ??
      (Theme.of(context).brightness == Brightness.dark ? dark : light);

  // ---- faces ----
  static const sans = 'Manrope';
  static const display = 'Archivo Black';
  static const mono = 'JetBrains Mono';

  // ---- type roles (phone) ----
  TextStyle get displayStyle => TextStyle(
    fontFamily: display,
    fontSize: 28,
    height: 32 / 28,
    letterSpacing: -0.56,
    color: ink,
  );
  TextStyle get nameStyle => TextStyle(
    fontFamily: display,
    fontSize: 20,
    height: 24 / 20,
    letterSpacing: -0.3,
    color: ink,
  );
  TextStyle get numberStyle => TextStyle(
    fontFamily: display,
    fontSize: 22,
    height: 26 / 22,
    letterSpacing: -0.44,
    color: ink,
    fontFeatures: const [FontFeature.tabularFigures()],
  );
  TextStyle get barTitle => TextStyle(
    fontFamily: sans,
    fontWeight: FontWeight.w600,
    fontSize: 16,
    height: 22 / 16,
    letterSpacing: -0.16,
    color: ink,
  );

  /// What you type: a step above message text so the field reads as the
  /// place to write, and Android never has to scale it.
  TextStyle get composerText => TextStyle(
    fontFamily: sans,
    fontSize: 16,
    height: 22 / 16,
    letterSpacing: -0.08,
    color: ink,
  );
  TextStyle get message => TextStyle(
    fontFamily: sans,
    fontSize: 15,
    height: 22 / 15,
    letterSpacing: -0.06,
    color: ink,
  );
  TextStyle get row => TextStyle(
    fontFamily: sans,
    fontWeight: FontWeight.w600,
    fontSize: 14,
    height: 18 / 14,
    letterSpacing: -0.07,
    color: ink,
  );
  TextStyle get body =>
      TextStyle(fontFamily: sans, fontSize: 14, height: 20 / 14, color: ink);
  TextStyle get caption => TextStyle(
    fontFamily: sans,
    fontWeight: FontWeight.w500,
    fontSize: 12,
    height: 16 / 12,
    letterSpacing: 0.05,
    color: ink2,
    fontFeatures: const [FontFeature.tabularFigures()],
  );
  TextStyle get eyebrow => TextStyle(
    fontFamily: sans,
    fontWeight: FontWeight.w600,
    fontSize: 11,
    height: 16 / 11,
    letterSpacing: 1.1,
    color: ink3,
  );
  TextStyle get monoStyle => TextStyle(
    fontFamily: mono,
    fontWeight: FontWeight.w500,
    fontSize: 12,
    height: 16 / 12,
    color: ink3,
    fontFeatures: const [
      FontFeature.tabularFigures(),
      FontFeature.slashedZero(),
    ],
  );
  TextStyle get pillLabel => TextStyle(
    fontFamily: sans,
    fontWeight: FontWeight.w600,
    fontSize: 14,
    height: 1,
    color: ink,
  );

  // ---- space and size (phone) ----
  static const edge = 18.0;
  static const rowGap = 10.0;
  static const groupGap = 18.0;
  static const eyebrowToGroup = 8.0;
  static const rowHeight = 50.0;
  static const tap = 44.0;
  static const controlSm = 30.0;
  static const controlMd = 36.0;
  static const controlLg = 46.0;
  static const composer = 52.0;
  static const composerButton = 40.0;
  static const tileSize = 32.0;
  static const receiptTile = 24.0;
  static const avatarSm = 24.0;
  static const avatarMd = 32.0;
  static const avatarLg = 56.0;
  static const avatarHero = 84.0;
  static const icon = 18.0;
  static const iconSm = 14.0;
  static const bar = 44.0;
  static const dock = 56.0;

  // ---- radius (phone) ----
  static const radiusPill = 999.0;
  static const radiusGroup = 18.0;
  static const radiusTile = 22.0;
  static const radiusSheet = 24.0;
  static const radiusReceipt = 12.0;
  static const radiusField = 14.0;
  static const radiusIconTile = 9.0;
  static const avatarRadiusRatio = 0.27;
  static const ringInset = 3.0;
  static const ringWidth = 2.0;
  static const ringRadiusRatio = 0.32;

  // ---- motion ----
  static const curve = Cubic(0.2, 0, 0, 1);
  static const fast = Duration(milliseconds: 140);
  static const enter = Duration(milliseconds: 260);
  static const pulse = Duration(milliseconds: 1600);

  static const glowSize = 260.0;
  static const strokeText = 1.6;
  static const strokeControl = 1.75;

  @override
  FrockTokens copyWith() => this;

  @override
  FrockTokens lerp(ThemeExtension<FrockTokens>? other, double t) {
    if (other is! FrockTokens) return this;
    Color c(Color a, Color b) => Color.lerp(a, b, t)!;
    return FrockTokens(
      ground: c(ground, other.ground),
      window: c(window, other.window),
      sheet: c(sheet, other.sheet),
      tile: c(tile, other.tile),
      tile2: c(tile2, other.tile2),
      line: c(line, other.line),
      line2: c(line2, other.line2),
      highlight: c(highlight, other.highlight),
      ink: c(ink, other.ink),
      ink2: c(ink2, other.ink2),
      ink3: c(ink3, other.ink3),
      accent: c(accent, other.accent),
      accentPressed: c(accentPressed, other.accentPressed),
      onAccent: c(onAccent, other.onAccent),
      accentInk: c(accentInk, other.accentInk),
      accentTint: c(accentTint, other.accentTint),
      accentGlow: c(accentGlow, other.accentGlow),
      good: c(good, other.good),
      goodTint: c(goodTint, other.goodTint),
      warn: c(warn, other.warn),
      warnTint: c(warnTint, other.warnTint),
      danger: c(danger, other.danger),
      dangerTint: c(dangerTint, other.dangerTint),
      well: c(well, other.well),
    );
  }

  /// A ThemeData carrying these tokens, for screens built on Frock UI widgets.
  static ThemeData themeData(FrockTokens t) {
    final dark = t == dark_;
    return ThemeData(
      useMaterial3: true,
      brightness: dark ? Brightness.dark : Brightness.light,
      scaffoldBackgroundColor: t.window,
      canvasColor: t.window,
      fontFamily: sans,
      splashFactory: NoSplash.splashFactory,
      highlightColor: Colors.transparent,
      colorScheme:
          ColorScheme.fromSeed(
            seedColor: t.accent,
            brightness: dark ? Brightness.dark : Brightness.light,
          ).copyWith(
            primary: t.accent,
            onPrimary: t.onAccent,
            surface: t.window,
            onSurface: t.ink,
            onSurfaceVariant: t.ink2,
            outlineVariant: t.line,
          ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: t.accent,
        selectionColor: t.accent.withValues(alpha: 0.26),
        selectionHandleColor: t.accent,
      ),
      // Stock Material that still appears (form fields, switches, menus)
      // takes the tokens too, so no screen falls back to the seed palette.
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: t.tile,
        labelStyle: t.caption.copyWith(color: t.ink2),
        floatingLabelStyle: t.caption.copyWith(color: t.accentInk),
        helperStyle: t.caption,
        helperMaxLines: 4,
        errorStyle: t.caption.copyWith(color: t.danger),
        counterStyle: t.caption,
        prefixIconColor: t.ink2,
        suffixIconColor: t.ink2,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 12,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide(color: t.line),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide(color: t.accent, width: strokeControl),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide(color: t.danger),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide(color: t.danger, width: strokeControl),
        ),
        disabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide(color: t.line.withValues(alpha: 0.5)),
        ),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? t.onAccent : t.ink2,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? t.accent : t.tile2,
        ),
        trackOutlineColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? t.accent : t.line2,
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: t.accent,
          foregroundColor: t.onAccent,
          disabledBackgroundColor: t.tile2,
          disabledForegroundColor: t.ink3,
          minimumSize: const Size(0, controlMd),
          padding: const EdgeInsets.symmetric(horizontal: 16),
          textStyle: t.pillLabel,
          shape: const StadiumBorder(),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: t.ink,
          disabledForegroundColor: t.ink3,
          minimumSize: const Size(0, controlMd),
          padding: const EdgeInsets.symmetric(horizontal: 16),
          textStyle: t.pillLabel,
          side: BorderSide(color: t.line2),
          shape: const StadiumBorder(),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: t.accentInk,
          disabledForegroundColor: t.ink3,
          minimumSize: const Size(0, controlMd),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          textStyle: t.pillLabel,
          shape: const StadiumBorder(),
        ),
      ),
      cardTheme: CardThemeData(
        color: t.sheet,
        elevation: 0,
        margin: const EdgeInsets.only(bottom: rowGap),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusGroup),
        ),
      ),
      listTileTheme: ListTileThemeData(
        iconColor: t.ink2,
        textColor: t.ink,
        titleTextStyle: t.row,
        subtitleTextStyle: t.caption,
        selectedColor: t.accentInk,
        selectedTileColor: t.accentTint,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusField),
        ),
      ),
      dividerTheme: DividerThemeData(color: t.line, space: 1, thickness: 1),
      dropdownMenuTheme: DropdownMenuThemeData(
        textStyle: t.body,
        menuStyle: MenuStyle(
          backgroundColor: WidgetStatePropertyAll(t.tile),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(radiusField),
            ),
          ),
        ),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: t.tile,
        textStyle: t.body,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusField),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: t.tile2,
        contentTextStyle: t.body,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusField),
        ),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(color: t.accent),
      extensions: [t],
    );
  }

  static const dark_ = dark;
  static const paper = _paper;
}
