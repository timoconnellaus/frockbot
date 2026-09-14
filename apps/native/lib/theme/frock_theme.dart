import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/services.dart';

/// The reviewed web theme's semantic colors, radii, typefaces and motion.
/// Native text/touch sizes follow platform accessibility instead of CSS pixels.
///
/// The palette is the product's and does not move. What this file decides is
/// everything Material would otherwise decide for us — the proportions, the
/// radii, the weight of a line — so that a stock widget dropped anywhere in
/// the app already looks like it belongs here.
abstract final class FrockTheme {
  static const accent = Color(0xffec386b);

  /// The pale pink secondary actions are written in. The voice footer's
  /// lobes use it as the tint between white and the accent.
  static const accentSoft = Color(0xfff59ab6);

  /// The deep rose the Bot speaks in on the voice footer's pink slab: the
  /// same hue as [accent], darker, so the two voices are one family told
  /// apart by weight rather than by a second colour.
  static const accentDeep = Color(0xff9c1a44);
  static const window = Color(0xff1f1e24);
  static const surface = Color(0xff211f26);
  static const raised = Color(0xff2c2a33);
  static const border = Color(0xff3a3742);
  static const muted = Color(0xffaaa6b1);
  static const text = Color(0xfff4f2f6);
  static const fast = Duration(milliseconds: 140);
  static const enter = Duration(milliseconds: 260);

  /// The radii, in one place: a control, a card, a sheet.
  static const radiusControl = 12.0;
  static const radiusCard = 16.0;
  static const radiusSheet = 24.0;

  static Duration motion(BuildContext context, [Duration duration = enter]) =>
      MediaQuery.disableAnimationsOf(context) ? Duration.zero : duration;

  /// A hairline: the line between two surfaces, drawn light enough that the
  /// eye reads a change of plane rather than a rule.
  static Color hairline(ColorScheme scheme) =>
      scheme.outlineVariant.withValues(alpha: 0.72);

  static ThemeData theme(Brightness brightness) {
    final dark = brightness == Brightness.dark;
    final scheme =
        ColorScheme.fromSeed(
          seedColor: accent,
          brightness: brightness,
        ).copyWith(
          primary: dark ? accent : const Color(0xffbd1e50),
          onPrimary: Colors.white,
          surface: dark ? surface : const Color(0xfffaf8fb),
          onSurface: dark ? text : window,
          onSurfaceVariant: dark ? muted : const Color(0xff625c6b),
          surfaceContainerHighest: dark ? raised : const Color(0xffefebf1),
          outlineVariant: dark ? border : const Color(0xffdfd9e3),
        );
    final base = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      fontFamily: 'Inter',
    );
    // Inter, at the weights a desktop tool uses: regular for reading, medium
    // for a name, semibold for a title. Nothing heavier — the accent colour
    // is what carries emphasis here, not the ink.
    final type = base.textTheme.apply(fontFamily: 'Inter');
    final control = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(radiusControl),
    );
    final hair = hairline(scheme);
    final cardColor = dark ? raised : Colors.white;
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
        fontSize: 15,
        fontWeight: FontWeight.w400,
        height: 1.5,
        letterSpacing: -0.1,
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
        color: scheme.onSurfaceVariant,
        fontFeatures: [const FontFeature.tabularFigures()],
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
      scaffoldBackgroundColor: dark ? window : const Color(0xfffaf8fb),
      canvasColor: dark ? surface : const Color(0xfffaf8fb),
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
            ? Color.alphaBlend(Colors.white.withValues(alpha: 0.025), surface)
            : Colors.white,
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
        selectedTileColor: scheme.primary.withValues(alpha: 0.1),
        selectedColor: scheme.onSurface,
        iconColor: scheme.onSurfaceVariant,
        textColor: scheme.onSurface,
        minVerticalPadding: 10,
        horizontalTitleGap: 12,
        minLeadingWidth: 24,
        titleTextStyle: textTheme.bodyMedium?.copyWith(
          fontSize: 14,
          fontWeight: FontWeight.w500,
          letterSpacing: -0.1,
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
        selectedColor: scheme.primary.withValues(alpha: 0.16),
        side: BorderSide(color: hair),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
        labelStyle: textTheme.labelMedium?.copyWith(color: scheme.onSurface),
        labelPadding: const EdgeInsets.symmetric(horizontal: 4),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        iconTheme: IconThemeData(size: 16, color: scheme.onSurfaceVariant),
        deleteIconColor: scheme.onSurfaceVariant,
        showCheckmark: false,
      ),
      badgeTheme: BadgeThemeData(
        backgroundColor: scheme.primary,
        textColor: scheme.onPrimary,
        textStyle: const TextStyle(
          fontFamily: 'Inter',
          fontSize: 10.5,
          fontWeight: FontWeight.w600,
          height: 1,
        ),
        padding: const EdgeInsets.symmetric(horizontal: 6),
        largeSize: 18,
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: dark ? const Color(0xff3a3742) : window,
          borderRadius: BorderRadius.circular(8),
        ),
        textStyle: textTheme.labelMedium?.copyWith(color: Colors.white),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        waitDuration: const Duration(milliseconds: 500),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: dark ? const Color(0xff36333e) : window,
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
        backgroundColor: dark ? raised : Colors.white,
        modalBackgroundColor: dark ? raised : Colors.white,
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
        color: dark ? raised : Colors.white,
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
          backgroundColor: WidgetStatePropertyAll(dark ? raised : Colors.white),
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
          backgroundColor: WidgetStatePropertyAll(dark ? raised : Colors.white),
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
        backgroundColor: dark ? raised : const Color(0xffefebf1),
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
        indicatorColor: scheme.primary.withValues(alpha: 0.14),
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
