import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/services.dart';

import 'document.dart';

/// The reviewed web theme's semantic colors, radii, typefaces and motion.
/// Native text/touch sizes follow platform accessibility instead of CSS pixels.
///
/// The palette is the product's and does not move. What this file decides is
/// everything Material would otherwise decide for us — the proportions, the
/// radii, the weight of a line — so that a stock widget dropped anywhere in
/// the app already looks like it belongs here.
abstract final class FrockTheme {
  static const accent = Color(0xffd92d71);

  /// The pale pink secondary actions are written in: Pixel's own body
  /// colour. The voice footer's lobes use it as the tint between white and
  /// the accent.
  static const accentSoft = Color(0xfffc85ae);

  /// The deep rose the Bot speaks in on the voice footer's pink slab: the
  /// same hue as [accent], darker, so the two voices are one family told
  /// apart by weight rather than by a second colour.
  static const accentDeep = Color(0xff9a124c);

  /// The two states the scheme has no slot for. A Card's pill says "Sent" in
  /// green and "Needs your attention" in amber; `primary` is the brand and
  /// `error` is a failure, and neither of those is what those two mean. Each
  /// has a darker twin for the light theme, where the dark one would not
  /// carry against paper. The dark ones are the avatar picker's green and
  /// Sunny's yellow, so a state reads as one of the flock.
  static const success = Color(0xff58c98b);
  static const successInk = Color(0xff1c7a4e);
  static const warning = Color(0xffffc928);
  static const warningInk = Color(0xff8a6000);

  static const window = Color(0xff15151e);

  /// The ground the furniture stands on: the Bot list and the conversation's
  /// header. It sits one step *above* the window, so the chrome reads as a
  /// frame and the thread as the room inside it.
  static const surface = Color(0xff181824);
  static const raised = Color(0xff1f202e);
  static const muted = Color(0xffa0a2b6);

  /// A third rung below [muted], where a timestamp or a run's age goes. On
  /// paper it would fall under the contrast floor, so the light theme reads
  /// those in [inkMuted] instead and only the dark theme has three rungs.
  static const subtle = Color(0xff7f8297);

  /// A cool near-white, so the only warm note on ink is the accent.
  static const text = Color(0xfff1f1f6);

  /// The light theme's text: a cool near-black on the cool grey paper, the
  /// dark theme's greys turned over.
  static const ink = Color(0xff15151e);
  static const inkMuted = Color(0xff5c5f70);

  static const fast = Duration(milliseconds: 140);
  static const enter = Duration(milliseconds: 260);

  /// The radii, in one place: a list row, a control, a message, a card, the
  /// composer's field, a sheet, and a pill.
  static const radiusRow = 10.0;
  static const radiusControl = 12.0;
  static const radiusBubble = 14.0;
  static const radiusCard = 16.0;
  static const radiusField = 22.0;
  static const radiusSheet = 24.0;
  static const radiusPill = 999.0;

  /// The style a message is read in, the person's and the Bot's.
  static TextStyle message(ThemeData theme) => theme.textTheme.bodyLarge!
      .copyWith(fontWeight: FontWeight.w400, height: 1.55);

  /// Figures of one width, for a time or a count that should not shift as it
  /// changes. Only there: in Inter the feature widens a hyphen too.
  static const tabularFigures = [FontFeature.tabularFigures()];

  /// The weight of `**emphasis**` inside a message.
  static const FontWeight messageStrong = FontWeight.w600;

  static Duration motion(BuildContext context, [Duration duration = enter]) =>
      MediaQuery.disableAnimationsOf(context) ? Duration.zero : duration;

  /// A hairline: the line between two surfaces, drawn light enough that the
  /// eye reads a change of plane rather than a rule.
  static Color hairline(ColorScheme scheme) =>
      scheme.outlineVariant.withValues(alpha: 0.72);

  /// The accent where it is read as text: a link, a text button. A fill that
  /// carries white type is too dark to read on ink, so it steps toward the
  /// text colour until it clears 4.5:1 against the window. Paper's accent
  /// already does and comes back as it is.
  static Color readableAccent(ThemeSurfaces surfaces) {
    for (var step = 0; step <= 20; step++) {
      final colour = Color.lerp(surfaces.accent, surfaces.text, step / 20)!;
      if (_contrast(colour, surfaces.window) >= 4.5) return colour;
    }
    return surfaces.text;
  }

  static Color accentInk(ThemeData theme) =>
      theme.extension<FrockLook>()?.accentInk ?? theme.colorScheme.primary;

  static double _contrast(Color a, Color b) {
    final x = a.computeLuminance();
    final y = b.computeLuminance();
    return x > y ? (x + 0.05) / (y + 0.05) : (y + 0.05) / (x + 0.05);
  }

  static ThemeData theme(Brightness brightness) => fromDocument(
    brightness == Brightness.dark ? ThemeDocument.ink : ThemeDocument.paper,
  );

  static ThemeData fromDocument(
    ThemeDocument document, {
    DateTime? now,
    String timezone = 'UTC',
  }) {
    final tokens = resolveThemeTokens(
      document,
      now: now ?? DateTime.now(),
      timezone: timezone,
    );
    return fromTokens(tokens);
  }

  static ThemeData fromTokens(ThemeTokens tokens) {
    final surfaces = tokens.surfaces;
    final dark = surfaces.window.computeLuminance() < 0.5;
    final brightness = dark ? Brightness.dark : Brightness.light;
    final fontFamily = tokens.type == ThemeTypeface.manrope
        ? 'Manrope'
        : 'Inter';
    final scheme =
        ColorScheme(
          brightness: brightness,
          primary: surfaces.accent,
          onPrimary: surfaces.onAccent,
          secondary: surfaces.accent,
          onSecondary: surfaces.onAccent,
          // The dark red reads on ink; paper needs a deeper one to carry text.
          error: dark ? const Color(0xffe05a5a) : const Color(0xffc73a28),
          onError: Colors.white,
          surface: surfaces.surface,
          onSurface: surfaces.text,
        ).copyWith(
          onSurfaceVariant: surfaces.muted,
          surfaceContainerLow: surfaces.surface,
          surfaceContainerHigh: surfaces.raised,
          surfaceContainerHighest: surfaces.raised,
          // A line with some weight: a quote's bar, a Plugin page's strong
          // border. The hairline is outlineVariant.
          outline: Color.lerp(surfaces.line, surfaces.muted, 0.5),
          outlineVariant: surfaces.line,
        );
    final base = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      fontFamily: fontFamily,
      extensions: [FrockLook.fromTokens(tokens)],
    );
    final type = base.textTheme.apply(fontFamily: fontFamily);
    final control = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(radiusControl),
    );
    final hair = hairline(scheme);
    final cardColor = dark ? surfaces.raised : surfaces.surface;
    final textTheme = type.copyWith(
      displaySmall: type.displaySmall?.copyWith(
        fontFamily: 'Archivo Black',
        fontSize: 28,
        height: 1.15,
        letterSpacing: -0.6,
      ),
      headlineMedium: type.headlineMedium?.copyWith(
        fontSize: 21,
        fontWeight: FontWeight.w600,
        height: 1.25,
        letterSpacing: -0.4,
      ),
      headlineSmall: type.headlineSmall?.copyWith(
        fontSize: 18,
        fontWeight: FontWeight.w600,
        height: 1.3,
        letterSpacing: -0.3,
      ),
      titleLarge: type.titleLarge?.copyWith(
        fontSize: 17,
        fontWeight: FontWeight.w600,
        height: 1.3,
        letterSpacing: -0.3,
      ),
      titleMedium: type.titleMedium?.copyWith(
        fontSize: 14.5,
        fontWeight: FontWeight.w600,
        height: 1.35,
        letterSpacing: -0.15,
      ),
      titleSmall: type.titleSmall?.copyWith(
        fontSize: 13.5,
        fontWeight: FontWeight.w500,
        height: 1.35,
        letterSpacing: -0.1,
      ),
      bodyLarge: type.bodyLarge?.copyWith(
        fontSize: 14,
        fontWeight: FontWeight.w400,
        height: 1.55,
        letterSpacing: 0,
      ),
      bodyMedium: type.bodyMedium?.copyWith(
        fontSize: 13.5,
        fontWeight: FontWeight.w400,
        height: 1.45,
        letterSpacing: -0.05,
      ),
      bodySmall: type.bodySmall?.copyWith(
        fontSize: 12,
        fontWeight: FontWeight.w400,
        height: 1.4,
        letterSpacing: 0,
        color: dark ? subtle : scheme.onSurfaceVariant,
      ),
      labelLarge: type.labelLarge?.copyWith(
        fontSize: 13.5,
        fontWeight: FontWeight.w500,
        height: 1.2,
        letterSpacing: -0.05,
      ),
      labelMedium: type.labelMedium?.copyWith(
        fontSize: 12.5,
        fontWeight: FontWeight.w500,
        height: 1.2,
        letterSpacing: 0,
      ),
      labelSmall: type.labelSmall?.copyWith(
        fontSize: 11,
        fontWeight: FontWeight.w600,
        height: 1.2,
        letterSpacing: 0.5,
      ),
    );
    return base.copyWith(
      textTheme: textTheme,
      scaffoldBackgroundColor: surfaces.window,
      canvasColor: surfaces.window,
      dividerColor: hair,
      splashFactory: InkSparkle.splashFactory,
      splashColor: scheme.onSurface.withValues(alpha: 0.05),
      highlightColor: scheme.onSurface.withValues(alpha: 0.04),
      hoverColor: scheme.onSurface.withValues(alpha: 0.04),
      focusColor: scheme.primary.withValues(alpha: 0.12),
      visualDensity: VisualDensity.standard,
      iconTheme: IconThemeData(color: scheme.onSurface, size: 22),
      cardTheme: CardThemeData(
        color: cardColor,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        elevation: 0,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusCard),
          side: BorderSide(color: hair),
        ),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        centerTitle: false,
        elevation: 0,
        scrolledUnderElevation: 0,
        titleSpacing: 4,
        toolbarHeight: 56,
        // The conversation's header band ends on a hairline; every other bar
        // ends on the same one.
        shape: Border(bottom: BorderSide(color: hair)),
        titleTextStyle: textTheme.titleLarge?.copyWith(
          fontSize: 16,
          color: scheme.onSurface,
        ),
        iconTheme: IconThemeData(color: scheme.onSurface, size: 22),
        actionsIconTheme: IconThemeData(color: scheme.onSurface, size: 22),
        systemOverlayStyle: dark
            ? SystemUiOverlayStyle.light
            : SystemUiOverlayStyle.dark,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style:
            FilledButton.styleFrom(
              minimumSize: const Size(48, 46),
              shape: control,
              elevation: 0,
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
              textStyle: textTheme.labelLarge?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ).copyWith(
              backgroundColor: WidgetStateProperty.resolveWith(
                (states) => states.contains(WidgetState.disabled)
                    ? scheme.onSurface.withValues(alpha: 0.08)
                    : null,
              ),
            ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(48, 42),
          shape: control,
          foregroundColor: scheme.onSurface,
          side: BorderSide(color: scheme.outlineVariant),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          textStyle: textTheme.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(40, 40),
          foregroundColor: readableAccent(surfaces),
          shape: control,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          textStyle: textTheme.labelLarge,
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          iconSize: 22,
          foregroundColor: scheme.onSurface,
          shape: control,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: dark
            ? Color.alphaBlend(
                Colors.white.withValues(alpha: 0.025),
                surfaces.surface,
              )
            : surfaces.surface,
        isDense: true,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          borderSide: BorderSide(color: scheme.primary, width: 1.5),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          borderSide: BorderSide(color: scheme.error),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          borderSide: BorderSide(color: scheme.error, width: 1.5),
        ),
        disabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          borderSide: BorderSide(color: hair),
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 14,
        ),
        labelStyle: textTheme.bodyMedium?.copyWith(
          color: scheme.onSurfaceVariant,
        ),
        floatingLabelStyle: textTheme.labelMedium?.copyWith(
          color: scheme.onSurfaceVariant,
        ),
        helperStyle: textTheme.bodySmall?.copyWith(
          color: scheme.onSurfaceVariant,
        ),
        hintStyle: textTheme.bodyMedium?.copyWith(
          color: scheme.onSurfaceVariant.withValues(alpha: 0.7),
        ),
        errorStyle: textTheme.bodySmall?.copyWith(color: scheme.error),
      ),
      dividerTheme: DividerThemeData(color: hair, thickness: 1, space: 1),
      listTileTheme: ListTileThemeData(
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusControl),
        ),
        // Selection is the accent at full strength: a wash of it over either
        // ground reads as mauve, not as the brand.
        selectedTileColor: scheme.primary,
        selectedColor: scheme.onPrimary,
        iconColor: scheme.onSurfaceVariant,
        textColor: scheme.onSurface,
        minVerticalPadding: 10,
        horizontalTitleGap: 12,
        minLeadingWidth: 24,
        titleTextStyle: textTheme.bodyMedium?.copyWith(
          fontSize: 14,
          fontWeight: FontWeight.w500,
          letterSpacing: 0,
          color: scheme.onSurface,
        ),
        subtitleTextStyle: textTheme.bodySmall?.copyWith(
          fontSize: 12.5,
          color: scheme.onSurfaceVariant,
        ),
        leadingAndTrailingTextStyle: textTheme.bodySmall,
      ),
      switchTheme: SwitchThemeData(
        trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
        trackOutlineWidth: const WidgetStatePropertyAll(0),
        thumbColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.disabled)
              ? scheme.onSurface.withValues(alpha: 0.35)
              : Colors.white,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? scheme.primary.withValues(
                  alpha: states.contains(WidgetState.disabled) ? 0.4 : 1,
                )
              : scheme.onSurface.withValues(alpha: dark ? 0.18 : 0.14),
        ),
      ),
      // The same control as FrockSegmented: the chosen segment is the accent
      // at full strength, the rest are words on the ground.
      segmentedButtonTheme: SegmentedButtonThemeData(
        style: ButtonStyle(
          visualDensity: VisualDensity.compact,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(radiusControl),
            ),
          ),
          side: WidgetStatePropertyAll(BorderSide(color: hair)),
          backgroundColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.selected)
                ? scheme.primary
                : Colors.transparent,
          ),
          foregroundColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.selected)
                ? scheme.onPrimary
                : scheme.onSurfaceVariant,
          ),
          textStyle: WidgetStatePropertyAll(
            textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w600),
          ),
        ),
      ),
      checkboxTheme: CheckboxThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(5)),
        side: BorderSide(color: scheme.onSurfaceVariant, width: 1.5),
      ),
      radioTheme: RadioThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? scheme.primary
              : scheme.onSurfaceVariant,
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: cardColor,
        selectedColor: scheme.primary,
        side: BorderSide(color: hair),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
        labelStyle: textTheme.labelMedium?.copyWith(color: scheme.onSurface),
        secondaryLabelStyle: textTheme.labelMedium?.copyWith(
          color: scheme.onPrimary,
        ),
        labelPadding: const EdgeInsets.symmetric(horizontal: 4),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        iconTheme: IconThemeData(size: 16, color: scheme.onSurfaceVariant),
        deleteIconColor: scheme.onSurfaceVariant,
        showCheckmark: false,
      ),
      badgeTheme: BadgeThemeData(
        backgroundColor: scheme.primary,
        textColor: scheme.onPrimary,
        textStyle: TextStyle(
          fontFamily: fontFamily,
          fontSize: 10.5,
          fontWeight: FontWeight.w600,
          height: 1,
        ),
        padding: const EdgeInsets.symmetric(horizontal: 6),
        largeSize: 18,
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: dark ? const Color(0xff2c2d3e) : ink,
          borderRadius: BorderRadius.circular(8),
        ),
        textStyle: textTheme.labelMedium?.copyWith(color: Colors.white),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        waitDuration: const Duration(milliseconds: 500),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: dark ? const Color(0xff2c2d3e) : ink,
        contentTextStyle: textTheme.bodyMedium?.copyWith(color: Colors.white),
        actionTextColor: dark ? accentSoft : accentSoft,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusControl),
        ),
        insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: cardColor,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: BorderSide(color: hair),
        ),
        titleTextStyle: textTheme.titleLarge?.copyWith(color: scheme.onSurface),
        contentTextStyle: textTheme.bodyMedium?.copyWith(
          color: scheme.onSurfaceVariant,
        ),
        actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: dark ? surfaces.raised : surfaces.surface,
        modalBackgroundColor: dark ? surfaces.raised : surfaces.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        modalElevation: 0,
        showDragHandle: true,
        dragHandleColor: scheme.onSurface.withValues(alpha: 0.18),
        dragHandleSize: const Size(36, 4),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(radiusSheet),
          ),
        ),
        clipBehavior: Clip.antiAlias,
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: dark ? surfaces.raised : surfaces.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          side: BorderSide(color: hair),
        ),
        textStyle: textTheme.bodyMedium,
      ),
      dropdownMenuTheme: DropdownMenuThemeData(
        menuStyle: MenuStyle(
          backgroundColor: WidgetStatePropertyAll(
            dark ? surfaces.raised : surfaces.surface,
          ),
          surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
          elevation: const WidgetStatePropertyAll(0),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(radiusControl),
              side: BorderSide(color: hair),
            ),
          ),
        ),
      ),
      menuTheme: MenuThemeData(
        style: MenuStyle(
          backgroundColor: WidgetStatePropertyAll(
            dark ? surfaces.raised : surfaces.surface,
          ),
          surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
          elevation: const WidgetStatePropertyAll(0),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(radiusControl),
              side: BorderSide(color: hair),
            ),
          ),
        ),
      ),
      expansionTileTheme: ExpansionTileThemeData(
        shape: const Border(),
        collapsedShape: const Border(),
        iconColor: scheme.onSurfaceVariant,
        collapsedIconColor: scheme.onSurfaceVariant,
        textColor: scheme.onSurface,
        collapsedTextColor: scheme.onSurface,
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: scheme.primary,
        linearTrackColor: scheme.onSurface.withValues(alpha: 0.08),
        circularTrackColor: Colors.transparent,
        linearMinHeight: 3,
      ),
      scrollbarTheme: ScrollbarThemeData(
        thickness: const WidgetStatePropertyAll(4),
        radius: const Radius.circular(4),
        thumbColor: WidgetStatePropertyAll(
          scheme.onSurface.withValues(alpha: 0.18),
        ),
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: scheme.primary,
        selectionColor: scheme.primary.withValues(alpha: 0.3),
        selectionHandleColor: scheme.primary,
      ),
      bannerTheme: MaterialBannerThemeData(
        backgroundColor: surfaces.raised,
        surfaceTintColor: Colors.transparent,
        dividerColor: hair,
        contentTextStyle: textTheme.bodyMedium?.copyWith(
          color: scheme.onSurface,
        ),
        padding: const EdgeInsets.fromLTRB(16, 10, 8, 4),
        elevation: 0,
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: scheme.surface,
        indicatorColor: scheme.primary,
      ),
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
          TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        },
      ),
    );
  }
}

/// Token treatments the Material scheme has no slot for: bubble fill, typeface.
class FrockLook extends ThemeExtension<FrockLook> {
  final ThemeTokens tokens;
  const FrockLook(this.tokens);

  factory FrockLook.fromTokens(ThemeTokens tokens) => FrockLook(tokens);

  ThemeSurfaces get surfaces => tokens.surfaces;

  Color get accentInk => FrockTheme.readableAccent(tokens.surfaces);

  bool get _dark => tokens.surfaces.window.computeLuminance() < 0.5;

  /// The person's bubble is either the accent itself or a grey a step lighter
  /// than the Bot's. Never the accent at low alpha: over either ground that
  /// reads as mauve, not as the brand.
  Color bubbleFill({required bool mine}) {
    final surfaces = tokens.surfaces;
    if (mine) {
      return tokens.meBubble == MeBubble.accent
          ? surfaces.accent
          : Color.lerp(surfaces.raised, surfaces.text, _dark ? 0.16 : 0.07)!;
    }
    return tokens.botBubble == BotBubble.raised
        ? surfaces.raised
        : surfaces.surface;
  }

  /// The Bot's bubble keeps a hairline so it holds its shape on a ground only
  /// a step darker; the person's is solid enough not to need one.
  Color? bubbleLine({required bool mine}) => mine ? null : tokens.surfaces.line;

  Color bubbleInk({required bool mine}) =>
      mine && tokens.meBubble == MeBubble.accent
      ? tokens.surfaces.onAccent
      : tokens.surfaces.text;

  @override
  FrockLook copyWith({ThemeTokens? tokens}) => FrockLook(tokens ?? this.tokens);

  @override
  FrockLook lerp(ThemeExtension<FrockLook>? other, double t) {
    if (other is! FrockLook) return this;
    return t < 0.5 ? this : other;
  }
}

/// Finite, quiet placeholders: no idle animation or accessibility chatter.
class FrockSkeleton extends StatelessWidget {
  final double width;
  final double height;
  const FrockSkeleton({
    super.key,
    this.width = double.infinity,
    this.height = 16,
  });
  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(8),
      ),
    ),
  );
}
